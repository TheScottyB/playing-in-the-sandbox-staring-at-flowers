import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { dirname, extname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	DB_VERSION as COMPILE_DB_VERSION,
	EMBEDDING_DIM as COMPILE_EMBEDDING_DIM,
	fetchEmbedding,
	PermanentApiError,
	parseRetryAfterMs,
} from "../../scripts/compile_species_db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const ASSET_DB_PATH = join(ROOT, "assets", "species.db");

function seedDatabaseFromAsset(userVersion = 2) {
	const src = new DatabaseSync(ASSET_DB_PATH, { readOnly: true });
	const mem = new DatabaseSync(":memory:");
	try {
		mem.exec(`
			CREATE TABLE species (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				region TEXT NOT NULL,
				common TEXT NOT NULL,
				latin TEXT NOT NULL,
				bloom_months TEXT NOT NULL,
				blurb TEXT NOT NULL,
				embedding BLOB NOT NULL
			);
			CREATE INDEX idx_species_region ON species(region);
		`);
		const rows = src
			.prepare(
				"SELECT id, region, common, latin, bloom_months, blurb, embedding FROM species;",
			)
			.all();
		const insert = mem.prepare(
			"INSERT INTO species (id, region, common, latin, bloom_months, blurb, embedding) VALUES (?, ?, ?, ?, ?, ?, ?);",
		);
		mem.exec("BEGIN;");
		for (const row of rows) {
			insert.run(
				row.id,
				row.region,
				row.common,
				row.latin,
				row.bloom_months,
				row.blurb,
				row.embedding,
			);
		}
		mem.exec("COMMIT;");
		mem.exec(`
			CREATE VIRTUAL TABLE species_fts USING fts5(
				region,
				common,
				latin,
				blurb,
				content='species',
				content_rowid='id',
				tokenize='porter unicode61'
			);
			INSERT INTO species_fts(species_fts) VALUES('rebuild');
			PRAGMA user_version = ${Number(userVersion)};
		`);
	} finally {
		src.close();
	}
	return mem;
}

function createVirtualTestState(overrides = {}) {
	const files = new Set();
	const dbs = new Map();
	const corruptPaths = new Map();
	const storage = new Map();
	const deletedPaths = [];
	const openHandles = [];
	const ftsQueries = [];
	const stats = {
		copyCount: 0,
		downloadCount: 0,
		openCount: 0,
		fsCalls: 0,
		closedCorruptCount: 0,
	};

	const state = {
		platformOS: "ios",
		devMode: false,
		documentDirectory: "file:///sandbox/",
		assetLocalUri: "file:///bundle/species.db",
		failDownloadOnce: false,
		disableFts5: false,
		files,
		dbs,
		corruptPaths,
		storage,
		deletedPaths,
		openHandles,
		ftsQueries,
		stats,
		seedExistingDb(userVersion = 0, extraWalShm = false) {
			const dbPath = `${state.documentDirectory}SQLite/species.db`;
			files.add(`${state.documentDirectory}SQLite`);
			files.add(dbPath);
			dbs.set(dbPath, seedDatabaseFromAsset(userVersion));
			if (extraWalShm) {
				files.add(`${dbPath}-wal`);
				files.add(`${dbPath}-shm`);
			}
		},
		corruptExistingDb(mode = "pragma", extraWalShm = true) {
			const dbPath = `${state.documentDirectory}SQLite/species.db`;
			files.add(`${state.documentDirectory}SQLite`);
			files.add(dbPath);
			corruptPaths.set(dbPath, mode);
			if (extraWalShm) {
				files.add(`${dbPath}-wal`);
				files.add(`${dbPath}-shm`);
			}
		},
		...overrides,
	};

	return state;
}

