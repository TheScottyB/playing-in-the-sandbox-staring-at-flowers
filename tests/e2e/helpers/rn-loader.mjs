import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REPO_ROOT } from "./repo.mjs";

register(new URL("./rn-loader-hook.mjs", import.meta.url));

let runCounter = 0;

function normalizeParams(params) {
	if (params === undefined || params === null) return [];
	return Array.isArray(params) ? params : [params];
}

function createSqliteAdapter(dbFilePath, options = {}) {
	const db = new DatabaseSync(dbFilePath);
	const sqliteVecVersion = options.sqliteVecVersion ?? null;

	function normalizeSqlParams(args) {
		if (args.length === 0) return [];
		if (args.length === 1) return normalizeParams(args[0]);
		return args;
	}

	const adapter = {
		_raw: db,
		execSync(sql) {
			if (
				!sqliteVecVersion &&
				/CREATE\s+VIRTUAL\s+TABLE\s+IF\s+NOT\s+EXISTS\s+vec_species/i.test(sql)
			) {
				return;
			}
			db.exec(sql);
		},
		runSync(sql, ...args) {
			const stmt = db.prepare(sql);
			return stmt.run(...normalizeSqlParams(args));
		},
		getFirstSync(sql, ...args) {
			if (/SELECT\s+vec_version\(\)/i.test(sql)) {
				if (sqliteVecVersion) {
					return { version: sqliteVecVersion };
				}
				throw new Error("no such function: vec_version");
			}
			const stmt = db.prepare(sql);
			const row = stmt.get(...normalizeSqlParams(args));
			return row === undefined ? null : row;
		},
		getAllSync(sql, ...args) {
			const stmt = db.prepare(sql);
			return stmt.all(...normalizeSqlParams(args));
		},
		closeSync() {
			db.close();
		},
		async execAsync(sql) {
			return adapter.execSync(sql);
		},
		async runAsync(sql, ...args) {
			return adapter.runSync(sql, ...args);
		},
		async getFirstAsync(sql, ...args) {
			return adapter.getFirstSync(sql, ...args);
		},
		async getAllAsync(sql, ...args) {
			return adapter.getAllSync(sql, ...args);
		},
		async withTransactionAsync(fn) {
			db.exec("BEGIN;");
			try {
				await fn();
				db.exec("COMMIT;");
			} catch (err) {
				db.exec("ROLLBACK;");
				throw err;
			}
		},
		async closeAsync() {
			return adapter.closeSync();
		},
	};
	return adapter;
}

globalThis.__e2eRequire = (id, parentUrl) => {
	if (id === "react-native-purchases") {
		const target = globalThis.__E2E_MOCKS__?.purchases;
		return {
			default: new Proxy(
				{},
				{
					get(_t, prop) {
						const val = target?.[prop];
						return typeof val === "function" ? val.bind(target) : val;
					},
				},
			),
		};
	}
	if (id.startsWith("./") || id.startsWith("../")) {
		const cleanUrl = parentUrl.split("?")[0];
		const abs = resolve(dirname(fileURLToPath(cleanUrl)), id);
		return abs;
	}
	return id;
};

