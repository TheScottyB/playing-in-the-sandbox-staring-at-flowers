import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolvePath(__dirname, "../../..");

const VIRTUAL_PREFIX = "e2e-virtual:";
const VIRTUAL_MODULES = new Set([
	"react-native",
	"@react-native-async-storage/async-storage",
	"expo-sqlite",
	"expo-file-system",
	"expo-file-system/legacy",
	"expo-asset",
	"expo-constants",
	"expo-location",
	"react-native-purchases",
]);

const ALIAS_PREFIXES = [
	["@/constants/", "shared/constants/"],
	["@/components/", "shared/components/"],
	["@/styles/", "shared/styles/"],
	["@/types/", "shared/types/"],
	["@/hooks/", "shared/hooks/"],
	["@/data/", "lib/data/"],
	["@/", ""],
];

function resolveLocalPath(basePath) {
	const candidates = [
		basePath,
		`${basePath}.ts`,
		`${basePath}.tsx`,
		`${basePath}.mjs`,
		`${basePath}.js`,
		`${basePath}.json`,
		join(basePath, "index.ts"),
		join(basePath, "index.tsx"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate) && statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return null;
}

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith("node:")) {
		return nextResolve(specifier, context);
	}

	let runId = null;
	if (context.parentURL) {
		try {
			const pUrl = new URL(context.parentURL);
			runId = pUrl.searchParams.get("run");
		} catch {
			runId = null;
		}
	}

	const [cleanSpec, specQuery] = specifier.split("?");
	if (specQuery) {
		const params = new URLSearchParams(specQuery);
		if (params.has("run")) {
			runId = params.get("run");
		}
	}

	if (VIRTUAL_MODULES.has(cleanSpec)) {
		const suffix = runId ? `?run=${runId}` : "";
		return {
			shortCircuit: true,
			url: `${VIRTUAL_PREFIX}${cleanSpec}${suffix}`,
		};
	}

	// Alias resolution
	for (const [prefix, targetRel] of ALIAS_PREFIXES) {
		if (cleanSpec.startsWith(prefix)) {
			const sub = cleanSpec.slice(prefix.length);
			const abs = resolveLocalPath(join(REPO_ROOT, targetRel, sub));
			if (abs) {
				const fileUrl = pathToFileURL(abs);
				if (runId) fileUrl.searchParams.set("run", runId);
				return { shortCircuit: true, url: fileUrl.href };
			}
		}
	}

	// Relative resolution within repo
	if (
		(cleanSpec.startsWith("./") || cleanSpec.startsWith("../")) &&
		context.parentURL &&
		context.parentURL.startsWith("file://")
	) {
		const parentPath = fileURLToPath(context.parentURL);
		if (
			parentPath.startsWith(REPO_ROOT) &&
			!parentPath.includes(`${REPO_ROOT}/node_modules/`)
		) {
			const abs = resolveLocalPath(resolvePath(dirname(parentPath), cleanSpec));
			if (abs) {
				const fileUrl = pathToFileURL(abs);
				if (runId) fileUrl.searchParams.set("run", runId);
				return { shortCircuit: true, url: fileUrl.href };
			}
		}
	}

	return nextResolve(specifier, context);
}