const VIRTUAL_MODULES = {
	"expo-asset": `
		const state = globalThis.__m2TestState;
		export const Asset = {
			fromModule(mod) {
				return {
					localUri: null,
					async downloadAsync() {
						state.stats.downloadCount++;
						if (state.failDownloadOnce) {
							state.failDownloadOnce = false;
							throw new Error("Simulated asset download failure");
						}
						this.localUri = state.assetLocalUri;
						return this;
					},
				};
			},
		};
	`,
	"expo-file-system/legacy": `
		const state = globalThis.__m2TestState;
		export const documentDirectory = state.useFsGetterProxy
			? null
			: state.documentDirectory;
		export function getInfoAsync(path) {
			state.stats.fsCalls++;
			if (state.syncThrowGetInfoOnce) {
				state.syncThrowGetInfoOnce = false;
				throw new Error("Synchronous FileSystem.getInfoAsync failure");
			}
			return Promise.resolve({ exists: state.files.has(path) });
		}
		export async function makeDirectoryAsync(path) {
			state.stats.fsCalls++;
			state.files.add(path);
		}
		export async function copyAsync({ from, to }) {
			state.stats.fsCalls++;
			state.stats.copyCount++;
			if (!from) throw new Error("Missing copy source");
			state.corruptPaths.delete(to);
			state.files.add(to);
			state.dbs.set(to, globalThis.__m2SeedFromAsset(2));
		}
		export async function deleteAsync(path) {
			state.stats.fsCalls++;
			state.deletedPaths.push(path);
			state.corruptPaths.delete(path);
			state.files.delete(path);
			const existing = state.dbs.get(path);
			if (existing) {
				try { existing.close(); } catch {}
				state.dbs.delete(path);
			}
		}
		export default {
			get documentDirectory() {
				if (state.getDocumentDirectory) {
					return state.getDocumentDirectory();
				}
				return state.documentDirectory;
			},
			getInfoAsync,
			makeDirectoryAsync,
			copyAsync,
			deleteAsync,
		};
	`,
	"expo-sqlite": `
		const state = globalThis.__m2TestState;
		function wrapDb(rawDb, dbPath) {
			let closed = false;
			const handle = {
				databasePath: dbPath,
				async closeAsync() {
					if (!closed) {
						closed = true;
						rawDb.close();
					}
				},
				async execAsync(source) {
					if (state.disableFts5 && /USING\\s+fts5/i.test(source)) {
						throw new Error("no such module: fts5");
					}
					rawDb.exec(source);
				},
				async runAsync(source, params) {
					const stmt = rawDb.prepare(source);
					if (Array.isArray(params)) return stmt.run(...params);
					if (params !== undefined) return stmt.run(params);
					return stmt.run();
				},
				async getFirstAsync(source, params) {
					const stmt = rawDb.prepare(source);
					const row = Array.isArray(params)
						? stmt.get(...params)
						: params !== undefined
							? stmt.get(params)
							: stmt.get();
					return row ?? null;
				},
				async getAllAsync(source, params) {
					if (state.disableFts5 && /species_search_fts/i.test(source)) {
						throw new Error("no such table: species_search_fts");
					}
					if (/species_search_fts\\s+MATCH/i.test(source) && Array.isArray(params) && typeof params[0] === "string") {
						state.ftsQueries.push(params[0]);
					}
					const stmt = rawDb.prepare(source);
					if (Array.isArray(params)) return stmt.all(...params);
					if (params !== undefined) return stmt.all(params);
					return stmt.all();
				},
				async withTransactionAsync(task) {
					rawDb.exec("BEGIN;");
					try {
						await task();
						rawDb.exec("COMMIT;");
					} catch (e) {
						rawDb.exec("ROLLBACK;");
						throw e;
					}
				},
			};
			return handle;
		}
		export async function openDatabaseAsync(dbName) {
			state.stats.openCount++;
			const dbPath = state.documentDirectory + "SQLite/" + dbName;
			const corruptMode = state.corruptPaths.get(dbPath);
			if (corruptMode === "open") {
				throw new Error("file is not a database");
			}
			if (corruptMode === "pragma") {
				return {
					databasePath: dbPath,
					async closeAsync() {
						state.stats.closedCorruptCount++;
					},
					async getFirstAsync() {
						throw new Error("file is not a database");
					},
				};
			}
			let rawDb = state.dbs.get(dbPath);
			if (!rawDb) {
				rawDb = globalThis.__m2SeedFromAsset(2);
				state.dbs.set(dbPath, rawDb);
			}
			const handle = wrapDb(rawDb, dbPath);
			state.openHandles.push(handle);
			return handle;
		}
	`,
	"@react-native-async-storage/async-storage": `
		const state = globalThis.__m2TestState;
		const AsyncStorage = {
			async getItem(key) {
				return state.storage.get(key) ?? null;
			},
			async setItem(key, value) {
				state.storage.set(key, String(value));
			},
			async removeItem(key) {
				state.storage.delete(key);
			},
		};
		export default AsyncStorage;
	`,
	"react-native": `
		const state = globalThis.__m2TestState;
		export const Platform = {
			get OS() {
				return state.platformOS;
			},
		};
	`,
};

globalThis.__m2SeedFromAsset = seedDatabaseFromAsset;
globalThis.__m2TestState = createVirtualTestState();
globalThis.__DEV__ = false;
globalThis.require = (id) => id;

