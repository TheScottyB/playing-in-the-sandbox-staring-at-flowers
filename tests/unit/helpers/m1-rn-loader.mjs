import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../..",
);

const EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"];

const ALIAS_PREFIXES = [
	["@/constants/", "shared/constants/"],
	["@/components/", "shared/components/"],
	["@/styles/", "shared/styles/"],
	["@/types/", "shared/types/"],
	["@/hooks/", "shared/hooks/"],
	["@/data/", "lib/data/"],
	["@/", ""],
];

if (typeof globalThis.__DEV__ === "undefined") {
	globalThis.__DEV__ = false;
}

if (!globalThis.__mockAsyncStorage) {
	globalThis.__mockAsyncStorage = new Map();
}

if (!globalThis.__mockPlatform) {
	globalThis.__mockPlatform = { OS: "ios" };
}

if (!globalThis.__mockPurchases) {
	globalThis.__mockPurchases = {
		configure: () => {},
		getOfferings: async () => ({ current: null }),
		purchasePackage: async () => ({
			customerInfo: { entitlements: { active: {} } },
		}),
		restorePurchases: async () => ({ entitlements: { active: {} } }),
		getCustomerInfo: async () => ({ entitlements: { active: {} } }),
		addCustomerInfoUpdateListener: () => {},
		removeCustomerInfoUpdateListener: () => true,
	};
}

globalThis.require = (id) => {
	if (id === "react-native-purchases") {
		return { default: globalThis.__mockPurchases };
	}
	throw new Error(`Unexpected CommonJS require("${id}") in unit test`);
};

const MOCK_MODULES = {
	"@react-native-async-storage/async-storage": `
const store = globalThis.__mockAsyncStorage;
const AsyncStorage = {
	async getItem(key) {
		return store.has(key) ? store.get(key) : null;
	},
	async setItem(key, value) {
		store.set(key, String(value));
	},
	async removeItem(key) {
		store.delete(key);
	},
	async clear() {
		store.clear();
	},
};
export default AsyncStorage;
`,
	"react-native": `
export const Platform = {
	get OS() {
		return globalThis.__mockPlatform.OS;
	},
	select(spec) {
		const os = globalThis.__mockPlatform.OS;
		if (Object.hasOwn(spec, os)) return spec[os];
		return spec.default;
	},
};
`,
	"react-native-purchases": `
export default globalThis.__mockPurchases;
`,
	"@/data/defaults": `
export const DEFAULT_FLOWER = {
	common: "California Poppy",
	latin: "Eschscholzia californica",
	blurb: "A drought-tolerant bloom whose vivid orange petals close at night and on cloudy days. State flower of California; reseeds itself across the western US.",
	variants: [
		{ time: "sunrise", fromHour: 5, image: 1 },
		{ time: "midday", fromHour: 10, image: 2 },
		{ time: "sunset", fromHour: 17, image: 3 },
		{ time: "dusk", fromHour: 20, image: 4 },
	],
};
export function pickVariant(now = new Date()) {
	const hour = now.getHours();
	let pick = DEFAULT_FLOWER.variants[DEFAULT_FLOWER.variants.length - 1];
	for (const v of DEFAULT_FLOWER.variants) {
		if (hour >= v.fromHour) pick = v;
	}
	return pick;
}
`,
	"expo-location": `export default {};`,
	"expo-asset": `export const Asset = {};`,
	"expo-file-system/legacy": `export const documentDirectory = null;`,
	"expo-sqlite": `export function openDatabaseSync() { throw new Error("Not mocked"); }`,
};

function resolveFileCandidate(absBase, query = "") {
	if (fs.existsSync(absBase) && fs.statSync(absBase).isFile()) {
		return `${pathToFileURL(absBase).href}${query}`;
	}
	for (const ext of EXTENSIONS) {
		const candidate = `${absBase}${ext}`;
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return `${pathToFileURL(candidate).href}${query}`;
		}
	}
	return null;
}

if (!globalThis.__m1LoaderRegistered) {
	globalThis.__m1LoaderRegistered = true;

	registerHooks({
		resolve(specifier, context, nextResolve) {
			if (Object.hasOwn(MOCK_MODULES, specifier)) {
				return {
					shortCircuit: true,
					url: `mock:///${encodeURIComponent(specifier)}`,
				};
			}

			const queryIndex = specifier.indexOf("?");
			const cleanSpec =
				queryIndex === -1 ? specifier : specifier.slice(0, queryIndex);
			const query = queryIndex === -1 ? "" : specifier.slice(queryIndex);

			for (const [prefix, target] of ALIAS_PREFIXES) {
				if (cleanSpec.startsWith(prefix)) {
					const relPath = target + cleanSpec.slice(prefix.length);
					const resolved = resolveFileCandidate(
						path.join(REPO_ROOT, relPath),
						query,
					);
					if (resolved) {
						return { shortCircuit: true, url: resolved };
					}
				}
			}

			if (
				(cleanSpec.startsWith("./") || cleanSpec.startsWith("../")) &&
				context.parentURL?.startsWith("file://")
			) {
				const parentDir = path.dirname(
					fileURLToPath(context.parentURL.split("?")[0]),
				);
				const resolved = resolveFileCandidate(
					path.resolve(parentDir, cleanSpec),
					query,
				);
				if (resolved) {
					return { shortCircuit: true, url: resolved };
				}
			}

			return nextResolve(specifier, context);
		},

		load(url, context, nextLoad) {
			if (url.startsWith("mock:///")) {
				const specifier = decodeURIComponent(url.slice("mock:///".length));
				const source = MOCK_MODULES[specifier];
				if (source !== undefined) {
					return {
						shortCircuit: true,
						format: "module",
						source,
					};
				}
			}
			return nextLoad(url, context);
		},
	});
}