function virtualSource(name) {
	switch (name) {
		case "react-native":
			return `
const m = () => globalThis.__E2E_MOCKS__;
export const Platform = {
	get OS() { return m()?.platform?.OS ?? "ios"; },
	select(map) {
		const os = m()?.platform?.OS ?? "ios";
		return os in map ? map[os] : map.default;
	},
};
export const LogBox = { ignoreAllLogs() {} };
export const StyleSheet = {
	create: (s) => s,
	absoluteFill: { position: "absolute", left: 0, right: 0, top: 0, bottom: 0 },
};
export const Alert = { alert: (...args) => m()?.alerts?.push(args) };
export const Linking = { openURL: async () => {}, openSettings: async () => {} };
export const AppState = {
	addEventListener: (_evt, cb) => {
		m()?.appStateListeners?.push(cb);
		return { remove() {} };
	},
};
`;
		case "@react-native-async-storage/async-storage":
			return `
const store = () => globalThis.__E2E_MOCKS__.asyncStorage;
export default {
	async getItem(k) { return store().has(k) ? store().get(k) : null; },
	async setItem(k, v) { store().set(k, String(v)); },
	async removeItem(k) { store().delete(k); },
	async clear() { store().clear(); },
	async getAllKeys() { return Array.from(store().keys()); },
};
`;
		case "expo-sqlite":
			return `
export function openDatabaseSync(name) {
	return globalThis.__E2E_MOCKS__.openSqlite(name);
}
export async function openDatabaseAsync(name) {
	return globalThis.__E2E_MOCKS__.openSqlite(name);
}
`;
		case "expo-file-system":
		case "expo-file-system/legacy":
			return `
const fsMock = () => globalThis.__E2E_MOCKS__.fs;
export const documentDirectory = globalThis.__E2E_MOCKS__?.fs?.documentDirectory ?? null;
export async function getInfoAsync(p) { return fsMock().getInfoAsync(p); }
export async function makeDirectoryAsync(p, o) { return fsMock().makeDirectoryAsync(p, o); }
export async function copyAsync(o) { return fsMock().copyAsync(o); }
export async function readAsStringAsync(p) { return fsMock().readAsStringAsync(p); }
export async function writeAsStringAsync(p, c) { return fsMock().writeAsStringAsync(p, c); }
export async function deleteAsync(p, o) { return fsMock().deleteAsync(p, o); }
`;
		case "expo-asset":
			return `
export class Asset {
	static fromModule(mod) {
		return globalThis.__E2E_MOCKS__.assetFromModule(mod);
	}
}
`;
		case "expo-constants":
			return `export default { expoConfig: { version: "1.3.0" } };`;
		case "expo-location":
			return `
const loc = () => globalThis.__E2E_MOCKS__.location;
export const Accuracy = { Lowest: 1, Low: 2, Balanced: 3, High: 4 };
export async function getForegroundPermissionsAsync() {
	return loc().getForegroundPermissionsAsync();
}
export async function requestForegroundPermissionsAsync() {
	return loc().requestForegroundPermissionsAsync();
}
export async function getCurrentPositionAsync(opts) {
	return loc().getCurrentPositionAsync(opts);
}
export async function reverseGeocodeAsync(coords) {
	return loc().reverseGeocodeAsync(coords);
}
`;
		case "react-native-purchases":
			return `
const p = () => globalThis.__E2E_MOCKS__.purchases;
export const PACKAGE_TYPE = {
	MONTHLY: "MONTHLY",
	ANNUAL: "ANNUAL",
	LIFETIME: "LIFETIME",
};
export default new Proxy({}, {
	get(_target, prop) {
		const target = p();
		const val = target[prop];
		return typeof val === "function" ? val.bind(target) : val;
	},
});
`;
		default:
			throw new Error(`Unknown virtual module: ${name}`);
	}
}

export async function load(url, context, nextLoad) {
	if (url.startsWith(VIRTUAL_PREFIX)) {
		const withoutPrefix = url.slice(VIRTUAL_PREFIX.length);
		const name = withoutPrefix.split("?")[0];
		return {
			shortCircuit: true,
			format: "module",
			source: virtualSource(name),
		};
	}

	if (url.startsWith("file://")) {
		const cleanUrl = url.split("?")[0];
		const filePath = fileURLToPath(cleanUrl);
		if (
			filePath.endsWith(".png") ||
			filePath.endsWith(".jpg") ||
			filePath.endsWith(".jpeg") ||
			filePath.endsWith(".webp") ||
			filePath.endsWith(".db")
		) {
			return {
				shortCircuit: true,
				format: "module",
				source: `export default ${JSON.stringify(filePath)};`,
			};
		}
		if (filePath.endsWith(".json")) {
			const jsonText = readFileSync(filePath, "utf8");
			return {
				shortCircuit: true,
				format: "module",
				source: `export default ${jsonText};`,
			};
		}
		if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
			const raw = readFileSync(filePath, "utf8");
			const transpiled = ts.transpileModule(raw, {
				fileName: filePath,
				compilerOptions: {
					module: ts.ModuleKind.ESNext,
					target: ts.ScriptTarget.ES2022,
					jsx: ts.JsxEmit.ReactJSX,
					esModuleInterop: true,
					moduleResolution: ts.ModuleResolutionKind.Bundler,
				},
			});
			const prelude =
				"const require = (id) => globalThis.__e2eRequire(id, import.meta.url);\n";
			return {
				shortCircuit: true,
				format: "module",
				source: prelude + transpiled.outputText,
			};
		}
	}

	return nextLoad(url, context);
}