function resolveRepoImport(specifier, parentURL) {
	if (specifier.startsWith("@/data/")) {
		return resolve(ROOT, "lib", "data", specifier.slice("@/data/".length));
	}
	if (specifier.startsWith("@/")) {
		return resolve(ROOT, specifier.slice(2));
	}
	if (specifier.startsWith("./") || specifier.startsWith("../")) {
		const parentDir = parentURL ? dirname(fileURLToPath(parentURL)) : ROOT;
		return resolve(parentDir, specifier);
	}
	return null;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (Object.hasOwn(VIRTUAL_MODULES, specifier)) {
			return {
				shortCircuit: true,
				url: `mock://${specifier}?case=${caseCounter}`,
			};
		}
		const candidate = resolveRepoImport(specifier, context.parentURL);
		if (candidate) {
			const cleanCandidate = candidate.split("?")[0];
			const query = specifier.includes("?")
				? `?${specifier.split("?")[1]}`
				: "";
			const candidates = extname(cleanCandidate)
				? [cleanCandidate]
				: [
						`${cleanCandidate}.ts`,
						`${cleanCandidate}.tsx`,
						`${cleanCandidate}.json`,
					];
			for (const filePath of candidates) {
				try {
					readFileSync(filePath);
					return {
						shortCircuit: true,
						url: `${pathToFileURL(filePath).href}${query}`,
					};
				} catch {}
			}
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("mock://")) {
			const name = url.slice("mock://".length).split("?")[0];
			return {
				shortCircuit: true,
				format: "module",
				source: VIRTUAL_MODULES[name],
			};
		}
		const cleanUrl = url.split("?")[0];
		if (cleanUrl.endsWith(".ts") || cleanUrl.endsWith(".tsx")) {
			const filePath = fileURLToPath(cleanUrl);
			const source = readFileSync(filePath, "utf8");
			let stripped = stripTypeScriptTypes(source, { mode: "strip" });
			if (
				globalThis.__m2TestState?.useFsGetterProxy &&
				filePath.endsWith("speciesDb.ts")
			) {
				stripped = stripped.replace(
					'import * as FileSystem from "expo-file-system/legacy";',
					'import __m2FsProxy from "expo-file-system/legacy";\nconst FileSystem = __m2FsProxy;',
				);
			}
			return {
				shortCircuit: true,
				format: "module",
				source: stripped,
			};
		}
		if (cleanUrl.endsWith(".json")) {
			const filePath = fileURLToPath(cleanUrl);
			const jsonText = readFileSync(filePath, "utf8");
			return {
				shortCircuit: true,
				format: "module",
				source: `export default ${jsonText};`,
			};
		}
		return nextLoad(url, context);
	},
});

let caseCounter = 0;
async function loadFreshSpeciesDb(state, devMode = false) {
	caseCounter++;
	globalThis.__m2TestState = state;
	globalThis.__DEV__ = devMode;
	const url = `${pathToFileURL(join(ROOT, "lib", "speciesDb.ts")).href}?case=${caseCounter}`;
	return import(url);
}

test("1. Concurrent initSpeciesDb() / getDatabase() shares single init lock and recovers on failure", async () => {
	const state = createVirtualTestState({ devMode: false });
	const mod = await loadFreshSpeciesDb(state, false);

	const [h1, h2, h3] = await Promise.all([
		mod.initSpeciesDb(),
		mod.getDatabase(),
		mod.initSpeciesDb(),
	]);

	assert.ok(h1, "Expected non-null SQLite handle on iOS");
	assert.equal(h1, h2, "Parallel calls must resolve to same DB handle");
	assert.equal(h2, h3, "Parallel calls must resolve to same DB handle");
	assert.equal(state.stats.copyCount, 1, "Bundled DB must only be copied once");
	assert.equal(state.stats.openCount, 1, "Database must only be opened once");

	// Failure recovery: failed init clears dbInitPromise so subsequent call retries
	const failState = createVirtualTestState({
		devMode: false,
		failDownloadOnce: true,
	});
	const failMod = await loadFreshSpeciesDb(failState, false);

	await assert.rejects(
		() => failMod.initSpeciesDb(),
		/Simulated asset download failure/,
	);
	assert.equal(failState.stats.copyCount, 0);

	const recovered = await failMod.initSpeciesDb();
	assert.ok(recovered, "Retry after failed init must succeed");
	assert.equal(failState.stats.copyCount, 1);
});