export function createE2EContext(options = {}) {
	if (globalThis.__E2E_MOCKS__ !== undefined) {
		throw new Error(
			"createE2EContext re-entrancy error: an active E2E context is already mounted on globalThis.__E2E_MOCKS__. Call cleanup() before creating another context.",
		);
	}

	runCounter += 1;
	const runId = runCounter;
	const sandboxDir = join(tmpdir(), `flowers-rn-e2e-${process.pid}-${runId}`);
	mkdirSync(sandboxDir, { recursive: true });

	const defaultDocDir = `${sandboxDir}/docs/`;
	mkdirSync(defaultDocDir, { recursive: true });

	const prevDev = globalThis.__DEV__;
	const prevFetch = globalThis.fetch;
	const prevMocks = globalThis.__E2E_MOCKS__;
	const savedEnv = {};
	for (const [k, v] of Object.entries(options.env ?? {})) {
		savedEnv[k] = k in process.env ? process.env[k] : undefined;
		if (v === undefined || v === null) {
			delete process.env[k];
		} else {
			process.env[k] = String(v);
		}
	}
	for (const k of options.unsetEnv ?? []) {
		if (!(k in savedEnv)) {
			savedEnv[k] = k in process.env ? process.env[k] : undefined;
		}
		delete process.env[k];
	}

	globalThis.__DEV__ = options.dev ?? false;

	const asyncStorage = new Map(Object.entries(options.initialStorage ?? {}));
	const openedDbs = [];
	const fetchCalls = [];
	const alerts = [];
	const appStateListeners = [];

	const fsCounters = {
		getInfoCalls: 0,
		makeDirCalls: 0,
		copyCalls: 0,
		readCalls: 0,
		writeCalls: 0,
	};

	const docDirSetting =
		"documentDirectory" in options ? options.documentDirectory : defaultDocDir;

	const tmpRoots = Array.from(
		new Set([resolve(tmpdir()), realpathSync(tmpdir())]),
	);
	const repoRoots = Array.from(
		new Set([resolve(REPO_ROOT), realpathSync(REPO_ROOT)]),
	);
	function isWithinRoot(candidate, root) {
		const prefix = root.endsWith("/") ? root : `${root}/`;
		return candidate === root || candidate.startsWith(prefix);
	}
	function resolveRealPath(targetPath, depth = 0) {
		if (depth > 40) {
			throw new Error(
				`E2E fsMock blocked excessive symlink depth: ${targetPath}`,
			);
		}
		let cur = resolve(targetPath);
		const trailingSegments = [];
		while (true) {
			let stat;
			try {
				stat = lstatSync(cur);
			} catch (err) {
				if (err?.code === "ENOENT" || err?.code === "ENOTDIR") {
					const parent = dirname(cur);
					if (parent === cur) {
						return cur;
					}
					trailingSegments.push(basename(cur));
					cur = parent;
					continue;
				}
				throw err;
			}

			let realBase;
			try {
				realBase = realpathSync(cur);
			} catch (err) {
				if (stat.isSymbolicLink() && err?.code === "ENOENT") {
					const linkTarget = readlinkSync(cur);
					const baseDir = isAbsolute(linkTarget)
						? "/"
						: realpathSync(dirname(cur));
					const nextTarget = resolve(baseDir, linkTarget);
					realBase = resolveRealPath(nextTarget, depth + 1);
				} else {
					throw err;
				}
			}

			return trailingSegments.length > 0
				? join(realBase, ...trailingSegments.reverse())
				: realBase;
		}
	}
	function assertSafeSandboxPath(targetPath) {
		if (typeof targetPath !== "string" || !isAbsolute(targetPath)) {
			throw new Error(
				`E2E fsMock blocked non-absolute path: ${String(targetPath)}`,
			);
		}
		const resolved = resolve(targetPath);
		let realCandidate;
		try {
			realCandidate = resolveRealPath(resolved);
		} catch (err) {
			throw new Error(
				`E2E fsMock blocked path outside os.tmpdir(): ${resolved}`,
				{ cause: err },
			);
		}
		if (tmpRoots.some((root) => isWithinRoot(realCandidate, root))) {
			return realCandidate;
		}
		throw new Error(`E2E fsMock blocked path outside os.tmpdir(): ${resolved}`);
	}
	function assertSafeCopySource(sourcePath) {
		if (typeof sourcePath !== "string" || !isAbsolute(sourcePath)) {
			throw new Error(
				`E2E fsMock blocked non-absolute copyAsync source: ${String(sourcePath)}`,
			);
		}
		const resolved = resolve(sourcePath);
		let realCandidate;
		try {
			realCandidate = resolveRealPath(resolved);
		} catch (err) {
			throw new Error(
				`E2E fsMock blocked copyAsync source outside os.tmpdir() and REPO_ROOT: ${resolved}`,
				{ cause: err },
			);
		}
		if (
			tmpRoots.some((root) => isWithinRoot(realCandidate, root)) ||
			repoRoots.some((root) => isWithinRoot(realCandidate, root))
		) {
			return realCandidate;
		}
		throw new Error(
			`E2E fsMock blocked copyAsync source outside os.tmpdir() and REPO_ROOT: ${resolved}`,
		);
	}

	const fsMock = {
		documentDirectory: docDirSetting,
		counters: fsCounters,
		async getInfoAsync(targetPath) {
			const safePath = assertSafeSandboxPath(targetPath);
			fsCounters.getInfoCalls += 1;
			if (options.onGetInfoAsync) {
				return options.onGetInfoAsync(safePath);
			}
			return { exists: existsSync(safePath) };
		},
		async makeDirectoryAsync(targetPath, opts) {
			const safePath = assertSafeSandboxPath(targetPath);
			fsCounters.makeDirCalls += 1;
			mkdirSync(safePath, { recursive: opts?.intermediates ?? true });
		},
		async copyAsync({ from, to } = {}) {
			const safeFrom = assertSafeCopySource(from);
			const safeTo = assertSafeSandboxPath(to);
			fsCounters.copyCalls += 1;
			if (options.onCopyAsync) {
				return options.onCopyAsync({ from: safeFrom, to: safeTo });
			}
			mkdirSync(dirname(safeTo), { recursive: true });
			copyFileSync(safeFrom, safeTo);
		},
		async readAsStringAsync(targetPath) {
			const safePath = assertSafeSandboxPath(targetPath);
			fsCounters.readCalls += 1;
			return readFileSync(safePath, "utf8");
		},
		async writeAsStringAsync(targetPath, content) {
			const safePath = assertSafeSandboxPath(targetPath);
			fsCounters.writeCalls += 1;
			mkdirSync(dirname(safePath), { recursive: true });
			writeFileSync(safePath, content, "utf8");
		},
		async deleteAsync(targetPath) {
			const safePath = assertSafeSandboxPath(targetPath);
			if (existsSync(safePath)) {
				unlinkSync(safePath);
			}
		},
	};

	const assetCounters = { downloadCalls: 0 };
	function assetFromModule(mod) {
		const resolved =
			typeof mod === "string" && existsSync(mod)
				? mod
				: join(REPO_ROOT, "assets", "species.db");
		return {
			localUri: resolved,
			async downloadAsync() {
				assetCounters.downloadCalls += 1;
				if (options.assetDownloadError) {
					throw options.assetDownloadError;
				}
			},
		};
	}

	const listeners = new Set();
	const purchasesState = {
		configureCalls: 0,
		configureArgs: [],
		getOfferingsCalls: 0,
		purchaseCalls: 0,
		restoreCalls: 0,
		getCustomerInfoCalls: 0,
		addListenerCalls: 0,
		removeListenerCalls: 0,
		activeEntitlements: options.initialEntitlements ?? {},
		offerings: options.offerings ?? {
			current: {
				availablePackages: [
					{
						identifier: "$rc_monthly",
						packageType: "MONTHLY",
						product: {
							title: "Premium Monthly Pass",
							description: "Monthly pass",
							priceString: "$4.99",
							price: 4.99,
						},
					},
					{
						identifier: "$rc_yearly",
						packageType: "ANNUAL",
						product: {
							title: "Premium Annual Pass",
							description: "Annual pass",
							priceString: "$29.99",
							price: 29.99,
						},
					},
					{
						identifier: "$rc_lifetime",
						packageType: "LIFETIME",
						product: {
							title: "Founders Edition (Lifetime VIP)",
							description: "Lifetime access",
							priceString: "$99.99",
							price: 99.99,
						},
					},
				],
			},
		},
		configureError: options.configureError ?? null,
		configureDelayMs: options.configureDelayMs ?? 0,
		userCancelledNextPurchase: false,
		purchaseError: null,
		async configure(cfg) {
			purchasesState.configureCalls += 1;
			purchasesState.configureArgs.push(cfg);
			if (purchasesState.configureDelayMs > 0) {
				await new Promise((r) =>
					setTimeout(r, purchasesState.configureDelayMs),
				);
			}
			if (purchasesState.configureError) {
				throw purchasesState.configureError;
			}
		},
		async getOfferings() {
			purchasesState.getOfferingsCalls += 1;
			if (options.onGetOfferings) return options.onGetOfferings();
			return purchasesState.offerings;
		},
		async purchasePackage(pkg) {
			purchasesState.purchaseCalls += 1;
			if (purchasesState.userCancelledNextPurchase) {
				const err = new Error("User cancelled");
				err.userCancelled = true;
				throw err;
			}
			if (purchasesState.purchaseError) {
				throw purchasesState.purchaseError;
			}
			if (Object.keys(purchasesState.activeEntitlements).length === 0) {
				purchasesState.activeEntitlements = { premium: { isActive: true } };
			}
			const info = {
				entitlements: { active: purchasesState.activeEntitlements },
				purchasedIdentifier: pkg.identifier,
			};
			purchasesState.emitCustomerInfo(info);
			return { customerInfo: info };
		},
		async restorePurchases() {
			purchasesState.restoreCalls += 1;
			const info = {
				entitlements: { active: purchasesState.activeEntitlements },
			};
			return info;
		},
		async getCustomerInfo() {
			purchasesState.getCustomerInfoCalls += 1;
			return {
				entitlements: { active: purchasesState.activeEntitlements },
			};
		},
		addCustomerInfoUpdateListener(cb) {
			purchasesState.addListenerCalls += 1;
			listeners.add(cb);
		},
		removeCustomerInfoUpdateListener(cb) {
			purchasesState.removeListenerCalls += 1;
			return listeners.delete(cb);
		},
		emitCustomerInfo(info) {
			if (info?.entitlements?.active) {
				purchasesState.activeEntitlements = info.entitlements.active;
			}
			for (const cb of listeners) {
				cb(info);
			}
		},
		get listenerCount() {
			return listeners.size;
		},
	};

	const locationState = {
		permissionStatus: options.locationPermission ?? "granted",
		coords: options.locationCoords ?? {
			latitude: 37.7749,
			longitude: -122.4194,
		},
		places: options.locationPlaces ?? [
			{ isoCountryCode: "US", region: "California" },
		],
		async getForegroundPermissionsAsync() {
			return { status: locationState.permissionStatus };
		},
		async requestForegroundPermissionsAsync() {
			return { status: locationState.permissionStatus };
		},
		async getCurrentPositionAsync() {
			return { coords: locationState.coords };
		},
		async reverseGeocodeAsync() {
			return locationState.places;
		},
	};

	function openSqlite(name) {
		if (name === ":memory:") {
			const adapter = createSqliteAdapter(":memory:", {
				sqliteVecVersion: options.sqliteVecVersion ?? null,
			});
			openedDbs.push(adapter);
			return adapter;
		}
		if (typeof name !== "string" || name.length === 0 || isAbsolute(name)) {
			throw new Error(
				`E2E openSqlite blocked invalid database name: ${String(name)}`,
			);
		}
		const baseDir = docDirSetting ? `${docDirSetting}SQLite` : sandboxDir;
		const safeBaseDir = assertSafeSandboxPath(baseDir);
		const fullPath = assertSafeSandboxPath(join(baseDir, name));
		if (!isWithinRoot(fullPath, safeBaseDir) || fullPath === safeBaseDir) {
			throw new Error(
				`E2E openSqlite blocked path outside SQLite directory: ${name}`,
			);
		}
		mkdirSync(dirname(fullPath), { recursive: true });
		if (!existsSync(fullPath) && options.seedRealSpeciesDb) {
			copyFileSync(join(REPO_ROOT, "assets", "species.db"), fullPath);
		}
		const adapter = createSqliteAdapter(fullPath, {
			sqliteVecVersion: options.sqliteVecVersion ?? null,
		});
		openedDbs.push(adapter);
		return adapter;
	}

	globalThis.__E2E_MOCKS__ = {
		platform: { OS: options.platform ?? "ios" },
		asyncStorage,
		fs: fsMock,
		assetFromModule,
		assetCounters,
		purchases: purchasesState,
		location: locationState,
		alerts,
		appStateListeners,
		openSqlite,
	};

	globalThis.fetch = async (url, init) => {
		fetchCalls.push({ url: String(url), init });
		if (options.fetchImpl) {
			return options.fetchImpl(String(url), init);
		}
		return new Response("Not Found", { status: 404 });
	};

	return {
		runId,
		sandboxDir,
		asyncStorage,
		fs: fsMock,
		assetCounters,
		purchases: purchasesState,
		location: locationState,
		fetchCalls,
		alerts,
		appStateListeners,
		async importFresh(relPath) {
			const url = pathToFileURL(join(REPO_ROOT, relPath));
			url.searchParams.set("run", String(runId));
			return import(url.href);
		},
		cleanup() {
			for (const db of openedDbs) {
				try {
					db.closeSync();
				} catch {
					// already closed
				}
			}
			if (prevDev === undefined) {
				delete globalThis.__DEV__;
			} else {
				globalThis.__DEV__ = prevDev;
			}
			globalThis.fetch = prevFetch;
			if (prevMocks === undefined) {
				delete globalThis.__E2E_MOCKS__;
			} else {
				globalThis.__E2E_MOCKS__ = prevMocks;
			}
			for (const [k, oldVal] of Object.entries(savedEnv)) {
				if (oldVal === undefined) {
					delete process.env[k];
				} else {
					process.env[k] = oldVal;
				}
			}
			rmSync(sandboxDir, { recursive: true, force: true });
		},
	};
}
