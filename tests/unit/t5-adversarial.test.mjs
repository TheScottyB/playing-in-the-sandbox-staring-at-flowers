import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Jimp } from "jimp";
import { createE2EContext } from "../e2e/helpers/rn-loader.mjs";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

function readRepoFile(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function buildHeadlessRnLoaderCode(options = {}) {
	const purchasesWrapperMock = options.mockPurchasesWrapper
		? `
	"@/lib/purchases": \`
		export async function getSubscriptionOfferings() {
			return globalThis.__probeGetSubscriptionOfferings();
		}
		export async function purchasePackage(id) {
			return globalThis.__probePurchasePackage(id);
		}
		export async function restorePurchases() {
			return false;
		}
	\`,`
		: "";
	const speciesDbMock = options.useRealSpeciesDb
		? ""
		: `
	"@/lib/speciesDb": \`
		export const MAX_QUERY_CHARS = 200;
		export const MAX_QUERY_TOKENS = 16;
		export function isSearchQueryEligible(q) {
			const trimmed = q.trim();
			if (trimmed.length < 2) return false;
			const tokens = trimmed.toLowerCase().match(/[a-z0-9]+/g) ?? [];
			if (tokens.length === 0) return false;
			const grammar = new Set(["a","an","the","in","on","at","of","with","and","or","not","near","for","to","from","by","is","are","like","that","this"]);
			return tokens.some((t) => !grammar.has(t));
		}
		export async function getDailyFlowerOffline(region, date) {
			return globalThis.__probeOfflineFlower(region, date);
		}
		export async function getSpeciesCount() { return 396; }
		export async function searchSpeciesVector(query) {
			return globalThis.__probeSearchSpecies(query);
		}
	\`,`;

	return `
import fs from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from ${JSON.stringify(import.meta.resolve("typescript"))};

const REPO_ROOT = ${JSON.stringify(ROOT)};
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

const VIRTUAL_MODULES = {
	"react": \`
		export const runtime = {
			states: [],
			effects: [],
			hookIdx: 0,
			renderScheduled: false,
			currentTree: null,
			componentFn: null,
			onRender: null,
		};
		export function resetRuntime(fn, onRender = null) {
			for (const slot of runtime.states) {
				if (slot && typeof slot === "object" && "cleanup" in slot && typeof slot.cleanup === "function") {
					slot.cleanup();
				}
			}
			runtime.states = [];
			runtime.effects = [];
			runtime.hookIdx = 0;
			runtime.renderScheduled = false;
			runtime.componentFn = fn;
			runtime.onRender = onRender;
		}
		export function renderOnce() {
			runtime.hookIdx = 0;
			runtime.currentTree = runtime.componentFn();
			if (runtime.onRender) runtime.onRender(runtime.currentTree);
			const pending = runtime.effects.splice(0);
			for (const eff of pending) {
				if (eff.cleanup) eff.cleanup();
				eff.slot.cleanup = eff.fn() || null;
			}
			return runtime.currentTree;
		}
		export function useState(init) {
			const idx = runtime.hookIdx++;
			if (!(idx in runtime.states)) {
				runtime.states[idx] = typeof init === "function" ? init() : init;
			}
			const setter = (val) => {
				const next = typeof val === "function" ? val(runtime.states[idx]) : val;
				if (!Object.is(next, runtime.states[idx])) {
					runtime.states[idx] = next;
					if (!runtime.renderScheduled) {
						runtime.renderScheduled = true;
						queueMicrotask(() => {
							runtime.renderScheduled = false;
							renderOnce();
						});
					}
				}
			};
			return [runtime.states[idx], setter];
		}
		export function useEffect(fn, deps) {
			const idx = runtime.hookIdx++;
			const prev = runtime.states[idx];
			const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
			if (changed) {
				const slot = prev || { cleanup: null, deps };
				slot.deps = deps;
				runtime.states[idx] = slot;
				runtime.effects.push({ fn, slot, cleanup: slot.cleanup });
			}
		}
		export function useMemo(fn, deps) {
			const idx = runtime.hookIdx++;
			const prev = runtime.states[idx];
			const changed = !prev || !deps || deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
			if (changed) {
				const val = fn();
				runtime.states[idx] = { val, deps };
				return val;
			}
			return prev.val;
		}
		export function useRef(init) {
			const idx = runtime.hookIdx++;
			if (!(idx in runtime.states)) {
				runtime.states[idx] = { current: init };
			}
			return runtime.states[idx];
		}
		export default { useState, useEffect, useMemo, useRef };
	\`,
	"react/jsx-runtime": \`
		export function jsx(type, props) { return { type, props: props || {} }; }
		export const jsxs = jsx;
		export const Fragment = "Fragment";
	\`,
	"react-native": \`
		export const Platform = {
			OS: "ios",
			select(spec) { return Object.hasOwn(spec, "ios") ? spec.ios : spec.default; },
		};
		export const Alert = {
			alert(title, msg, btns) { globalThis.__probeAlerts.push({ title, msg, btns }); },
		};
		export const AppState = {
			addEventListener(_evt, cb) {
				globalThis.__probeAppStateListeners.push(cb);
				return {
					remove() {
						const idx = globalThis.__probeAppStateListeners.indexOf(cb);
						if (idx !== -1) globalThis.__probeAppStateListeners.splice(idx, 1);
					},
				};
			},
		};
		export const Linking = { openSettings() {} };
		export const StyleSheet = { create: (s) => s, absoluteFill: {} };
		export function useWindowDimensions() { return { width: 390, height: 844 }; }
		export const ActivityIndicator = "ActivityIndicator";
		export const Modal = "Modal";
		export const Pressable = "Pressable";
		export const ScrollView = "ScrollView";
		export const Text = "Text";
		export const TextInput = "TextInput";
		export const View = "View";
	\`,
	"@react-native-async-storage/async-storage": \`
		const s = globalThis.__probeStorage;
		export default {
			async getItem(k) { return s.has(k) ? s.get(k) : null; },
			async setItem(k, v) { s.set(k, String(v)); },
			async removeItem(k) { s.delete(k); },
		};
	\`,
	"react-native-purchases": "export default globalThis.__probePurchases;",
	"expo-constants": "export default { expoConfig: { version: '1.3.0' } };",
	"expo-image": "export const Image = 'Image';",
	"expo-linear-gradient": "export const LinearGradient = 'LinearGradient';",
	"expo-router": \`
		export const Link = Object.assign('Link', { Trigger: 'Trigger' });
		export const Stack = { Screen: 'StackScreen' };
		export function useRouter() { return { push(arg) { globalThis.__probeRouterPushes?.push(arg); }, back() {} }; }
		export function useLocalSearchParams() { return globalThis.__probeRouteParams || {}; }
	\`,
	"expo-status-bar": "export const StatusBar = 'StatusBar';",
	"expo-updates": "export const updateId = null;",
	"expo-location": \`
		export const PermissionStatus = { GRANTED: "granted", DENIED: "denied" };
		export const Accuracy = { Lowest: 1 };
		export async function getForegroundPermissionsAsync() {
			return { status: globalThis.__probePermStatus };
		}
		export async function requestForegroundPermissionsAsync() {
			return { status: globalThis.__probePermStatus };
		}
		export async function getCurrentPositionAsync() {
			if (globalThis.__probeGetPositionImpl) {
				return await globalThis.__probeGetPositionImpl();
			}
			return { coords: { latitude: 37.77, longitude: -122.42 } };
		}
		export async function reverseGeocodeAsync() {
			return [{ isoCountryCode: "US", region: "CA" }];
		}
	\`,
	"expo-asset": "export const Asset = {};",
	"expo-file-system/legacy": "export const documentDirectory = null;",
	"expo-sqlite": "export function openDatabaseSync() { throw new Error('no sqlite'); }",
	"react-native-safe-area-context": "export const SafeAreaView = 'SafeAreaView';",
	"./IridescentOverlay": "export const IridescentOverlay = 'IridescentOverlay';",
	"@/components/IridescentOverlay": "export const IridescentOverlay = 'IridescentOverlay';",
	"@/components/ModernFlipCard": "export default 'FlipCard';",
	"@/hooks/useOnline": "export function useOnline() { return globalThis.__probeOnline; }",
	"@/shared/components/PremiumModal": "export default 'PremiumModal';",
	"@/styles/home.styles": "export const styles = new Proxy({}, { get: () => ({}) });",
	"@/styles/flower-detail.styles": "export const styles = new Proxy({}, { get: () => ({}) });",
	"@/shared/constants/brand": "export const PALETTE = { accent: '#f2b8da', accentDeep: '#d48cb8' }; export const TYPE = { serif: 'serif' };",
	"@/data/defaults": \`
		export const DEFAULT_FLOWER = {
			common: "California Poppy",
			latin: "Eschscholzia californica",
			blurb: "Default poppy",
			variants: [{ time: "midday", fromHour: 0, image: 101 }],
		};
		export function pickVariant() { return DEFAULT_FLOWER.variants[0]; }
	\`,
	${purchasesWrapperMock}
	${speciesDbMock}
};

function resolveFile(absBase, query = "") {
	if (fs.existsSync(absBase) && fs.statSync(absBase).isFile()) {
		return pathToFileURL(absBase).href + query;
	}
	for (const ext of EXTENSIONS) {
		const cand = absBase + ext;
		if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
			return pathToFileURL(cand).href + query;
		}
	}
	return null;
}

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (Object.hasOwn(VIRTUAL_MODULES, specifier)) {
			return { shortCircuit: true, url: "probe:///" + encodeURIComponent(specifier) };
		}
		const qi = specifier.indexOf("?");
		const clean = qi === -1 ? specifier : specifier.slice(0, qi);
		const parentQuery = context.parentURL?.includes("?")
			? context.parentURL.slice(context.parentURL.indexOf("?"))
			: "";
		const query = (qi === -1 ? "" : specifier.slice(qi)) || parentQuery;
		for (const [prefix, target] of ALIAS_PREFIXES) {
			if (clean.startsWith(prefix)) {
				const resolved = resolveFile(path.join(REPO_ROOT, target + clean.slice(prefix.length)), query);
				if (resolved) return { shortCircuit: true, url: resolved };
			}
		}
		if ((clean.startsWith("./") || clean.startsWith("../")) && context.parentURL?.startsWith("file://")) {
			const parentDir = path.dirname(fileURLToPath(context.parentURL.split("?")[0]));
			const resolved = resolveFile(path.resolve(parentDir, clean), query);
			if (resolved) return { shortCircuit: true, url: resolved };
		}
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("probe:///")) {
			const spec = decodeURIComponent(url.slice("probe:///".length));
			return { shortCircuit: true, format: "module", source: VIRTUAL_MODULES[spec] };
		}
		if (url.startsWith("file://")) {
			const cleanPath = fileURLToPath(url.split("?")[0]);
			if (cleanPath.endsWith(".ts") || cleanPath.endsWith(".tsx")) {
				const src = fs.readFileSync(cleanPath, "utf8");
				const out = ts.transpileModule(src, {
					compilerOptions: {
						target: ts.ScriptTarget.ES2022,
						module: ts.ModuleKind.ESNext,
						jsx: ts.JsxEmit.ReactJSX,
					},
					fileName: cleanPath,
				});
				return { shortCircuit: true, format: "module", source: out.outputText };
			}
		}
		return nextLoad(url, context);
	},
});
`;
}

function runHeadlessProbe(runnerBody, loaderOptions = {}) {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-probe-"));
	const loaderPath = path.join(tempDir, "loader.mjs");
	const runnerPath = path.join(tempDir, "runner.mjs");
	const sharedHeader = `
import assert from "node:assert/strict";
import { renderOnce, resetRuntime, runtime } from "react";

globalThis.__DEV__ = false;
globalThis.__probeStorage = new Map();
globalThis.__probeAlerts = [];
globalThis.__probeAppStateListeners = [];
globalThis.__probePermStatus = "granted";
globalThis.__probeOnline = true;
globalThis.__probeRouteParams = {};
globalThis.__probeOfflineFlower = async () => null;
globalThis.__probeSearchSpecies = async () => [];
globalThis.require = (id) => {
	if (id === "react-native-purchases") return { default: globalThis.__probePurchases };
	throw new Error("Unexpected require: " + id);
};
globalThis.__probePurchases = {
	configure: async () => {},
	getCustomerInfo: async () => ({ entitlements: { active: {} } }),
	getOfferings: async () => ({ current: null }),
	addCustomerInfoUpdateListener: () => {},
	removeCustomerInfoUpdateListener: () => true,
};

function findNodes(node, pred, out = []) {
	if (!node || typeof node !== "object") return out;
	if (Array.isArray(node)) {
		for (const item of node) findNodes(item, pred, out);
		return out;
	}
	if (pred(node)) out.push(node);
	if (node.props?.children) findNodes(node.props.children, pred, out);
	return out;
}

function textContent(node) {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textContent).join("");
	if (typeof node === "object" && node.props?.children !== undefined) {
		return textContent(node.props.children);
	}
	return "";
}

async function settle() {
	for (let i = 0; i < 15; i++) {
		await new Promise((r) => setTimeout(r, 15));
	}
}

delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
delete process.env.EXPO_PUBLIC_SCREENSHOT_MODE;
process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = "appl_test";
`;
	fs.writeFileSync(
		loaderPath,
		buildHeadlessRnLoaderCode(loaderOptions),
		"utf8",
	);
	fs.writeFileSync(runnerPath, `${sharedHeader}\n${runnerBody}`, "utf8");
	try {
		const res = spawnSync(
			process.execPath,
			["--import", loaderPath, runnerPath],
			{
				cwd: ROOT,
				encoding: "utf8",
				timeout: 30000,
			},
		);
		assert.equal(
			res.status,
			0,
			`Headless probe failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
		);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

describe("Tier 5 Adversarial Regression & Runtime Coverage", () => {
	// =========================================================================
	// Finding 1: Offline Cache Date Check (HomeScreen headless runtime)
	// =========================================================================
	it("F1: HomeScreen offline fallback enforces cached.date === date for Yesterday, Today, and matching cache hit", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T18:00:00Z");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};
			globalThis.fetch = async () => { throw new TypeError("Offline"); };
			globalThis.__probeOnline = false;
			globalThis.__probeOfflineFlower = async (region, date) => ({
				id: date === "2026-11-25" ? 10 : 20,
				region,
				common: date === "2026-11-25" ? "Yesterday Lupine" : "Today Iris",
				latin: date === "2026-11-25" ? "Lupinus nanus" : "Iris douglasiana",
				bloomMonths: [5],
				blurb: "Offline regional flower for " + date,
			});

			// 1A: Today cached -> offline tap Yesterday must show NOV 25 2026 & Yesterday Lupine
			globalThis.__probeStorage.set("dailyFlower.lastSuccess.v1", JSON.stringify({
				imageSource: { uri: "https://example.com/CA/2026-11-26.png" },
				common: "Cached Today Poppy",
				latin: "Eschscholzia californica",
				blurb: "Cached today",
				state: "CA",
				date: "2026-11-26",
			}));
			const { default: Home1 } = await import(${homeUrl} + "?f1=a");
			resetRuntime(Home1);
			renderOnce();
			await settle();
			const yesterdayBtns = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Yesterday"));
			assert.equal(yesterdayBtns.length, 1);
			yesterdayBtns[0].props.onPress();
			await settle();
			const eyebrows1A = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrows1A.some((t) => t.includes("CA · NOV 25 2026")), "Expected NOV 25 2026, got: " + eyebrows1A.join(", "));
			assert.equal(eyebrows1A.some((t) => t.includes("NOV 26 2026")), false);
			const allTexts1A = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts1A.includes("Yesterday Lupine"), "Expected offline DB flower Yesterday Lupine");
			assert.equal(allTexts1A.includes("Cached Today Poppy"), false);

			// 1B: Stale Yesterday cached -> offline Today (dayOffset=0) must show NOV 26 2026 & Today Iris
			globalThis.__probeStorage.clear();
			globalThis.__probeStorage.set("dailyFlower.lastSuccess.v1", JSON.stringify({
				imageSource: { uri: "https://example.com/CA/2026-11-25.png" },
				common: "Cached Yesterday Poppy",
				latin: "Eschscholzia californica",
				blurb: "Cached yesterday",
				state: "CA",
				date: "2026-11-25",
			}));
			const { default: Home2 } = await import(${homeUrl} + "?f1=b");
			resetRuntime(Home2);
			renderOnce();
			await settle();
			const eyebrows1B = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrows1B.some((t) => t.includes("CA · NOV 26 2026")), "Expected NOV 26 2026, got: " + eyebrows1B.join(", "));
			assert.equal(eyebrows1B.some((t) => t.includes("NOV 25 2026")), false);
			const allTexts1B = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts1B.includes("Today Iris"), "Expected offline DB flower Today Iris");
			assert.equal(allTexts1B.includes("Cached Yesterday Poppy"), false);

			// 1C: Matching date cache hit returns cached entry with OFFLINE · ARCHIVE badge
			globalThis.__probeStorage.clear();
			globalThis.__probeStorage.set("dailyFlower.lastSuccess.v1", JSON.stringify({
				imageSource: { uri: "https://example.com/CA/2026-11-26.png" },
				common: "Cached Today Match",
				latin: "Nemophila menziesii",
				blurb: "Exact date cache match",
				state: "CA",
				date: "2026-11-26",
			}));
			const { default: Home3 } = await import(${homeUrl} + "?f1=c");
			resetRuntime(Home3);
			renderOnce();
			await settle();
			const allTexts1C = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts1C.includes("Cached Today Match"));
			assert.ok(allTexts1C.includes("OFFLINE · ARCHIVE"));
		`);
	});

	// =========================================================================
	// Finding 2: Shell-Injection Isolation Across All 4 Scripts
	// =========================================================================
	it("F2: all 4 screenshot/squash scripts use execFileSync without execSync and isolate shell metacharacters", async () => {
		for (const rel of [
			"scripts/verify_screenshots.mjs",
			"scripts/capture_screenshots.mjs",
			"scripts/capture_screenshots_auto.mjs",
			"scripts/agent-squash-popups.mjs",
		]) {
			const src = readRepoFile(rel);
			assert.equal(
				/\bexecSync\b/.test(src),
				false,
				`${rel} must not use execSync`,
			);
			assert.match(
				src,
				/\bexecFileSync\b/,
				`${rel} must use execFileSync with argument arrays`,
			);
		}

		const { getImageInfo, performOCR, fixScreenshot } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const { resizeImage: manualResize } = await import(
			"../../scripts/capture_screenshots.mjs"
		);
		const { resizeImage: autoResize, postProcessScreenshot } = await import(
			"../../scripts/capture_screenshots_auto.mjs"
		);

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-sqli-"));
		const marker = path.join(tempDir, "pwned.marker");
		const relMarkerName = `t5-sqli-pwned-${process.pid}.marker`;
		const relMarkerInCwd = path.join(process.cwd(), relMarkerName);
		try {
			const advSubDir = path.join(tempDir, `dir $(touch ${relMarkerName}) 'q'`);
			fs.mkdirSync(advSubDir, { recursive: true });
			const advFileName = `iphone67 $(touch ${relMarkerName}) \`id\` 'q'.png`;
			const advPath = path.join(advSubDir, advFileName);
			const advDest = path.join(
				advSubDir,
				`out $(touch ${relMarkerName}) 'q'.png`,
			);

			const rgbaImg = new Jimp({
				width: 1290,
				height: 2796,
				color: 0xff000080,
			});
			fs.writeFileSync(advPath, await rgbaImg.getBuffer("image/png"));

			// 2A: verify_screenshots.mjs getImageInfo + performOCR + fixScreenshot
			const info = getImageInfo(advPath);
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.existsSync(relMarkerInCwd), false);
			if (process.platform === "darwin") {
				assert.equal(info.width, 1290);
				assert.equal(info.height, 2796);
				assert.equal(info.hasAlpha, true);
				assert.equal(info.format, "png");
			}

			performOCR(advPath);
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.existsSync(relMarkerInCwd), false);

			let sawHasAlpha = true;
			const fixRes = fixScreenshot(
				{
					filePath: advPath,
					relativePath: advFileName,
					fileInfo: {
						width: 1290,
						height: 2796,
						hasAlpha: true,
						format: "png",
						sizeBytes: fs.statSync(advPath).size,
					},
					issues: [],
				},
				advSubDir,
				{
					getImageInfoImpl: (p) => {
						const buf = fs.readFileSync(p);
						sawHasAlpha = buf[25] === 4 || buf[25] === 6;
						return {
							width: 1290,
							height: 2796,
							hasAlpha: sawHasAlpha,
							format: "png",
							sizeBytes: buf.length,
						};
					},
				},
			);
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.existsSync(relMarkerInCwd), false);
			assert.equal(fixRes.fixed, true);
			assert.equal(sawHasAlpha, false);

			// 2A-bis: fixScreenshot format conversion (.jpg -> .png) with adversarial filename
			const advJpgName = `iphone67 $(touch ${relMarkerName}) \`id\` 'q'.jpg`;
			const advJpgPath = path.join(advSubDir, advJpgName);
			fs.writeFileSync(advJpgPath, await rgbaImg.getBuffer("image/jpeg"));
			const convRes = fixScreenshot(
				{
					filePath: advJpgPath,
					relativePath: advJpgName,
					fileInfo: {
						width: 1290,
						height: 2796,
						hasAlpha: false,
						format: "jpeg",
						sizeBytes: fs.statSync(advJpgPath).size,
					},
					issues: [],
				},
				advSubDir,
				{
					getImageInfoImpl: (p) => ({
						width: 1290,
						height: 2796,
						hasAlpha: false,
						format: "png",
						sizeBytes: fs.statSync(p).size,
					}),
				},
			);
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.existsSync(relMarkerInCwd), false);
			if (process.platform === "darwin") {
				assert.equal(convRes.fixed, true);
			}

			// 2B: capture_screenshots.mjs & capture_screenshots_auto.mjs resizeImage + postProcessScreenshot
			for (const resizeFn of [manualResize, autoResize]) {
				const recorded = [];
				resizeFn(advPath, advDest, 1242, 2688, {
					runCommandImpl: () => "  pixelWidth: 1290\n  pixelHeight: 2796",
					execFileSyncImpl: (bin, args) => recorded.push([bin, args]),
				});
				assert.equal(fs.existsSync(marker), false);
				assert.equal(fs.existsSync(relMarkerInCwd), false);
				assert.deepEqual(recorded[0], [
					"sips",
					["-z", "2688", "1242", advPath, "--out", advDest],
				]);
			}

			if (process.platform === "darwin") {
				autoResize(advPath, advDest, 1242, 2688);
				assert.equal(fs.existsSync(marker), false);
				assert.equal(fs.existsSync(relMarkerInCwd), false);
				assert.equal(fs.existsSync(advDest), true);
			} else {
				fs.copyFileSync(advPath, advDest);
			}
			await postProcessScreenshot(advDest, "iphone67");
			assert.equal(fs.existsSync(marker), false);
			assert.equal(fs.existsSync(relMarkerInCwd), false);

			// 2C: agent-squash-popups.mjs subprocess with adversarial TMPDIR containing $(touch ...)
			const advTmpDir = path.join(tempDir, `tmp $(touch ${relMarkerName}) 'q'`);
			const fakeBinDir = path.join(tempDir, "bin");
			fs.mkdirSync(advTmpDir, { recursive: true });
			fs.mkdirSync(fakeBinDir, { recursive: true });

			const pngBuf = await new Jimp({
				width: 100,
				height: 200,
				color: 0x000000ff,
			}).getBuffer("image/png");
			const samplePngPath = path.join(tempDir, "sample.png");
			fs.writeFileSync(samplePngPath, pngBuf);

			const xcrunLog = path.join(tempDir, "xcrun.log");
			const maestroLog = path.join(tempDir, "maestro.log");
			const xcrunBin = path.join(fakeBinDir, "xcrun");
			const sipsBin = path.join(fakeBinDir, "sips");
			const maestroBin = path.join(fakeBinDir, "maestro");
			const preloadPath = path.join(tempDir, "preload.mjs");

			fs.writeFileSync(
				xcrunBin,
				`#!/bin/sh
echo "$@" >> ${JSON.stringify(xcrunLog)}
cp ${JSON.stringify(samplePngPath)} "$5"
`,
				{ mode: 0o755 },
			);
			fs.writeFileSync(
				sipsBin,
				`#!/bin/sh
printf "stub\\n  pixelWidth: 100\\n  pixelHeight: 200\\n"
`,
				{ mode: 0o755 },
			);
			fs.writeFileSync(
				maestroBin,
				`#!/bin/sh
echo "$@" >> ${JSON.stringify(maestroLog)}
`,
				{ mode: 0o755 },
			);
			fs.writeFileSync(
				preloadPath,
				`
let calls = 0;
globalThis.fetch = async () => {
	calls++;
	if (calls === 1) {
		return new Response(JSON.stringify({
			candidates: [{ content: { parts: [{ text: JSON.stringify({ hasPopup: true, x: 50, y: 100, reason: "Dismiss" }) }] } }],
		}), { status: 200 });
	}
	return new Response(JSON.stringify({
		candidates: [{ content: { parts: [{ text: JSON.stringify({ hasPopup: false }) }] } }],
	}), { status: 200 });
};
`,
				"utf8",
			);

			const res = spawnSync(
				process.execPath,
				[
					"--import",
					preloadPath,
					path.join(ROOT, "scripts/agent-squash-popups.mjs"),
				],
				{
					cwd: tempDir,
					env: {
						...process.env,
						TMPDIR: advTmpDir,
						PATH: `${fakeBinDir}:${process.env.PATH}`,
						GEMINI_API_KEY: "test_key",
					},
					encoding: "utf8",
					timeout: 15000,
				},
			);
			assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
			assert.equal(
				fs.existsSync(path.join(tempDir, relMarkerName)),
				false,
				"Adversarial TMPDIR must never execute $(touch marker)",
			);
			assert.equal(fs.existsSync(relMarkerInCwd), false);
			assert.equal(fs.existsSync(maestroLog), true);
		} finally {
			fs.rmSync(relMarkerInCwd, { force: true });
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// =========================================================================
	// Finding 3 & Finding 4: Modal Stacking + Concurrent Double-Submit & 0-Token Quota
	// =========================================================================
	it("F3 & F4: HomeScreen never stacks two visible modals and blocks concurrent double-submit & non-searchable quota burn", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			globalThis.fetch = async () => new Response(JSON.stringify({
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Orange bloom.",
				imageExt: "png",
			}), { status: 200 });

			let searchCalls = 0;
			let resolvePendingSearch = null;
			globalThis.__probeSearchSpecies = async (query) => {
				searchCalls++;
				if (resolvePendingSearch) {
					return await new Promise((resolve) => {
						resolvePendingSearch.push(() => resolve([{
							id: 1,
							region: "CA",
							common: "California Poppy",
							latin: "Eschscholzia californica",
							bloomMonths: [4, 5],
							blurb: "Poppy",
						}]));
					});
				}
				return [{
					id: 1,
					region: "CA",
					common: "California Poppy",
					latin: "Eschscholzia californica",
					bloomMonths: [4, 5],
					blurb: "Poppy (" + query + ")",
				}];
			};

			const modalTransitions = [];
			function recordModals(tree) {
				const modals = findNodes(tree, (n) => n.type === "Modal" || n.type === "PremiumModal");
				const visible = modals.filter((m) => Boolean(m.props?.visible));
				modalTransitions.push(visible.length);
				assert.ok(
					visible.length <= 1,
					"At most 1 modal may be visible simultaneously, found " + visible.length,
				);
			}

			const { default: Home } = await import(${homeUrl} + "?f34=1");
			resetRuntime(Home, recordModals);
			renderOnce();
			await settle();

			// Open Search modal
			const searchBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && n.props?.accessibilityLabel === "Search species")[0];
			searchBtn.props.onPress();
			await settle();

			// 4B: Punctuation-only, 1-char, and grammar-stopword queries must NOT call searchSpeciesVector or burn quota
			for (const badQuery of ["!!!", "b", "the and"]) {
				const input = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
				assert.ok(input, "Search TextInput must enforce maxLength={200}");
				input.props.onChangeText(badQuery);
				await settle();
				const input2 = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
				await input2.props.onSubmitEditing();
				await settle();
			}
			assert.equal(searchCalls, 0, "Non-searchable queries must not execute searchSpeciesVector");
			assert.equal(globalThis.__probeStorage.get("specimen_sandbox_search_count"), "0", "Non-searchable queries must not burn quota");
			const hintTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(hintTexts.some((t) => t.includes("Enter at least 2 characters")), "Should display gentle helper feedback");

			// 4A: Concurrent double-submit on TextInput.onSubmitEditing burns at most 1 quota credit
			resolvePendingSearch = [];
			const inputValid = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			inputValid.props.onChangeText("poppy");
			await settle();
			const inputSubmit = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			const p1 = inputSubmit.props.onSubmitEditing();
			const p2 = inputSubmit.props.onSubmitEditing();
			await new Promise((r) => setTimeout(r, 20));
			assert.equal(searchCalls, 1, "Concurrent onSubmitEditing must lock re-entrancy via useRef");
			while (resolvePendingSearch.length > 0) resolvePendingSearch.shift()();
			await Promise.all([p1, p2]);
			await settle();
			assert.equal(globalThis.__probeStorage.get("specimen_sandbox_search_count"), "1", "Concurrent submit must burn only 1 quota credit");

			// Exhaust remaining 2 free searches (total 3)
			resolvePendingSearch = null;
			for (let i = 0; i < 2; i++) {
				const inp = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
				await inp.props.onSubmitEditing();
				await settle();
			}
			assert.equal(globalThis.__probeStorage.get("specimen_sandbox_search_count"), "3");

			// 3A: Tap UNLOCK UNLIMITED SEARCH -> closes Search modal before opening PremiumModal
			const unlockBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK UNLIMITED SEARCH"))[0];
			assert.ok(unlockBtn);
			unlockBtn.props.onPress();
			await settle();
			const modalsAfterUnlock = findNodes(runtime.currentTree, (n) => n.type === "Modal" || n.type === "PremiumModal");
			assert.equal(modalsAfterUnlock.filter((m) => m.type === "Modal" && m.props?.visible).length, 0);
			assert.equal(modalsAfterUnlock.filter((m) => m.type === "PremiumModal" && m.props?.visible).length, 1);

			// Close PremiumModal, re-open Search modal, submit 4th search -> closes Search modal before opening PremiumModal
			const premModal = modalsAfterUnlock.find((m) => m.type === "PremiumModal");
			premModal.props.onClose();
			await settle();
			const searchBtn2 = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && n.props?.accessibilityLabel === "Search species")[0];
			searchBtn2.props.onPress();
			await settle();
			const inp4 = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			await inp4.props.onSubmitEditing();
			await settle();
			const modalsAfter4th = findNodes(runtime.currentTree, (n) => n.type === "Modal" || n.type === "PremiumModal");
			assert.equal(modalsAfter4th.filter((m) => m.type === "Modal" && m.props?.visible).length, 0);
			assert.equal(modalsAfter4th.filter((m) => m.type === "PremiumModal" && m.props?.visible).length, 1);
			assert.ok(modalTransitions.every((c) => c <= 1));
		`);
	});

	// =========================================================================
	// Finding 5: lib/speciesDb.ts Length/Token Caps & < 2 Char Guard
	// =========================================================================
	it("F5: lib/speciesDb.ts rejects 1-char non-stopwords and clamps queries at 200 chars / 16 tokens on Native & Web", async () => {
		for (const platform of ["ios", "web"]) {
			const ctx = createE2EContext({ platform });
			try {
				const dbMod = await ctx.importFresh("lib/speciesDb.ts");
				assert.equal(dbMod.MAX_QUERY_CHARS, 200);
				assert.equal(dbMod.MAX_QUERY_TOKENS, 16);

				// 1-char non-stopword
				assert.deepEqual(await dbMod.searchSpecies("b"), []);
				assert.deepEqual(await dbMod.searchSpecies(" z "), []);

				// 10,000-char query where "poppy" is strictly beyond char 200
				const prefix220 = "zzzzz ".repeat(40); // 240 chars
				const over10k = `${prefix220}${"x ".repeat(4900)}poppy`;
				assert.ok(over10k.length > 10000);
				assert.deepEqual(
					await dbMod.searchSpecies(over10k),
					[],
					`${platform}: target token after char 200 must be ignored`,
				);

				// Under 200 chars, > 16 distinct tokens where "poppy" is token #17
				const sixteenTokens = Array.from(
					{ length: 16 },
					(_, i) => `q${String(i).padStart(2, "0")}`,
				).join(" ");
				const over16Tokens = `${sixteenTokens} poppy`;
				assert.ok(over16Tokens.length < 200);
				assert.equal(dbMod.sanitizeFtsTokens(over16Tokens).length, 16);
				assert.deepEqual(
					await dbMod.searchSpecies(over16Tokens),
					[],
					`${platform}: target token #17 must be ignored by MAX_QUERY_TOKENS=16`,
				);

				// Eligibility helper checks
				assert.equal(dbMod.isSearchQueryEligible("!!!"), false);
				assert.equal(dbMod.isSearchQueryEligible("b"), false);
				assert.equal(dbMod.isSearchQueryEligible("the and"), false);
				assert.equal(dbMod.isSearchQueryEligible("poppy"), true);
			} finally {
				ctx.cleanup();
			}
		}
	});

	// =========================================================================
	// Finding 6: agent-squash-popups.mjs Safety-Blocked & Coordinate Validation
	// =========================================================================
	it("F6: agent-squash-popups.mjs guards empty/safety-blocked Gemini responses and validates/clamps coordinates", async () => {
		const { analyzeScreenshot, buildTapFlowYaml, computeTapPercentages } =
			await import("../../scripts/agent-squash-popups.mjs");

		for (const payload of [
			{ candidates: [{ finishReason: "SAFETY" }] },
			{ candidates: [] },
			{},
		]) {
			await assert.rejects(
				() =>
					analyzeScreenshot("test-key", "abc", {
						sleepImpl: async () => {},
						fetchImpl: async () =>
							new Response(JSON.stringify(payload), { status: 200 }),
					}),
				(err) =>
					err instanceof Error &&
					!(err instanceof TypeError) &&
					/No text in Gemini response/i.test(err.message),
			);
		}

		assert.throws(
			() => computeTapPercentages(Number.NaN, 100, 1242, 2688),
			/Invalid popup coordinates/,
		);
		assert.throws(
			() => computeTapPercentages(100, Number.POSITIVE_INFINITY, 1242, 2688),
			/Invalid popup coordinates/,
		);
		assert.throws(
			() => computeTapPercentages(undefined, 100, 1242, 2688),
			/Invalid popup coordinates/,
		);
		assert.deepEqual(computeTapPercentages(-50, 9999, 100, 200), {
			xPct: 0,
			yPct: 100,
		});
		assert.throws(() => buildTapFlowYaml(Number.NaN, 50), /Invalid tap/);
		assert.match(buildTapFlowYaml(-10, 150), /point: 0%, 100%/);
	});

	// =========================================================================
	// Finding 7: AppState Foreground Midnight Rollover (HomeScreen headless runtime)
	// =========================================================================
	it("F7: HomeScreen AppState('active') reloads today's flower across midnight rollover", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			let currentMs = RealDate.parse("2026-11-26T23:59:00");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [currentMs])); }
				static now() { return currentMs; }
			};

			const fetchedDates = [];
			globalThis.fetch = async (url) => {
				const m = String(url).match(/\\/daily\\/[^/]+\\/(\\d{4}-\\d{2}-\\d{2})\\.json$/);
				if (m) fetchedDates.push(m[1]);
				const d = m ? m[1] : "unknown";
				return new Response(JSON.stringify({
					common: "Flower " + d,
					latin: "Rosa " + d,
					blurb: "Note " + d,
					imageExt: "png",
				}), { status: 200 });
			};

			const { default: Home } = await import(${homeUrl} + "?f7=1");
			resetRuntime(Home);
			renderOnce();
			await settle();
			assert.deepEqual(fetchedDates, ["2026-11-26"]);

			// Same day foreground event should NOT re-fetch daily flower
			assert.ok(globalThis.__probeAppStateListeners.length >= 1);
			for (const cb of [...globalThis.__probeAppStateListeners]) cb("active");
			await settle();
			assert.deepEqual(fetchedDates, ["2026-11-26"]);

			// Midnight rollover -> AppState("active") MUST reload 2026-11-27
			currentMs = RealDate.parse("2026-11-27T08:00:00");
			for (const cb of [...globalThis.__probeAppStateListeners]) cb("active");
			await settle();
			assert.deepEqual(fetchedDates, ["2026-11-26", "2026-11-27"]);
			const eyebrows = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrows.some((t) => t.includes("CA · NOV 27 2026")), "Expected NOV 27 2026 after midnight rollover, got: " + eyebrows.join(", "));

			// Viewing Yesterday (dayOffset === -1) across midnight must NOT force-reset away from Yesterday
			const yestBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Yesterday"))[0];
			yestBtn.props.onPress();
			await settle();
			assert.deepEqual(fetchedDates, ["2026-11-26", "2026-11-27", "2026-11-26"]);
			currentMs = RealDate.parse("2026-11-28T08:00:00");
			for (const cb of [...globalThis.__probeAppStateListeners]) cb("active");
			await settle();
			assert.deepEqual(fetchedDates, ["2026-11-26", "2026-11-27", "2026-11-26"]);
		`);
	});

	// =========================================================================
	// Finding 8: Headless FlowerDetailScreen Runtime Render + CI Full Suite
	// =========================================================================
	it("F8: FlowerDetailScreen renders search specimen without poppy and handles .png -> .jpg -> specimen fallback on double onError", () => {
		const detailUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/flower-detail.tsx")).href,
		);
		runHeadlessProbe(`
			// 8A: Search specimen with empty imageUri renders specimen placeholder with 0 poppy Images
			globalThis.__probeRouteParams = {
				imageUri: "",
				source: "search",
				isPlaceholder: "1",
				common: "Desert Marigold",
				latin: "Baileya multiradiata",
				blurb: "Yellow desert wildflower.",
				bloomMonths: "[4,5,6]",
				state: "AZ",
				date: "2026-11-26",
			};
			const { default: DetailA } = await import(${detailUrl} + "?f8=a");
			resetRuntime(DetailA);
			renderOnce();
			const imagesA = findNodes(runtime.currentTree, (n) => n.type === "Image");
			assert.equal(imagesA.length, 0, "Search specimen must not render California Poppy <Image>");
			const textsA = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(textsA.includes("NO PHOTO CACHED · SPECIMEN"));
			assert.ok(textsA.includes("Desert Marigold"));
			assert.ok(textsA.includes("Baileya multiradiata"));

			// 8B: Remote non-poppy .png -> onError swaps to .jpg -> second onError falls back to specimen placeholder
			globalThis.__probeRouteParams = {
				imageUri: "https://example.com/daily/TX/2026-11-18.png",
				source: "daily",
				isPlaceholder: "0",
				common: "Texas Bluebonnet",
				latin: "Lupinus texensis",
				blurb: "Blue spring wildflower.",
				bloomMonths: "[3,4]",
				state: "TX",
				date: "2026-11-18",
			};
			const { default: DetailB } = await import(${detailUrl} + "?f8=b");
			resetRuntime(DetailB);
			renderOnce();
			let img = findNodes(runtime.currentTree, (n) => n.type === "Image")[0];
			assert.equal(img.props.source.uri, "https://example.com/daily/TX/2026-11-18.png");

			img.props.onError();
			await settle();
			img = findNodes(runtime.currentTree, (n) => n.type === "Image")[0];
			assert.equal(img.props.source.uri, "https://example.com/daily/TX/2026-11-18.jpg");

			img.props.onError();
			await settle();
			assert.equal(findNodes(runtime.currentTree, (n) => n.type === "Image").length, 0);
			const textsB = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(textsB.includes("NO PHOTO CACHED · SPECIMEN"));
		`);

		const ciYml = readRepoFile(".github/workflows/ci.yml");
		assert.match(
			ciYml,
			/^\s*run:\s*pnpm test\s*$/m,
			".github/workflows/ci.yml must run pnpm test (covering both unit and e2e suites)",
		);
	});

	// =========================================================================
	// Finding 9: 3rd Free Search Keeps Results Visible (HomeScreen headless)
	// =========================================================================
	it("F9: 3rd free search keeps its own results visible and tappable; closing/reopening or 4th search shows lock/PremiumModal", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			globalThis.__probeRouterPushes = [];
			globalThis.fetch = async () => new Response(JSON.stringify({
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Orange bloom.",
				imageExt: "png",
			}), { status: 200 });

			globalThis.__probeSearchSpecies = async (query) => [{
				id: query.length * 100 + 1,
				region: "CA",
				common: "Specimen-" + query,
				latin: "Genus " + query,
				bloomMonths: [4, 5],
				blurb: "Matched " + query,
			}];

			const modalTransitions = [];
			function recordModals(tree) {
				const modals = findNodes(tree, (n) => n.type === "Modal" || n.type === "PremiumModal");
				const visible = modals.filter((m) => Boolean(m.props?.visible));
				modalTransitions.push(visible.length);
				assert.ok(visible.length <= 1, "At most 1 modal visible, got " + visible.length);
			}

			const { default: Home } = await import(${homeUrl} + "?f9=1");
			resetRuntime(Home, recordModals);
			renderOnce();
			await settle();

			const openSearch = () => {
				const btn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && n.props?.accessibilityLabel === "Search species")[0];
				assert.ok(btn, "Search species button must exist");
				btn.props.onPress();
			};

			openSearch();
			await settle();

			// Run 3 consecutive searches: poppy, iris, lupine
			const terms = ["poppy", "iris", "lupine"];
			for (let i = 0; i < terms.length; i++) {
				const term = terms[i];
				const inp = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
				inp.props.onChangeText(term);
				await settle();
				const inp2 = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
				await inp2.props.onSubmitEditing();
				await settle();

				const allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
				const showsResult = allTexts.includes("Specimen-" + term);
				const showsLock = allTexts.includes("Search Limit Reached");
				assert.equal(showsResult, true, "Search #" + (i + 1) + " (" + term + ") must keep results visible");
				assert.equal(showsLock, false, "Search #" + (i + 1) + " (" + term + ") must not replace results with lock screen");
				assert.equal(globalThis.__probeStorage.get("specimen_sandbox_search_count"), String(i + 1));
			}

			// Verify 3rd search result is tappable and routes to /flower-detail
			const lupineRow = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Specimen-lupine"))[0];
			assert.ok(lupineRow, "3rd search result row must be present and tappable");
			lupineRow.props.onPress();
			await settle();
			assert.equal(globalThis.__probeRouterPushes.length, 1);
			assert.equal(globalThis.__probeRouterPushes[0].pathname, "/flower-detail");
			assert.equal(globalThis.__probeRouterPushes[0].params.common, "Specimen-lupine");

			// Reopening Search with 0 quota and empty results shows "Search Limit Reached"
			openSearch();
			await settle();
			const reopenTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(reopenTexts.includes("Search Limit Reached"), "Reopening Search at 0 quota must show Search Limit Reached");

			// Submitting a 4th search closes Search and opens PremiumModal
			const inp4 = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			inp4.props.onChangeText("daisy");
			await settle();
			const inp4Submit = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			await inp4Submit.props.onSubmitEditing();
			await settle();
			const modalsAfter4th = findNodes(runtime.currentTree, (n) => n.type === "Modal" || n.type === "PremiumModal");
			assert.equal(modalsAfter4th.filter((m) => m.type === "Modal" && m.props?.visible).length, 0);
			assert.equal(modalsAfter4th.filter((m) => m.type === "PremiumModal" && m.props?.visible).length, 1);

			// Dismiss PremiumModal, reset to 1 search remaining via direct 4th search while Search #3 results are on screen
			modalsAfter4th.find((m) => m.type === "PremiumModal").props.onClose();
			await settle();
			globalThis.__probeStorage.set("specimen_sandbox_search_count", "2");
			openSearch();
			await settle();
			const inpLast = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			inpLast.props.onChangeText("lupine");
			await settle();
			await findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0].props.onSubmitEditing();
			await settle();
			assert.ok(findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent).includes("Specimen-lupine"));
			// Submit 4th search directly while Search #3 results are visible -> closes Search and opens PremiumModal
			const inpDirect4 = findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0];
			inpDirect4.props.onChangeText("daisy");
			await settle();
			await findNodes(runtime.currentTree, (n) => n.type === "TextInput" && n.props?.maxLength === 200)[0].props.onSubmitEditing();
			await settle();
			const modalsDirect4 = findNodes(runtime.currentTree, (n) => n.type === "Modal" || n.type === "PremiumModal");
			assert.equal(modalsDirect4.filter((m) => m.type === "Modal" && m.props?.visible).length, 0);
			assert.equal(modalsDirect4.filter((m) => m.type === "PremiumModal" && m.props?.visible).length, 1);
			assert.ok(modalTransitions.every((c) => c <= 1));
		`);
	});

	// =========================================================================
	// Finding 10: fixScreenshot Uppercase .JPG / .JPEG Extension Stripping
	// =========================================================================
	it("F10: fixScreenshot strips uppercase .JPG/.JPEG extensions cleanly without emitting *.JPG.png", async () => {
		const { fixScreenshot } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "t5-upper-ext-"));
		try {
			const img = new Jimp({
				width: 1290,
				height: 2796,
				color: 0x112233ff,
			});
			const jpgBuf = await img.getBuffer("image/jpeg");
			const pngBuf = await img.getBuffer("image/png");

			// Cross-platform deterministic mock test for .JPG
			const jpgPath = path.join(tempDir, "iphone67.JPG");
			fs.writeFileSync(jpgPath, jpgBuf);
			const analysisJpg = {
				filePath: jpgPath,
				relativePath: "iphone67.JPG",
				fileInfo: {
					width: 1290,
					height: 2796,
					hasAlpha: false,
					format: "jpeg",
					sizeBytes: jpgBuf.length,
				},
				issues: [],
			};
			const resJpg = fixScreenshot(analysisJpg, tempDir, {
				runCommandImpl: (bin, args) => {
					if (bin === "which") return null;
					const outIdx = args.indexOf("--out");
					if (outIdx !== -1 && args[outIdx + 1]) {
						fs.writeFileSync(args[outIdx + 1], pngBuf);
					}
					return "";
				},
				getImageInfoImpl: (p) => ({
					width: 1290,
					height: 2796,
					hasAlpha: false,
					format: "png",
					sizeBytes: fs.statSync(p).size,
				}),
			});
			assert.equal(resJpg.fixed, true);
			assert.equal(path.basename(analysisJpg.filePath), "iphone67.png");
			assert.equal(analysisJpg.relativePath, "iphone67.png");
			assert.equal(fs.existsSync(path.join(tempDir, "iphone67.png")), true);
			assert.equal(
				fs.existsSync(path.join(tempDir, "iphone67.JPG.png")),
				false,
			);
			assert.equal(fs.existsSync(jpgPath), false);

			// Real sips verification on macOS for .JPEG
			if (process.platform === "darwin") {
				const jpegPath = path.join(tempDir, "iphone65.JPEG");
				fs.writeFileSync(jpegPath, jpgBuf);
				const analysisJpeg = {
					filePath: jpegPath,
					relativePath: "iphone65.JPEG",
					fileInfo: {
						width: 1290,
						height: 2796,
						hasAlpha: false,
						format: "jpeg",
						sizeBytes: jpgBuf.length,
					},
					issues: [],
				};
				const resJpeg = fixScreenshot(analysisJpeg, tempDir);
				assert.equal(resJpeg.fixed, true);
				assert.equal(path.basename(analysisJpeg.filePath), "iphone65.png");
				assert.equal(fs.existsSync(path.join(tempDir, "iphone65.png")), true);
				assert.equal(
					fs.existsSync(path.join(tempDir, "iphone65.JPEG.png")),
					false,
				);
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	// =========================================================================
	// Finding 11: handleUpdateLocation() UI/Storage Region Consistency on Revoked Permission
	// =========================================================================
	it("F11: handleUpdateLocation() reloads Today to YOUR AREA (default) when permission is revoked without an override", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T18:00:00Z");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};

			const fetchedUrls = [];
			globalThis.fetch = async (url) => {
				fetchedUrls.push(String(url));
				const m = String(url).match(/\\/daily\\/([^/]+)\\/([^/]+)\\.json$/);
				const region = m ? m[1] : "default";
				return new Response(JSON.stringify({
					common: region + " Flower",
					latin: "Rosa " + region,
					blurb: "Note for " + region,
					imageExt: "png",
				}), { status: 200 });
			};

			globalThis.__probeStorage.set("region.state.v1", "CA");
			globalThis.__probePermStatus = "granted";

			const { default: Home } = await import(${homeUrl} + "?f11=1");
			resetRuntime(Home);
			renderOnce();
			await settle();

			const initialEyebrows = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(initialEyebrows.some((t) => t === "CA · NOV 26 2026"), "Expected CA · NOV 26 2026, got: " + initialEyebrows.join(", "));
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "CA");

			// Revoke OS location permission and tap "Update location" (no Travel Mode override active)
			globalThis.__probePermStatus = "denied";
			fetchedUrls.length = 0;
			globalThis.__probeAlerts.length = 0;

			const updateBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"))[0];
			assert.ok(updateBtn, "Update location button must be present on Today");
			await updateBtn.props.onPress();
			await settle();

			assert.equal(globalThis.__probeAlerts.length, 1);
			assert.equal(globalThis.__probeAlerts[0].title, "Location access is off");
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default");
			assert.ok(fetchedUrls.some((u) => u.includes("/daily/default/2026-11-26.json")), "Must reload Today for default region when UI was showing CA");

			const eyebrowsAfterUpdate = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrowsAfterUpdate.some((t) => t === "YOUR AREA · NOV 26 2026"), "Expected YOUR AREA · NOV 26 2026 after update, got: " + eyebrowsAfterUpdate.join(", "));
			assert.equal(eyebrowsAfterUpdate.some((t) => t.startsWith("CA ·")), false, "Stale CA eyebrow must not remain after permission revocation");

			// Tapping Yesterday stays consistent with YOUR AREA (default), no CA -> YOUR AREA jump
			fetchedUrls.length = 0;
			const yesterdayBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Yesterday"))[0];
			assert.ok(yesterdayBtn);
			yesterdayBtn.props.onPress();
			await settle();

			assert.ok(fetchedUrls.some((u) => u.includes("/daily/default/2026-11-25.json")));
			const eyebrowsYesterday = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrowsYesterday.some((t) => t === "YOUR AREA · NOV 25 2026"), "Expected YOUR AREA · NOV 25 2026, got: " + eyebrowsYesterday.join(", "));

			// Return to Today (already on YOUR AREA / default) and tap Update location again -> no extra fetch
			const todayBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Today"))[0];
			assert.ok(todayBtn);
			todayBtn.props.onPress();
			await settle();

			fetchedUrls.length = 0;
			globalThis.__probeAlerts.length = 0;
			const updateBtnAgain = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"))[0];
			assert.ok(updateBtnAgain);
			await updateBtnAgain.props.onPress();
			await settle();
			assert.equal(globalThis.__probeAlerts.length, 1);
			assert.equal(fetchedUrls.length, 0, "Already on YOUR AREA (default) without override must not trigger extra reload");
		`);
	});

	// =========================================================================
	// Finding 12: provinceNameToCode() & stateNameToCode() Diacritics Normalization
	// =========================================================================
	it("F12: getRegionWithStatus() normalizes diacritics so Quebec/Québec resolves to CA-QC", async () => {
		const ctx = createE2EContext({
			locationPermission: "granted",
			locationPlaces: [{ isoCountryCode: "CA", region: "Québec" }],
		});
		try {
			const regionMod = await ctx.importFresh("lib/region.ts");
			const qcResult = await regionMod.getRegionWithStatus();
			assert.deepEqual(qcResult, {
				region: "CA-QC",
				permissionDenied: false,
			});
			assert.equal(ctx.asyncStorage.get("region.state.v1"), "CA-QC");

			// NFD decomposed form with whitespace
			await regionMod.resetRegion();
			ctx.location.places = [
				{ isoCountryCode: "CA", region: "  Que\u0301bec  " },
			];
			const qcNfdResult = await regionMod.getRegionWithStatus();
			assert.deepEqual(qcNfdResult, {
				region: "CA-QC",
				permissionDenied: false,
			});

			// Symmetry for stateNameToCode()
			await regionMod.resetRegion();
			ctx.location.places = [{ isoCountryCode: "US", region: "Califórnia" }];
			const usAccentedResult = await regionMod.getRegionWithStatus();
			assert.deepEqual(usAccentedResult, {
				region: "CA",
				permissionDenied: false,
			});
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Finding 13: handleUpdateLocation() While state.status === "loading"
	// =========================================================================
	it("F13: handleUpdateLocation() cancels stale in-flight CA load when permission is revoked while loading", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T18:00:00Z");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};

			let releaseCaFetch = null;
			let caFetchCount = 0;
			let defaultFetchCount = 0;
			globalThis.fetch = async (url) => {
				const u = String(url);
				if (u.includes("/daily/CA/")) {
					caFetchCount++;
					await new Promise((resolve) => {
						releaseCaFetch = resolve;
					});
					return new Response(JSON.stringify({
						common: "CA Poppy",
						latin: "Eschscholzia californica",
						blurb: "Stale CA response",
						imageExt: "png",
					}), { status: 200 });
				}
				defaultFetchCount++;
				return new Response(JSON.stringify({
					common: "Default Flower",
					latin: "Rosa defaultus",
					blurb: "Default response",
					imageExt: "png",
				}), { status: 200 });
			};

			globalThis.__probeStorage.set("region.state.v1", "CA");
			globalThis.__probePermStatus = "granted";

			const { default: Home } = await import(${homeUrl} + "?f13=1");
			resetRuntime(Home);
			renderOnce();
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}

			// Confirm CA fetch is still in flight (state.status === "loading")
			assert.equal(caFetchCount, 1);
			assert.equal(typeof releaseCaFetch, "function");
			const loadingLabels = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(loadingLabels.some((t) => t.includes("FINDING TODAY")));

			// Flip permission to denied and tap "Update location" before CA fetch settles
			globalThis.__probePermStatus = "denied";
			const updateBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"))[0];
			assert.ok(updateBtn, "Update location button must be present while loading");
			await updateBtn.props.onPress();
			await settle();

			assert.equal(globalThis.__probeAlerts.length, 1);
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default");
			assert.ok(defaultFetchCount >= 1, "Must fetch default region while loading CA");

			// Release the deferred CA fetch and verify it does NOT overwrite the UI
			releaseCaFetch();
			await settle();

			const eyebrows = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrows.some((t) => t === "YOUR AREA · NOV 26 2026"), "Expected YOUR AREA · NOV 26 2026, got: " + eyebrows.join(", "));
			assert.equal(eyebrows.some((t) => t.startsWith("CA ·")), false, "Stale CA eyebrow must not overwrite UI");
			const allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts.includes("Default Flower"), "Default Flower must remain displayed");
			assert.equal(allTexts.includes("CA Poppy"), false, "Stale CA flower must not overwrite UI");
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default");
		`);
	});

	// =========================================================================
	// Finding 14: devMenuVisible Reset on !__DEV__ Entitlement Revocation Without Override
	// =========================================================================
	it("F14: revoking !__DEV__ premium without an active override closes Travel Mode and prevents reopening on re-subscription", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T18:00:00Z");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};

			globalThis.fetch = async () => new Response(JSON.stringify({
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Poppy",
				imageExt: "png",
			}), { status: 200 });

			let rcListener = null;
			let activeEnts = { premium: { isActive: true } };
			globalThis.__probePurchases = {
				configure: async () => {},
				getCustomerInfo: async () => ({ entitlements: { active: activeEnts } }),
				getOfferings: async () => ({ current: null }),
				addCustomerInfoUpdateListener: (cb) => { rcListener = cb; },
				removeCustomerInfoUpdateListener: () => { rcListener = null; return true; },
			};

			const { default: Home } = await import(${homeUrl} + "?f14=1");
			resetRuntime(Home);
			renderOnce();
			await settle();

			assert.equal(typeof rcListener, "function", "RevenueCat listener must be registered");
			assert.equal(globalThis.__probeStorage.get("region.override.v1"), undefined);

			function getTravelModal() {
				const modals = findNodes(runtime.currentTree, (n) => n.type === "Modal" && textContent(n).includes("Travel Mode"));
				assert.equal(modals.length, 1, "Expected 1 Travel Mode modal");
				return modals[0];
			}

			// Open Travel Mode with no active override
			const travelBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Travel Mode"))[0];
			assert.ok(travelBtn);
			travelBtn.props.onPress();
			await settle();
			assert.equal(getTravelModal().props.visible, true, "Travel Mode modal must open for premium user");

			// Revoke premium via rcListener without an active override
			activeEnts = {};
			rcListener({ entitlements: { active: {} } });
			await settle();
			assert.equal(getTravelModal().props.visible, false, "Travel Mode modal must close on revocation");

			// Re-subscribe via rcListener -> Travel Mode modal must stay closed
			activeEnts = { premium: { isActive: true } };
			rcListener({ entitlements: { active: { premium: { isActive: true } } } });
			await settle();
			assert.equal(getTravelModal().props.visible, false, "Travel Mode modal must remain closed after re-subscribing");

			// Also verify loadPremiumData foreground check resets devMenuVisible when no override exists
			const travelBtn2 = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Travel Mode"))[0];
			travelBtn2.props.onPress();
			await settle();
			assert.equal(getTravelModal().props.visible, true);

			activeEnts = {};
			for (const cb of globalThis.__probeAppStateListeners) {
				cb("active");
			}
			await settle();
			assert.equal(getTravelModal().props.visible, false);

			activeEnts = { premium: { isActive: true } };
			rcListener({ entitlements: { active: { premium: { isActive: true } } } });
			await settle();
			assert.equal(getTravelModal().props.visible, false, "Travel Mode modal must remain closed after loadPremiumData revocation + re-subscription");
		`);
	});

	// =========================================================================
	// Finding 15: PremiumModal Stale selectedPackageId on Offerings Reload Fail
	// =========================================================================
	it("F15: PremiumModal clears selectedPackageId and disables UNLOCK PASS when offerings return empty or fail on reopen", () => {
		const modalUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "shared/components/PremiumModal.tsx")).href,
		);
		// 15A & 15B: Real lib/purchases.ts with Purchases.getOfferings() returning { current: null } and throwing
		runHeadlessProbe(`
			const validOfferings = {
				current: {
					availablePackages: [
						{
							identifier: "$rc_monthly",
							packageType: "MONTHLY",
							product: {
								title: "Monthly Pass",
								description: "Monthly plan",
								priceString: "$4.99",
								price: 4.99,
							},
						},
						{
							identifier: "$rc_lifetime",
							packageType: "LIFETIME",
							product: {
								title: "Founders Lifetime",
								description: "One-time access",
								priceString: "$99.99",
								price: 99.99,
							},
						},
					],
				},
			};
			let offeringsMode = "valid";
			const purchasePackageCalls = [];
			globalThis.__probePurchases = {
				configure: async () => {},
				getCustomerInfo: async () => ({ entitlements: { active: {} } }),
				getOfferings: async () => {
					if (offeringsMode === "empty") return { current: null };
					if (offeringsMode === "throw") throw new Error("RC offerings outage");
					return validOfferings;
				},
				purchasePackage: async (pkg) => {
					purchasePackageCalls.push(pkg);
					return { customerInfo: { entitlements: { active: {} } } };
				},
				restorePurchases: async () => ({ entitlements: { active: {} } }),
				addCustomerInfoUpdateListener: () => {},
				removeCustomerInfoUpdateListener: () => true,
			};

			const { default: PremiumModal } = await import(${modalUrl} + "?f15=real");
			let props = { visible: true, onClose: () => {}, onSuccess: () => {} };
			resetRuntime(() => PremiumModal(props));
			renderOnce();
			await settle();

			function getUnlockBtn() {
				const btns = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"));
				assert.equal(btns.length, 1, "Expected UNLOCK PASS button");
				return btns[0];
			}
			function hasDisabledStyle(btn) {
				const stylesArr = Array.isArray(btn.props?.style) ? btn.props.style : [btn.props?.style];
				return stylesArr.some((s) => s && typeof s === "object" && s.opacity === 0.5);
			}

			// Select Lifetime package and confirm active selection + non-disabled button
			const lifetimeCard = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Founders Lifetime"))[0];
			assert.ok(lifetimeCard, "Founders Lifetime package card must render");
			lifetimeCard.props.onPress();
			await settle();

			let allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts.some((t) => t.includes("One-time non-consumable purchase")), "Lifetime selection must be active");
			assert.equal(getUnlockBtn().props.disabled, false);
			assert.equal(hasDisabledStyle(getUnlockBtn()), false);

			// 15A: Close and reopen with getOfferings() returning { current: null }
			props = { ...props, visible: false };
			renderOnce();
			await settle();

			offeringsMode = "empty";
			props = { ...props, visible: true };
			renderOnce();
			await settle();

			allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts.some((t) => t.includes("Retry")), "Retry button must appear when offerings are empty");
			assert.equal(allTexts.some((t) => t.includes("One-time non-consumable purchase")), false, "Stale lifetime selection must be cleared");
			const unlockEmpty = getUnlockBtn();
			assert.equal(unlockEmpty.props.disabled, true, "UNLOCK PASS must be disabled on empty offerings");
			assert.equal(hasDisabledStyle(unlockEmpty), true, "UNLOCK PASS must apply disabledBtn style on empty offerings");

			// Even if onPress handler is invoked directly, it must not call Purchases.purchasePackage or alert Purchase Error
			globalThis.__probeAlerts.length = 0;
			await unlockEmpty.props.onPress();
			await settle();
			assert.equal(purchasePackageCalls.length, 0);
			assert.equal(globalThis.__probeAlerts.some((a) => a.title === "Purchase Error"), false);

			// 15B: Recover offerings, re-select Lifetime, close, then reopen with getOfferings() throwing
			offeringsMode = "valid";
			props = { ...props, visible: false };
			renderOnce();
			await settle();
			props = { ...props, visible: true };
			renderOnce();
			await settle();
			const lifetimeCard2 = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Founders Lifetime"))[0];
			lifetimeCard2.props.onPress();
			await settle();
			assert.equal(getUnlockBtn().props.disabled, false);

			props = { ...props, visible: false };
			renderOnce();
			await settle();
			offeringsMode = "throw";
			props = { ...props, visible: true };
			renderOnce();
			await settle();

			const unlockThrow = getUnlockBtn();
			assert.equal(unlockThrow.props.disabled, true, "UNLOCK PASS must be disabled when getOfferings throws");
			assert.equal(hasDisabledStyle(unlockThrow), true, "UNLOCK PASS must apply disabledBtn style when getOfferings throws");
			globalThis.__probeAlerts.length = 0;
			await unlockThrow.props.onPress();
			await settle();
			assert.equal(purchasePackageCalls.length, 0);
			assert.equal(globalThis.__probeAlerts.some((a) => a.title === "Purchase Error"), false);
		`);

		// 15C: Direct getSubscriptionOfferings() rejection exercising PremiumModal's catch block
		runHeadlessProbe(
			`
			let shouldReject = false;
			const purchaseCalls = [];
			globalThis.__probeGetSubscriptionOfferings = async () => {
				if (shouldReject) throw new Error("Direct wrapper failure");
				return [
					{
						identifier: "$rc_lifetime",
						packageType: "LIFETIME",
						title: "Founders Lifetime",
						description: "Lifetime",
						priceString: "$99.99",
						price: 99.99,
					},
				];
			};
			globalThis.__probePurchasePackage = async (id) => {
				purchaseCalls.push(id);
				return true;
			};

			const { default: PremiumModal } = await import(${modalUrl} + "?f15=catch");
			let props = { visible: true, onClose: () => {}, onSuccess: () => {} };
			resetRuntime(() => PremiumModal(props));
			renderOnce();
			await settle();

			const unlockBefore = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"))[0];
			assert.equal(unlockBefore.props.disabled, false);

			props = { ...props, visible: false };
			renderOnce();
			await settle();
			shouldReject = true;
			props = { ...props, visible: true };
			renderOnce();
			await settle();

			const allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts.some((t) => t.includes("Retry")));
			assert.equal(allTexts.some((t) => t.includes("One-time non-consumable purchase")), false);
			const unlockAfter = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"))[0];
			assert.equal(unlockAfter.props.disabled, true);
			const stylesArr = Array.isArray(unlockAfter.props?.style) ? unlockAfter.props.style : [unlockAfter.props?.style];
			assert.equal(stylesArr.some((s) => s && typeof s === "object" && s.opacity === 0.5), true);

			globalThis.__probeAlerts.length = 0;
			await unlockAfter.props.onPress();
			await settle();
			assert.equal(purchaseCalls.length, 0);
			assert.equal(globalThis.__probeAlerts.some((a) => a.title === "Purchase Error"), false);
		`,
			{ mockPurchasesWrapper: true },
		);
	});

	// =========================================================================
	// Finding 16: resolveMXRegion() & resolveBRRegion() NFD Diacritic Normalization
	// =========================================================================
	it("F16: resolveMXRegion() and resolveBRRegion() normalize NFD diacritics and avoid Para/Parana/Paraiba collisions", async () => {
		const ctx = createE2EContext({
			locationPermission: "granted",
			locationPlaces: [{ isoCountryCode: "MX", region: "Nuevo Leo\u0301n" }],
		});
		try {
			const regionMod = await ctx.importFresh("lib/region.ts");
			const cases = [
				[{ isoCountryCode: "MX", region: "Nuevo Leo\u0301n" }, "MX-NLE"],
				[{ isoCountryCode: "MX", region: "Yucata\u0301n" }, "MX-YUC"],
				[{ isoCountryCode: "BR", region: "Parai\u0301ba" }, "BR-BA"],
				[{ isoCountryCode: "BR", region: "Para\u0301" }, "BR-AM"],
				[{ isoCountryCode: "BR", region: "Estado do Para\u0301" }, "BR-AM"],
				[{ isoCountryCode: "BR", region: "Parana\u0301" }, "BR-RS"],
				[{ isoCountryCode: "BR", region: "Rondo\u0302nia" }, "BR-AM"],
				[{ isoCountryCode: "BR", region: "Maranha\u0303o" }, "BR-BA"],
				[{ isoCountryCode: "BR", region: "Sa\u0303o Paulo" }, "BR-SP"],
			];

			for (const [place, expected] of cases) {
				await regionMod.resetRegion();
				ctx.location.places = [place];
				const res = await regionMod.getRegionWithStatus();
				assert.deepEqual(
					res,
					{ region: expected, permissionDenied: false },
					`Expected ${JSON.stringify(place)} to resolve to ${expected}, got ${res.region}`,
				);
			}
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Finding 17: First-Launch handleUpdateLocation() Race When prevPersistedRegion === null
	// =========================================================================
	it("F17: first-launch handleUpdateLocation() prevents deferred initial resolveRegion() from overwriting default with CA", () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T18:00:00Z");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};

			const fetchedUrls = [];
			globalThis.fetch = async (url) => {
				const u = String(url);
				fetchedUrls.push(u);
				const m = u.match(/\\/daily\\/([^/]+)\\/([^/]+)\\.json$/);
				const region = m ? m[1] : "default";
				return new Response(JSON.stringify({
					common: region + " Flower",
					latin: "Rosa " + region,
					blurb: "Note for " + region,
					imageExt: "png",
				}), { status: 200 });
			};

			let releaseGps = null;
			globalThis.__probePermStatus = "granted";
			globalThis.__probeGetPositionImpl = () =>
				new Promise((resolve) => {
					releaseGps = resolve;
				});

			// Fresh install: region.state.v1 is absent (empty AsyncStorage)
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), undefined);

			const { default: Home } = await import(${homeUrl} + "?f17=1");
			resetRuntime(Home);
			renderOnce();
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}

			// Initial resolveRegion() is paused awaiting GPS while state.status === "loading"
			assert.equal(typeof releaseGps, "function", "Initial load must be awaiting getCurrentPositionAsync");
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), undefined);
			const loadingTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(loadingTexts.some((t) => t.includes("FINDING TODAY")));

			// Flip permission to denied and tap "Update location"
			globalThis.__probePermStatus = "denied";
			const updateBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"))[0];
			assert.ok(updateBtn, "Update location button must be present on loading screen");
			await updateBtn.props.onPress();
			await settle();

			assert.equal(globalThis.__probeAlerts.length, 1);
			assert.equal(globalThis.__probeAlerts[0].title, "Location access is off");
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default");
			assert.ok(fetchedUrls.some((u) => u.includes("/daily/default/2026-11-26.json")));

			// Resolve the earlier deferred GPS call with CA coordinates
			releaseGps({ coords: { latitude: 37.77, longitude: -122.42 } });
			await settle();

			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default", "Stale resolveRegion() must not overwrite region.state.v1 with CA");
			assert.equal(fetchedUrls.some((u) => u.includes("/daily/CA/")), false, "Cancelled initial load must not fetch /daily/CA/");
			const eyebrows = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrows.some((t) => t === "YOUR AREA · NOV 26 2026"), "Expected YOUR AREA · NOV 26 2026, got: " + eyebrows.join(", "));
			assert.equal(eyebrows.some((t) => t.startsWith("CA ·")), false);
			const allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts.includes("default Flower"));
			assert.equal(allTexts.includes("CA Flower"), false);
		`);
	});

	// =========================================================================
	// Finding 18: handleUpdateLocation() While Loading With prevPersistedRegion === "default"
	// =========================================================================
	it("F18: handleUpdateLocation() cancels stale load when prevPersistedRegion === 'default' and getRegionWithStatus() does not return superseded CA", async () => {
		const homeUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "app/index.tsx")).href,
		);
		runHeadlessProbe(`
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T18:00:00Z");
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};

			const fetchedUrls = [];
			globalThis.fetch = async (url) => {
				const u = String(url);
				fetchedUrls.push(u);
				const m = u.match(/\\/daily\\/([^/]+)\\/([^/]+)\\.json$/);
				const region = m ? m[1] : "default";
				return new Response(JSON.stringify({
					common: region + " Flower",
					latin: "Rosa " + region,
					blurb: "Note for " + region,
					imageExt: "png",
				}), { status: 200 });
			};

			let releaseGps = null;
			globalThis.__probePermStatus = "granted";
			globalThis.__probeGetPositionImpl = () =>
				new Promise((resolve) => {
					releaseGps = resolve;
				});

			// Previously persisted fallback region "default" with newly granted permission
			globalThis.__probeStorage.set("region.state.v1", "default");

			const { default: Home } = await import(${homeUrl} + "?f18=1");
			resetRuntime(Home);
			renderOnce();
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}

			assert.equal(typeof releaseGps, "function", "Initial load must await getCurrentPositionAsync");
			const loadingTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(loadingTexts.some((t) => t.includes("FINDING TODAY")));

			// Revoke permission and tap "Update location" while still loading
			globalThis.__probePermStatus = "denied";
			const updateBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"))[0];
			assert.ok(updateBtn, "Update location button must be present while loading");
			await updateBtn.props.onPress();
			await settle();

			assert.equal(globalThis.__probeAlerts.length, 1);
			assert.equal(globalThis.__probeAlerts[0].title, "Location access is off");
			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default");
			assert.ok(fetchedUrls.some((u) => u.includes("/daily/default/2026-11-26.json")));

			// Release deferred GPS returning CA -> storage & UI must remain default / YOUR AREA
			releaseGps({ coords: { latitude: 37.77, longitude: -122.42 } });
			await settle();

			assert.equal(globalThis.__probeStorage.get("region.state.v1"), "default", "region.state.v1 must remain default");
			assert.equal(fetchedUrls.some((u) => u.includes("/daily/CA/")), false, "Cancelled initial load must not fetch /daily/CA/");
			const eyebrows = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
			assert.ok(eyebrows.some((t) => t === "YOUR AREA · NOV 26 2026"), "Expected YOUR AREA · NOV 26 2026, got: " + eyebrows.join(", "));
			assert.equal(eyebrows.some((t) => t.startsWith("CA ·")), false);
			const allTexts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(allTexts.includes("default Flower"));
			assert.equal(allTexts.includes("CA Flower"), false);
		`);

		// Direct unit verification of lib/region.ts epoch guard not returning superseded result
		const ctx = createE2EContext({
			locationPermission: "granted",
			locationPlaces: [{ isoCountryCode: "US", region: "CA" }],
		});
		try {
			ctx.asyncStorage.set("region.state.v1", "default");
			let releaseFirstPosition = null;
			let positionCalls = 0;
			ctx.location.getCurrentPositionAsync = () => {
				positionCalls += 1;
				if (positionCalls === 1) {
					return new Promise((resolve) => {
						releaseFirstPosition = resolve;
					});
				}
				return Promise.resolve({
					coords: { latitude: 37.77, longitude: -122.42 },
				});
			};
			const regionMod = await ctx.importFresh("lib/region.ts");
			const stalePromise = regionMod.getRegionWithStatus();
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.equal(positionCalls, 1);
			assert.equal(typeof releaseFirstPosition, "function");

			ctx.location.permissionStatus = "denied";
			await regionMod.resetRegion();
			const freshResult = await regionMod.getRegionWithStatus();
			assert.deepEqual(freshResult, {
				region: "default",
				permissionDenied: true,
			});

			releaseFirstPosition({ coords: { latitude: 37.77, longitude: -122.42 } });
			const staleResult = await stalePromise;
			assert.deepEqual(staleResult, {
				region: "default",
				permissionDenied: true,
			});
			assert.equal(
				positionCalls,
				1,
				"Superseded call must not re-trigger resolveRegion()",
			);
			assert.equal(ctx.asyncStorage.get("region.state.v1"), "default");
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Finding 19: PremiumModal Stale Offerings Cancellation on Rapid Close/Reopen
	// =========================================================================
	it("F19: PremiumModal ignores stale getSubscriptionOfferings() responses/rejections after rapid close/reopen", () => {
		const modalUrl = JSON.stringify(
			pathToFileURL(path.join(ROOT, "shared/components/PremiumModal.tsx")).href,
		);

		// 19A: Real lib/purchases.ts where stale #1 settles with empty offerings after #2 succeeds
		runHeadlessProbe(`
			let callCount = 0;
			let resolveFirst = null;
			const validOfferings = {
				current: {
					availablePackages: [
						{
							identifier: "$rc_monthly",
							packageType: "MONTHLY",
							product: {
								title: "Monthly Pass",
								description: "Monthly plan",
								priceString: "$4.99",
								price: 4.99,
							},
						},
					],
				},
			};
			globalThis.__probePurchases = {
				configure: async () => {},
				getCustomerInfo: async () => ({ entitlements: { active: {} } }),
				getOfferings: () => {
					callCount += 1;
					if (callCount === 1) {
						return new Promise((resolve) => {
							resolveFirst = resolve;
						});
					}
					return Promise.resolve(validOfferings);
				},
				addCustomerInfoUpdateListener: () => {},
				removeCustomerInfoUpdateListener: () => true,
			};

			const { default: PremiumModal } = await import(${modalUrl} + "?f19=real");
			let props = { visible: true, onClose: () => {}, onSuccess: () => {} };
			resetRuntime(() => PremiumModal(props));
			renderOnce();
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.equal(callCount, 1);
			assert.equal(typeof resolveFirst, "function");

			// Rapid close and reopen -> #2 succeeds
			props = { ...props, visible: false };
			renderOnce();
			await settle();
			props = { ...props, visible: true };
			renderOnce();
			await settle();

			assert.equal(callCount, 2);
			let texts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(texts.includes("Monthly Pass"));
			let unlockBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"))[0];
			assert.equal(unlockBtn.props.disabled, false);

			// Settle stale #1 with { current: null } -> #2 packages and enabled UNLOCK PASS must stay intact
			resolveFirst({ current: null });
			await settle();

			texts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(texts.includes("Monthly Pass"), "Monthly Pass must remain visible after stale #1 settles");
			assert.equal(texts.includes("Retry"), false, "Retry error state must not overwrite valid #2 offerings");
			unlockBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"))[0];
			assert.equal(unlockBtn.props.disabled, false, "UNLOCK PASS must remain enabled");
		`);

		// 19B: Direct getSubscriptionOfferings() rejection on stale #1 after #2 succeeds
		runHeadlessProbe(
			`
			let callCount = 0;
			let rejectFirst = null;
			globalThis.__probeGetSubscriptionOfferings = () => {
				callCount += 1;
				if (callCount === 1) {
					return new Promise((_resolve, reject) => {
						rejectFirst = reject;
					});
				}
				return Promise.resolve([
					{
						identifier: "$rc_monthly",
						packageType: "MONTHLY",
						title: "Monthly Pass",
						description: "Monthly plan",
						priceString: "$4.99",
						price: 4.99,
					},
				]);
			};
			globalThis.__probePurchasePackage = async () => true;

			const { default: PremiumModal } = await import(${modalUrl} + "?f19=catch");
			let props = { visible: true, onClose: () => {}, onSuccess: () => {} };
			resetRuntime(() => PremiumModal(props));
			renderOnce();
			for (let i = 0; i < 4; i++) {
				await new Promise((r) => setTimeout(r, 10));
			}
			assert.equal(callCount, 1);
			assert.equal(typeof rejectFirst, "function");

			props = { ...props, visible: false };
			renderOnce();
			await settle();
			props = { ...props, visible: true };
			renderOnce();
			await settle();

			let unlockBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"))[0];
			assert.equal(unlockBtn.props.disabled, false);

			rejectFirst(new Error("Stale request #1 rejected"));
			await settle();

			const texts = findNodes(runtime.currentTree, (n) => n.type === "Text").map(textContent);
			assert.ok(texts.includes("Monthly Pass"), "Monthly Pass must stay intact after stale #1 rejects");
			assert.equal(texts.includes("Retry"), false, "Stale #1 catch block must not set offeringsError");
			unlockBtn = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("UNLOCK PASS"))[0];
			assert.equal(unlockBtn.props.disabled, false, "UNLOCK PASS must stay enabled after stale #1 rejects");
		`,
			{ mockPurchasesWrapper: true },
		);
	});

	// =========================================================================
	// Finding 20: resolveCNRegion() & resolveRURegion() NFD/Diacritic Normalization
	// =========================================================================
	it("F20: resolveRURegion() and resolveCNRegion() normalize NFC/NFD diacritic region strings", async () => {
		const ctx = createE2EContext({
			locationPermission: "granted",
			locationPlaces: [{ isoCountryCode: "RU", region: "Saint-Pétersbourg" }],
		});
		try {
			const regionMod = await ctx.importFresh("lib/region.ts");
			const cases = [
				[{ isoCountryCode: "RU", region: "Saint-Pétersbourg" }, "RU-SPE"],
				[{ isoCountryCode: "RU", region: "Saint-Pe\u0301tersbourg" }, "RU-SPE"],
				[{ isoCountryCode: "RU", region: "Le\u0301ningrad" }, "RU-SPE"],
				[{ isoCountryCode: "RU", region: "Moskva\u0301" }, "RU-MOW"],
				[{ isoCountryCode: "RU", region: "Sibe\u0301ria" }, "RU-SIB"],
				[{ isoCountryCode: "RU", region: "Sverdlo\u0301vsk" }, "RU-URA"],
				[{ isoCountryCode: "RU", region: "Kamcha\u0301tka" }, "RU-FE"],
				[{ isoCountryCode: "CN", region: "Be\u0301ijing" }, "CN-BJ"],
				[{ isoCountryCode: "CN", region: "Shànghǎi" }, "CN-BJ"],
				[{ isoCountryCode: "CN", region: "Guǎngdōng" }, "CN-GD"],
				[{ isoCountryCode: "CN", region: "Gua\u030cngdo\u0304ng" }, "CN-GD"],
				[{ isoCountryCode: "CN", region: "Sìchuān" }, "CN-SC"],
				[{ isoCountryCode: "CN", region: "Zhèjiāng" }, "CN-ZJ"],
				[{ isoCountryCode: "CN", region: "Xīzàng" }, "CN-XZ"],
			];

			for (const [place, expected] of cases) {
				await regionMod.resetRegion();
				ctx.location.places = [place];
				const res = await regionMod.getRegionWithStatus();
				assert.deepEqual(
					res,
					{ region: expected, permissionDenied: false },
					`Expected ${JSON.stringify(place)} to resolve to ${expected}, got ${res.region}`,
				);
			}
		} finally {
			ctx.cleanup();
		}
	});
});