test("2. Production DB upgrade versioning replaces stale DB/WAL/SHM and skips copy when current", async () => {
	// Stale DB with user_version = 0 and stale WAL/SHM files
	const staleState = createVirtualTestState({ devMode: false });
	staleState.seedExistingDb(0, true);
	staleState.storage.set("species_db_version", "1");

	const mod = await loadFreshSpeciesDb(staleState, false);
	const db = await mod.initSpeciesDb();
	assert.ok(db);

	const dbPath = `${staleState.documentDirectory}SQLite/species.db`;
	assert.equal(staleState.stats.copyCount, 1, "Stale DB must be replaced");
	assert.ok(staleState.deletedPaths.includes(dbPath));
	assert.ok(staleState.deletedPaths.includes(`${dbPath}-wal`));
	assert.ok(staleState.deletedPaths.includes(`${dbPath}-shm`));
	assert.equal(
		staleState.storage.get("species_db_version"),
		String(mod.DB_VERSION),
	);
	const ver = await db.getFirstAsync("PRAGMA user_version;");
	assert.equal(ver.user_version, mod.DB_VERSION);

	// Up-to-date DB in !__DEV__ must NOT re-copy
	const currentState = createVirtualTestState({ devMode: false });
	currentState.seedExistingDb(mod.DB_VERSION, false);
	currentState.storage.set("species_db_version", String(mod.DB_VERSION));

	const currentMod = await loadFreshSpeciesDb(currentState, false);
	const currentDb = await currentMod.initSpeciesDb();
	assert.ok(currentDb);
	assert.equal(
		currentState.stats.copyCount,
		0,
		"Current production DB must not re-copy",
	);

	// Corrupted on-disk DB with matching AsyncStorage DB_VERSION must self-heal by re-copying
	for (const corruptMode of ["pragma", "open"]) {
		const corruptState = createVirtualTestState({ devMode: false });
		corruptState.corruptExistingDb(corruptMode, true);
		corruptState.storage.set("species_db_version", String(mod.DB_VERSION));

		const corruptMod = await loadFreshSpeciesDb(corruptState, false);
		const healedDb = await corruptMod.initSpeciesDb();
		assert.ok(healedDb, `Corrupted DB (${corruptMode}) must recover`);
		assert.equal(
			corruptState.stats.copyCount,
			1,
			`Corrupted DB (${corruptMode}) must re-copy bundled asset`,
		);
		if (corruptMode === "pragma") {
			assert.equal(
				corruptState.stats.closedCorruptCount,
				1,
				"Corrupt handle must be closed before re-copy",
			);
		}
		const corruptDbPath = `${corruptState.documentDirectory}SQLite/species.db`;
		assert.ok(corruptState.deletedPaths.includes(corruptDbPath));
		assert.ok(corruptState.deletedPaths.includes(`${corruptDbPath}-wal`));
		assert.ok(corruptState.deletedPaths.includes(`${corruptDbPath}-shm`));
		assert.equal(await corruptMod.getSpeciesCount(), 396);
	}
});

test("3. Web and null documentDirectory fallbacks avoid FileSystem/SQLite and work in-memory", async () => {
	for (const scenario of [
		{ name: "web", platformOS: "web", documentDirectory: "file:///ignored/" },
		{ name: "null-docdir", platformOS: "ios", documentDirectory: null },
	]) {
		const state = createVirtualTestState({
			platformOS: scenario.platformOS,
			documentDirectory: scenario.documentDirectory,
		});
		const mod = await loadFreshSpeciesDb(state, false);

		const db = await mod.initSpeciesDb();
		assert.equal(db, null, `${scenario.name}: initSpeciesDb must return null`);
		assert.equal(
			state.stats.fsCalls,
			0,
			`${scenario.name}: zero FileSystem calls`,
		);
		assert.equal(
			state.stats.openCount,
			0,
			`${scenario.name}: zero SQLite opens`,
		);

		assert.equal(await mod.getSpeciesCount(), 396);

		const caFlower = await mod.getDailyFlowerOffline("CA", "2026-05-01");
		assert.ok(caFlower);
		assert.equal(caFlower.region, "CA");

		const fallbackFlower = await mod.getDailyFlowerOffline(
			"UNKNOWN-REGION",
			"2026-05-01",
		);
		assert.ok(fallbackFlower);
		assert.equal(fallbackFlower.region, "default");

		const results = await mod.searchSpecies("desert yellow", 5);
		assert.ok(results.length > 0);
		assert.equal(results[0].common, "Desert Marigold");
		assert.ok(results[0].similarity > 0 && results[0].similarity <= 1);
	}
});

test("4. 100% offline search: zero API keys/network, accurate multi-term ranking, FTS5 sanitization", async () => {
	const sourceText = readFileSync(join(ROOT, "lib", "speciesDb.ts"), "utf8");
	assert.equal(
		sourceText.includes("EXPO_PUBLIC_GEMINI_API_KEY"),
		false,
		"lib/speciesDb.ts must not reference EXPO_PUBLIC_GEMINI_API_KEY",
	);
	assert.equal(
		sourceText.includes("generativelanguage.googleapis.com"),
		false,
		"lib/speciesDb.ts must not reference Gemini API URL",
	);

	const originalFetch = globalThis.fetch;
	globalThis.fetch = () => {
		throw new Error("Network fetch MUST NOT be called during offline search");
	};

	try {
		const state = createVirtualTestState({ devMode: false });
		const mod = await loadFreshSpeciesDb(state, false);

		// Empty / whitespace / punctuation-only queries return []
		assert.deepEqual(await mod.searchSpecies(""), []);
		assert.deepEqual(await mod.searchSpecies("   "), []);
		assert.deepEqual(await mod.searchSpecies("!!! ---"), []);

		// FTS5 operator/quote sanitization must never throw
		const tricky = await mod.searchSpeciesVector('"poppy" OR (NOT cactus*)', 6);
		assert.ok(tricky.length > 0);

		// Multi-term benchmark 1: "purple spring poppy"
		const purpleSpringPoppy = await mod.searchSpecies("purple spring poppy", 8);
		assert.ok(purpleSpringPoppy.length >= 4);
		const topNames1 = purpleSpringPoppy.map((r) => r.common);
		assert.ok(
			topNames1.some((n) => n.includes("Poppy")),
			`Expected Poppy in top results, got: ${topNames1.join(", ")}`,
		);
		assert.ok(
			topNames1.some(
				(n) =>
					n.includes("Pasqueflower") ||
					n.includes("Violet") ||
					n.includes("Lilac") ||
					n.includes("Trillium"),
			),
			`Expected purple spring flower in top results, got: ${topNames1.join(", ")}`,
		);

		// Multi-term benchmark 2: "desert yellow"
		const desertYellow = await mod.searchSpecies("desert yellow", 6);
		assert.equal(desertYellow[0].common, "Desert Marigold");
		assert.ok(desertYellow[0].similarity > 0.8);

		// Multi-term benchmark 3: "yellow autumn bloom"
		const yellowAutumn = await mod.searchSpecies("yellow autumn bloom", 6);
		const topNames3 = yellowAutumn.map((r) => r.common);
		assert.ok(
			topNames3.some(
				(n) =>
					n === "Mexican Marigold" ||
					n === "Goldenrod" ||
					n === "Desert Marigold" ||
					n === "Yellow Elder",
			),
			`Expected yellow autumn species in top results, got: ${topNames3.join(", ")}`,
		);
		for (const item of yellowAutumn) {
			assert.ok(
				item.similarity > 0 && item.similarity <= 1,
				`Similarity out of (0,1]: ${item.similarity}`,
			);
		}

		// Native fallback when FTS5 is unavailable
		const noFtsState = createVirtualTestState({
			devMode: false,
			disableFts5: true,
		});
		const noFtsMod = await loadFreshSpeciesDb(noFtsState, false);
		const noFtsResults = await noFtsMod.searchSpecies("desert yellow", 5);
		assert.equal(noFtsResults[0].common, "Desert Marigold");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("5. 3072-dim consistency, cosineSimilarity guards, assets/species.db, and compile 429 retry", async () => {
	const state = createVirtualTestState({ devMode: false });
	const mod = await loadFreshSpeciesDb(state, false);

	assert.equal(mod.EMBEDDING_DIM, 3072);
	assert.equal(COMPILE_EMBEDDING_DIM, 3072);
	assert.equal(mod.DB_VERSION, 2);
	assert.equal(COMPILE_DB_VERSION, 2);

	// cosineSimilarity guards (including NaN and Infinity)
	assert.equal(
		mod.cosineSimilarity(new Float32Array(768), new Float32Array(3072)),
		0,
	);
	assert.equal(mod.cosineSimilarity([], []), 0);
	assert.equal(mod.cosineSimilarity([0, 0, 0], [1, 0, 0]), 0);
	assert.equal(mod.cosineSimilarity([Number.NaN, 1, 0], [1, 1, 0]), 0);
	assert.equal(mod.cosineSimilarity([Number.POSITIVE_INFINITY, 1], [1, 1]), 0);
	assert.equal(
		mod.cosineSimilarity(
			[Number.POSITIVE_INFINITY, 1],
			[Number.POSITIVE_INFINITY, 1],
		),
		0,
	);
	assert.equal(mod.cosineSimilarity([Number.NEGATIVE_INFINITY, 1], [1, 1]), 0);
	assert.ok(Math.abs(mod.cosineSimilarity([3, 4], [3, 4]) - 1) < 1e-6);
	assert.equal(mod.cosineSimilarity([1, 0], [0, 1]), 0);

	// Unaligned byteOffset BLOB decoding
	const rawBuf = new ArrayBuffer(20);
	const alignedView = new Float32Array([1.5, -2.25, 3.5]);
	const unalignedBytes = new Uint8Array(rawBuf, 1, 12);
	unalignedBytes.set(new Uint8Array(alignedView.buffer));
	const decoded = mod.decodeEmbeddingBlob(unalignedBytes);
	assert.equal(decoded.length, 3);
	assert.equal(decoded[0], 1.5);
	assert.equal(decoded[1], -2.25);
	assert.equal(decoded[2], 3.5);

	// Checked-in assets/species.db verification
	const assetDb = new DatabaseSync(ASSET_DB_PATH, { readOnly: true });
	try {
		const counts = assetDb
			.prepare(
				"SELECT count(*) AS total, count(DISTINCT region) AS regions, sum(CASE WHEN length(embedding) = 12288 THEN 1 ELSE 0 END) AS valid3072 FROM species;",
			)
			.get();
		assert.equal(counts.total, 396);
		assert.equal(counts.regions, 112);
		assert.equal(counts.valid3072, 396);
		const ver = assetDb.prepare("PRAGMA user_version;").get();
		assert.equal(ver.user_version, 2);
	} finally {
		assetDb.close();
	}

	// compile_species_db.mjs: no API key -> 3072-dim unit fallback
	const fallbackVec = await fetchEmbedding("", "California Poppy");
	assert.equal(fallbackVec.length, 3072);
	assert.equal(fallbackVec[0], 1);

	// compile_species_db.mjs: HTTP 429 retries before succeeding
	let attempts = 0;
	const expectedVec = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
	const retriedVec = await fetchEmbedding("test-key", "Desert Marigold", {
		maxAttempts: 4,
		baseDelayMs: 0,
		fetchImpl: async () => {
			attempts++;
			if (attempts < 3) {
				return new Response(
					JSON.stringify({
						error: { status: "RESOURCE_EXHAUSTED", message: "Rate limit" },
					}),
					{ status: 429, headers: { "Retry-After": "0" } },
				);
			}
			return new Response(
				JSON.stringify({ embedding: { values: expectedVec } }),
				{ status: 200 },
			);
		},
	});
	assert.equal(attempts, 3, "Must retry HTTP 429 before succeeding");
	assert.equal(retriedVec.length, 3072);

	// compile_species_db.mjs: HTTP 429 mentioning "billing" must STILL retry (not misclassified)
	let billingQuotaAttempts = 0;
	const retried429BillingVec = await fetchEmbedding(
		"test-key",
		"Desert Marigold",
		{
			maxAttempts: 4,
			baseDelayMs: 0,
			fetchImpl: async () => {
				billingQuotaAttempts++;
				if (billingQuotaAttempts < 3) {
					return new Response(
						JSON.stringify({
							error: {
								status: "RESOURCE_EXHAUSTED",
								message: "Quota exceeded; check your billing quota limits",
							},
						}),
						{ status: 429, headers: { "Retry-After": "0" } },
					);
				}
				return new Response(
					JSON.stringify({ embedding: { values: expectedVec } }),
					{ status: 200 },
				);
			},
		},
	);
	assert.equal(
		billingQuotaAttempts,
		3,
		"HTTP 429 with 'billing' copy must retry rather than exit permanently",
	);
	assert.equal(retried429BillingVec.length, 3072);

	// compile_species_db.mjs: permanent billing error (non-429) rejects immediately without full retries
	let billingAttempts = 0;
	await assert.rejects(
		() =>
			fetchEmbedding("test-key", "Desert Marigold", {
				maxAttempts: 4,
				baseDelayMs: 0,
				fetchImpl: async () => {
					billingAttempts++;
					return new Response(
						JSON.stringify({
							error: {
								status: "PERMISSION_DENIED",
								message: "Account lacks prepayment credits",
							},
						}),
						{ status: 403 },
					);
				},
			}),
		PermanentApiError,
	);
	assert.equal(billingAttempts, 1);

	let genericBilling400Attempts = 0;
	await assert.rejects(
		() =>
			fetchEmbedding("test-key", "Desert Marigold", {
				maxAttempts: 4,
				baseDelayMs: 0,
				fetchImpl: async () => {
					genericBilling400Attempts++;
					return new Response(
						JSON.stringify({
							error: {
								status: "FAILED_PRECONDITION",
								message: "Billing account is not enabled",
							},
						}),
						{ status: 400 },
					);
				},
			}),
		PermanentApiError,
	);
	assert.equal(genericBilling400Attempts, 1);
});

test("6. FTS5/Web parity on substring queries, NFD diacritic normalization, apostrophes, and FTS5 token cap", async () => {
	const nativeState = createVirtualTestState({ devMode: false });
	const nativeMod = await loadFreshSpeciesDb(nativeState, false);

	const webState = createVirtualTestState({ platformOS: "web" });
	const webMod = await loadFreshSpeciesDb(webState, false);

	// Substring multi-concept query "spring bonnet" must return Texas Bluebonnet at #1-#2 on BOTH Native FTS5 & Web
	const nativeBonnet = await nativeMod.searchSpecies("spring bonnet", 6);
	const webBonnet = await webMod.searchSpecies("spring bonnet", 6);
	assert.equal(nativeBonnet[0]?.common, "Texas Bluebonnet");
	assert.equal(nativeBonnet[1]?.common, "Texas Bluebonnet");
	assert.equal(webBonnet[0]?.common, "Texas Bluebonnet");
	assert.equal(webBonnet[1]?.common, "Texas Bluebonnet");

	// Multi-concept "purple spring poppy" keeps California Poppy in top 6 on BOTH Native FTS5 and Web
	const nativePoppy = await nativeMod.searchSpecies("purple spring poppy", 6);
	const webPoppy = await webMod.searchSpecies("purple spring poppy", 6);
	assert.ok(
		nativePoppy.some((r) => r.common === "California Poppy"),
		`Native top 6 should include California Poppy, got: ${nativePoppy.map((r) => r.common).join(", ")}`,
	);
	assert.ok(
		webPoppy.some((r) => r.common === "California Poppy"),
		`Web top 6 should include California Poppy, got: ${webPoppy.map((r) => r.common).join(", ")}`,
	);

	// NFD diacritic normalization: "São Paulo", "Ipe", "Yucatán", "Nuevo León"
	assert.deepEqual(nativeMod.sanitizeFtsTokens("São Paulo"), ["sao", "paulo"]);
	assert.deepEqual(nativeMod.sanitizeFtsTokens("Yucatán"), ["yucatan"]);
	assert.deepEqual(nativeMod.sanitizeFtsTokens("Nuevo León"), [
		"nuevo",
		"leon",
	]);

	for (const [mod, label] of [
		[nativeMod, "Native FTS5"],
		[webMod, "Web"],
	]) {
		const saoPaulo = await mod.searchSpecies("São Paulo", 6);
		assert.equal(
			saoPaulo.length,
			4,
			`${label}: São Paulo returns 4 BR-SP species`,
		);
		assert.ok(
			saoPaulo.every((r) => r.region === "BR-SP"),
			`${label}: São Paulo must rank BR-SP species at top, got ${saoPaulo.map((r) => `${r.common}[${r.region}]`).join(", ")}`,
		);

		const ipe = await mod.searchSpecies("Ipe", 6);
		assert.ok(ipe.length >= 1, `${label}: Ipe must match Ipê-amarelo`);
		assert.equal(ipe[0].common, "Ipê-amarelo");

		const yucatan = await mod.searchSpecies("Yucatán", 6);
		assert.ok(
			yucatan.slice(0, 4).every((r) => r.region === "MX-YUC"),
			`${label}: Yucatán must rank MX-YUC species at top`,
		);

		const nuevoLeon = await mod.searchSpecies("Nuevo León", 6);
		assert.ok(
			nuevoLeon.slice(0, 4).every((r) => r.region === "MX-NLE"),
			`${label}: Nuevo León must rank MX-NLE species at top`,
		);

		// Possessive apostrophe normalization: "s" must not match Angel's/Lady's species
		assert.deepEqual(await mod.searchSpecies("s", 6), []);
		const angels = await mod.searchSpecies("Angel's Trumpet", 6);
		assert.equal(angels[0]?.common, "Angel's Trumpet");
	}

	// Reviewer hardening note: FTS5 MATCH query tokens are capped at <= 24
	nativeState.ftsQueries.length = 0;
	const longQuery = Array.from({ length: 40 }, (_, i) => `token${i}`).join(" ");
	await nativeMod.searchSpecies(longQuery, 6);
	assert.equal(nativeState.ftsQueries.length, 1);
	const clauseCount = nativeState.ftsQueries[0].split(" OR ").length;
	assert.ok(
		clauseCount <= 24,
		`FTS5 MATCH clauses must be capped at 24, got ${clauseCount}`,
	);
});

test("7. compile_species_db.mjs: HTTP 400 non-billing fail-fast & Retry-After HTTP-date / whitespace handling", async () => {
	// parseRetryAfterMs unit checks: integer seconds, HTTP-date, whitespace, negative
	assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "2" })), 2000);
	assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "   " })), null);
	assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "-5" })), null);
	assert.equal(
		parseRetryAfterMs(
			new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
		),
		0,
	);
	const futureHttpDate = new Date(Date.now() + 2000).toUTCString();
	const futureMs = parseRetryAfterMs(
		new Headers({ "Retry-After": futureHttpDate }),
	);
	assert.ok(
		futureMs !== null && futureMs > 500 && futureMs <= 2500,
		`Expected ~2000ms for future HTTP-date, got ${futureMs}`,
	);

	// Generic HTTP 400 (non-billing) must fail fast on attempt 1 without retrying or throwing PermanentApiError
	let generic400Calls = 0;
	const generic400Sleeps = [];
	await assert.rejects(
		() =>
			fetchEmbedding("test-key", "California Poppy", {
				maxAttempts: 4,
				baseDelayMs: 50,
				sleepImpl: async (ms) => {
					generic400Sleeps.push(ms);
				},
				fetchImpl: async () => {
					generic400Calls++;
					return new Response(
						JSON.stringify({
							error: {
								status: "INVALID_ARGUMENT",
								message: "Request payload too large",
							},
						}),
						{ status: 400 },
					);
				},
			}),
		(err) =>
			!(err instanceof PermanentApiError) && /HTTP 400/.test(err.message),
	);
	assert.equal(generic400Calls, 1, "Generic HTTP 400 must not retry");
	assert.deepEqual(generic400Sleeps, []);

	// HTTP 429 with HTTP-date then whitespace-only Retry-After falls back properly
	const expectedVec = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
	let dateRetryCalls = 0;
	const dateRetrySleeps = [];
	const resVec = await fetchEmbedding("test-key", "Desert Marigold", {
		maxAttempts: 4,
		baseDelayMs: 50,
		sleepImpl: async (ms) => {
			dateRetrySleeps.push(ms);
		},
		fetchImpl: async () => {
			dateRetryCalls++;
			if (dateRetryCalls === 1) {
				return new Response(
					JSON.stringify({
						error: { status: "RESOURCE_EXHAUSTED", message: "Rate limit" },
					}),
					{
						status: 429,
						headers: {
							"Retry-After": new Date(Date.now() + 1500).toUTCString(),
						},
					},
				);
			}
			if (dateRetryCalls === 2) {
				return new Response(
					JSON.stringify({
						error: { status: "RESOURCE_EXHAUSTED", message: "Rate limit" },
					}),
					{
						status: 429,
						headers: { "Retry-After": "   " },
					},
				);
			}
			return new Response(
				JSON.stringify({ embedding: { values: expectedVec } }),
				{ status: 200 },
			);
		},
	});
	assert.equal(resVec.length, 3072);
	assert.equal(dateRetryCalls, 3);
	assert.equal(dateRetrySleeps.length, 2);
	assert.ok(
		dateRetrySleeps[0] >= 500 && dateRetrySleeps[0] <= 2000,
		`Expected HTTP-date sleep ~1500ms, got ${dateRetrySleeps[0]}`,
	);
	assert.equal(
		dateRetrySleeps[1],
		100,
		"Whitespace-only Retry-After must fall back to baseDelayMs * 2^(2-1) = 100",
	);
});

test("8. initSpeciesDb() clears dbInitPromise when FileSystem.getInfoAsync throws synchronously and recovers on retry", async () => {
	const syncFailState = createVirtualTestState({
		devMode: false,
		syncThrowGetInfoOnce: true,
	});
	const mod = await loadFreshSpeciesDb(syncFailState, false);

	const results = await Promise.allSettled([
		mod.initSpeciesDb(),
		mod.initSpeciesDb(),
	]);
	assert.equal(results[0].status, "rejected");
	assert.equal(results[1].status, "rejected");
	assert.match(
		results[0].reason.message,
		/Synchronous FileSystem\.getInfoAsync failure/,
	);
	assert.match(
		results[1].reason.message,
		/Synchronous FileSystem\.getInfoAsync failure/,
	);
	assert.equal(
		syncFailState.stats.fsCalls,
		1,
		"Concurrent callers must share the single failed init attempt",
	);

	const recovered = await mod.initSpeciesDb();
	assert.ok(recovered, "Retry after synchronous throw must succeed");
	assert.ok(
		syncFailState.stats.fsCalls > 1,
		"Retry must invoke FileSystem.getInfoAsync again instead of reusing leaked promise",
	);
	assert.equal(syncFailState.stats.copyCount, 1);
	assert.equal(await mod.getSpeciesCount(), 396);
});

test("9. initSpeciesDb() recovers cleanly when FileSystem.documentDirectory getter throws on 1st or 2nd/mid-init read", async () => {
	// Case A: Synchronous throw on 1st read with concurrent callers, then recovery
	let throwFirst = true;
	let firstReadCount = 0;
	const firstReadState = createVirtualTestState({
		devMode: false,
		useFsGetterProxy: true,
		getDocumentDirectory() {
			firstReadCount++;
			if (throwFirst) {
				throw new Error("sync documentDirectory getter failure");
			}
			return firstReadState.documentDirectory;
		},
	});
	const mod1 = await loadFreshSpeciesDb(firstReadState, false);

	const firstResults = await Promise.allSettled([
		mod1.initSpeciesDb(),
		mod1.initSpeciesDb(),
	]);
	assert.equal(firstResults[0].status, "rejected");
	assert.equal(firstResults[1].status, "rejected");
	assert.match(
		firstResults[0].reason.message,
		/sync documentDirectory getter failure/,
	);
	assert.equal(firstReadState.stats.fsCalls, 0);

	throwFirst = false;
	const countBeforeReads = firstReadCount;
	const recovered1 = await mod1.initSpeciesDb();
	assert.ok(recovered1, "Recovery after 1st-read getter throw must succeed");
	assert.equal(
		firstReadCount - countBeforeReads,
		1,
		"initSpeciesDb must read FileSystem.documentDirectory only once per call",
	);
	assert.equal(firstReadState.stats.copyCount, 1);
	assert.equal(await mod1.getSpeciesCount(), 396);

	// Case B: Valid path on 1st read, then synchronous throw on 2nd / mid-init read
	// paired with a failed in-flight init, followed by clean recovery.
	let throwSecond = false;
	const midFailState = createVirtualTestState({
		devMode: false,
		useFsGetterProxy: true,
		syncThrowGetInfoOnce: true,
		getDocumentDirectory() {
			if (throwSecond) {
				throw new Error("sync documentDirectory getter failure");
			}
			return midFailState.documentDirectory;
		},
	});
	const mod2 = await loadFreshSpeciesDb(midFailState, false);

	const p1 = mod2.initSpeciesDb();
	throwSecond = true;
	const p2 = mod2.initSpeciesDb();

	const midResults = await Promise.allSettled([p1, p2]);
	assert.equal(midResults[0].status, "rejected");
	assert.equal(midResults[1].status, "rejected");
	assert.match(
		midResults[0].reason.message,
		/Synchronous FileSystem\.getInfoAsync failure/,
	);
	assert.match(
		midResults[1].reason.message,
		/sync documentDirectory getter failure/,
	);

	throwSecond = false;
	const recovered2 = await mod2.initSpeciesDb();
	assert.ok(
		recovered2,
		"Recovery after 2nd/mid-init documentDirectory getter throw must succeed",
	);
	assert.equal(midFailState.stats.copyCount, 1);
	assert.equal(await mod2.getSpeciesCount(), 396);
});
