import "./helpers/m1-rn-loader.mjs";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Jimp } from "jimp";
import ts from "typescript";

const ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

function readRepoFile(relPath) {
	return fs.readFileSync(path.join(ROOT, relPath), "utf8");
}

function parseAppIndexAst() {
	const src = readRepoFile("app/index.tsx");
	return {
		src,
		ast: ts.createSourceFile(
			"app/index.tsx",
			src,
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TSX,
		),
	};
}

function findFunctionBody(ast, src, name) {
	let bodyText = null;
	function visit(node) {
		if (bodyText !== null) return;
		if (
			(ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node)) &&
			node.name?.text === name
		) {
			bodyText = src.slice(node.pos, node.end);
			return;
		}
		ts.forEachChild(node, visit);
	}
	visit(ast);
	return bodyText;
}

describe("Tier 3 integration fixes: Travel Mode revocation, imageLoadFailed reset, Maestro & screenshot parity", () => {
	it("clears Travel Mode override on !__DEV__ entitlement revocation in loadPremiumData, subscribeToPremiumUpdates, resolveEffectiveRegion, and handleUpdateLocation", () => {
		const { src, ast } = parseAppIndexAst();

		const loadPremiumBody = findFunctionBody(ast, src, "loadPremiumData");
		assert.ok(loadPremiumBody, "loadPremiumData must exist in app/index.tsx");
		assert.match(loadPremiumBody, /isPremiumUserWithVerification\(/);
		assert.match(loadPremiumBody, /!__DEV__\s*&&\s*verified\s*&&\s*!prem/);
		assert.match(loadPremiumBody, /getRegionOverride\(/);
		assert.match(loadPremiumBody, /setRegionOverride\(\s*null\s*\)/);
		assert.match(loadPremiumBody, /setActiveOverride\(\s*null\s*\)/);
		assert.match(loadPremiumBody, /setReloadKey/);

		assert.match(
			src,
			/subscribeToPremiumUpdates\(\(prem\)\s*=>\s*\{[\s\S]*?!__DEV__\s*&&\s*!prem[\s\S]*?getRegionOverride\(\)[\s\S]*?setRegionOverride\(\s*null\s*\)[\s\S]*?setActiveOverride\(\s*null\s*\)[\s\S]*?setReloadKey/,
			"subscribeToPremiumUpdates must clear persisted override and reload on !__DEV__ revocation",
		);

		const resolveRegionBody = findFunctionBody(
			ast,
			src,
			"resolveEffectiveRegion",
		);
		assert.ok(
			resolveRegionBody,
			"resolveEffectiveRegion must exist in app/index.tsx",
		);
		assert.match(resolveRegionBody, /if\s*\(\s*!__DEV__\s*\)/);
		assert.match(resolveRegionBody, /getRegionOverride\(/);
		assert.match(resolveRegionBody, /isPremiumUserWithVerification\(/);
		assert.match(resolveRegionBody, /verified\s*&&\s*!prem/);
		assert.match(resolveRegionBody, /setRegionOverride\(\s*null\s*\)/);
		assert.match(resolveRegionBody, /getRegion\(\)/);

		const updateLocationBody = findFunctionBody(
			ast,
			src,
			"handleUpdateLocation",
		);
		assert.ok(
			updateLocationBody,
			"handleUpdateLocation must exist in app/index.tsx",
		);
		assert.match(updateLocationBody, /hadOverride/);
		assert.match(updateLocationBody, /setRegionOverride\(\s*null\s*\)/);
		assert.match(updateLocationBody, /setActiveOverride\(\s*null\s*\)/);
		assert.match(updateLocationBody, /resetRegion\(\)/);
		assert.match(
			updateLocationBody,
			/if\s*\(\s*permissionDenied\s*\)\s*\{[\s\S]*?if\s*\(\s*hadOverride\s*\)\s*\{[\s\S]*?setDayOffset\(\s*0\s*\)[\s\S]*?setReloadKey/,
		);

		const checkDevBody = findFunctionBody(ast, src, "checkDevData");
		assert.ok(checkDevBody, "checkDevData must exist in app/index.tsx");
		assert.match(checkDevBody, /__DEV__\s*\|\|\s*isPremium/);
		assert.match(checkDevBody, /setActiveOverride\(\s*null\s*\)/);
	});

	it("includes extractedImageUri and state.flower.isDefault in flowerIdentity so online recovery resets imageLoadFailed", () => {
		const { src } = parseAppIndexAst();
		const identityMatch = src.match(
			/const flowerIdentity\s*=\s*state\.status === "ok"\s*\?\s*(`[^`]+`)/,
		);
		assert.ok(identityMatch, "flowerIdentity template literal must exist");
		const template = identityMatch[1];
		assert.match(template, /state\.flower\.state/);
		assert.match(template, /state\.flower\.date/);
		assert.match(template, /state\.flower\.common/);
		assert.match(template, /extractedImageUri\s*\?\?\s*""/);
		assert.match(template, /Boolean\(\s*state\.flower\.isDefault\s*\)/);
		assert.match(
			src,
			/useEffect\(\(\)\s*=>\s*\{\s*setFallbackImageUri\(null\);\s*setImageLoadFailed\(false\);\s*\},\s*\[flowerIdentity\]\)/,
		);
	});

	it("focuses the search TextInput before inputText in capture_flow.yml and uses regex .*OFFLINE.* in error-states.yml", () => {
		const { src: indexSrc } = parseAppIndexAst();
		const captureFlow = readRepoFile(".maestro/capture_flow.yml");
		const errorFlow = readRepoFile(".maestro/error-states.yml");

		const placeholderMatch = indexSrc.match(
			/placeholder="(e\.g\. purple spring poppy[^"]+)"/,
		);
		assert.ok(placeholderMatch, "Search TextInput placeholder must exist");
		const placeholder = placeholderMatch[1];

		const escapedPlaceholder = placeholder.replace(
			/[.*+?^${}()|[\]\\]/g,
			"\\$&",
		);
		assert.match(
			captureFlow,
			new RegExp(
				`visible:\\s*"Botanical Search"[\\s\\S]*?-\\s*tapOn:\\s*"${escapedPlaceholder}"[\\s\\S]*?-\\s*inputText:\\s*"poppy"`,
			),
			"capture_flow.yml must tap the search TextInput placeholder before inputText",
		);

		assert.match(indexSrc, /OFFLINE · ARCHIVE/);
		assert.match(errorFlow, /when:\s*\n\s*visible:\s*"\.\*OFFLINE\.\*"/);
		assert.match(errorFlow, /-\s*assertVisible:\s*"\.\*OFFLINE\.\*"/);
		assert.doesNotMatch(errorFlow, /visible:\s*"OFFLINE"/);
		assert.doesNotMatch(errorFlow, /assertVisible:\s*"OFFLINE"/);
	});

	it("aligns all DEVICE_TYPES primary and scaled dimensions in capture scripts with verify_screenshots.mjs DEVICE_SPECS", async () => {
		const { DEVICE_SPECS } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const { DEVICE_TYPES: autoDevices, resizeImage: autoResize } = await import(
			"../../scripts/capture_screenshots_auto.mjs"
		);
		const { DEVICE_TYPES: manualDevices, resizeImage: manualResize } =
			await import("../../scripts/capture_screenshots.mjs");

		for (const [label, devices] of [
			["capture_screenshots_auto.mjs", autoDevices],
			["capture_screenshots.mjs", manualDevices],
		]) {
			for (const [key, device] of Object.entries(devices)) {
				const primarySpec = DEVICE_SPECS[device.filePrefix];
				assert.ok(
					primarySpec,
					`${label} ${key} prefix ${device.filePrefix} missing from DEVICE_SPECS`,
				);
				assert.equal(
					device.w,
					primarySpec.width,
					`${label} ${key}.w (${device.w}) must match DEVICE_SPECS.${device.filePrefix}.width (${primarySpec.width})`,
				);
				assert.equal(
					device.h,
					primarySpec.height,
					`${label} ${key}.h (${device.h}) must match DEVICE_SPECS.${device.filePrefix}.height (${primarySpec.height})`,
				);

				for (const scale of device.scales) {
					const matchedPrefix = Object.keys(DEVICE_SPECS).find((p) =>
						scale.prefix.startsWith(p),
					);
					assert.ok(
						matchedPrefix,
						`${label} scale ${scale.prefix} must match a DEVICE_SPECS key`,
					);
					const scaleSpec = DEVICE_SPECS[matchedPrefix];
					assert.equal(
						scale.w,
						scaleSpec.width,
						`${label} scale ${scale.prefix}.w must match ${matchedPrefix}.width`,
					);
					assert.equal(
						scale.h,
						scaleSpec.height,
						`${label} scale ${scale.prefix}.h must match ${matchedPrefix}.height`,
					);
				}
			}
		}

		// Unit-test resizeImage portrait, landscape, and exact-size no-op logic cross-platform
		for (const resizeFn of [autoResize, manualResize]) {
			const cmds = [];
			const copied = [];
			// Portrait mismatch: 1320x2868 -> 1290x2796
			resizeFn("/mock/src.png", "/mock/dst.png", 1290, 2796, {
				runCommandImpl: () => "  pixelWidth: 1320\n  pixelHeight: 2868",
				execFileSyncImpl: (bin, args) => cmds.push([bin, ...args]),
				copyFileSyncImpl: (s, d) => copied.push([s, d]),
			});
			assert.deepEqual(cmds[0], [
				"sips",
				"-z",
				"2796",
				"1290",
				"/mock/src.png",
				"--out",
				"/mock/dst.png",
			]);

			// Landscape mismatch: 2868x1320 -> 2796x1290
			cmds.length = 0;
			resizeFn("/mock/src.png", "/mock/dst.png", 1290, 2796, {
				runCommandImpl: () => "  pixelWidth: 2868\n  pixelHeight: 1320",
				execFileSyncImpl: (bin, args) => cmds.push([bin, ...args]),
				copyFileSyncImpl: (s, d) => copied.push([s, d]),
			});
			assert.deepEqual(cmds[0], [
				"sips",
				"-z",
				"1290",
				"2796",
				"/mock/src.png",
				"--out",
				"/mock/dst.png",
			]);

			// Exact match: skips sips -z and copies when dest differs
			cmds.length = 0;
			copied.length = 0;
			resizeFn("/mock/src.png", "/mock/dst.png", 1290, 2796, {
				runCommandImpl: () => "  pixelWidth: 1290\n  pixelHeight: 2796",
				execFileSyncImpl: (bin, args) => cmds.push([bin, ...args]),
				copyFileSyncImpl: (s, d) => copied.push([s, d]),
			});
			assert.equal(cmds.length, 0);
			assert.deepEqual(copied, [["/mock/src.png", "/mock/dst.png"]]);
		}

		// On macOS, verify end-to-end sips resize + verify_screenshots.mjs analysis
		if (process.platform === "darwin") {
			const { analyzeScreenshot } = await import(
				"../../scripts/verify_screenshots.mjs"
			);
			const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-parity-"));
			try {
				const rawPath = path.join(tempDir, "iphone67_raw.png");
				const img = new Jimp({ width: 132, height: 286, color: 0xff0000ff });
				fs.writeFileSync(rawPath, await img.getBuffer("image/png"));
				autoResize(rawPath, rawPath, 1290, 2796);
				const analysis = await analyzeScreenshot(rawPath, tempDir, null, {
					ocr: { available: false, text: "" },
				});
				assert.equal(analysis.fileInfo.width, 1290);
				assert.equal(analysis.fileInfo.height, 2796);
				assert.equal(
					analysis.issues.some((i) => i.includes("Invalid dimensions")),
					false,
				);
			} finally {
				fs.rmSync(tempDir, { recursive: true, force: true });
			}
		}
	});

	it("deterministically strips PNG alpha channel in capture_screenshots_auto, capture_screenshots, and verify_screenshots fallback", async () => {
		const {
			eraseGearIcon,
			pngHasAlpha: autoPngHasAlpha,
			postProcessScreenshot,
		} = await import("../../scripts/capture_screenshots_auto.mjs");
		const { pngHasAlpha: manualPngHasAlpha, stripAlphaChannel } = await import(
			"../../scripts/capture_screenshots.mjs"
		);
		const { analyzeScreenshot, fixScreenshot, getImageInfo } = await import(
			"../../scripts/verify_screenshots.mjs"
		);

		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-strip-"));
		try {
			// 1. capture_screenshots_auto: eraseGearIcon + postProcessScreenshot on 1290x2796 RGBA PNG
			const autoPath = path.join(tempDir, "iphone67_home.png");
			const autoImg = new Jimp({
				width: 1290,
				height: 2796,
				color: 0x0a0a0aff,
			});
			fs.writeFileSync(autoPath, await autoImg.getBuffer("image/png"));
			assert.equal(autoPngHasAlpha(autoPath), true);

			await eraseGearIcon(autoPath, "iphone67");
			await postProcessScreenshot(autoPath, "iphone67");

			assert.equal(autoPngHasAlpha(autoPath), false);
			assert.equal(fs.readFileSync(autoPath)[25], 2); // PNG colorType = 2 (RGB)

			const autoFileInfo =
				process.platform === "darwin"
					? getImageInfo(autoPath)
					: {
							width: 1290,
							height: 2796,
							hasAlpha: autoPngHasAlpha(autoPath),
							format: "png",
							sizeBytes: fs.statSync(autoPath).size,
						};
			const autoAnalysis = await analyzeScreenshot(autoPath, tempDir, null, {
				fileInfo: autoFileInfo,
				ocr: { available: false, text: "" },
			});
			assert.equal(autoAnalysis.fileInfo.hasAlpha, false);
			assert.deepEqual(autoAnalysis.issues, []);

			// 2. capture_screenshots: stripAlphaChannel composites semi-transparent pixels over #0a0a0a
			const manualPath = path.join(tempDir, "iphone67_manual.png");
			const manualImg = new Jimp({
				width: 1290,
				height: 2796,
				color: 0x4080c080,
			});
			fs.writeFileSync(manualPath, await manualImg.getBuffer("image/png"));
			assert.equal(manualPngHasAlpha(manualPath), true);

			await stripAlphaChannel(manualPath);
			assert.equal(manualPngHasAlpha(manualPath), false);
			assert.equal(fs.readFileSync(manualPath)[25], 2);

			const reread = await Jimp.read(manualPath);
			const r = reread.bitmap.data[0];
			const g = reread.bitmap.data[1];
			const b = reread.bitmap.data[2];
			assert.ok(
				r < 0x40 && g < 0x80 && b < 0xc0,
				`Expected semi-transparent pixel to composite over #0a0a0a, got rgb(${r},${g},${b})`,
			);

			const manualFileInfo =
				process.platform === "darwin"
					? getImageInfo(manualPath)
					: {
							width: 1290,
							height: 2796,
							hasAlpha: manualPngHasAlpha(manualPath),
							format: "png",
							sizeBytes: fs.statSync(manualPath).size,
						};
			const manualAnalysis = await analyzeScreenshot(
				manualPath,
				tempDir,
				null,
				{
					fileInfo: manualFileInfo,
					ocr: { available: false, text: "" },
				},
			);
			assert.equal(manualAnalysis.fileInfo.hasAlpha, false);
			assert.deepEqual(manualAnalysis.issues, []);

			// 3. verify_screenshots.mjs fixScreenshot fallback (when magick/convert are unavailable)
			const fixPath = path.join(tempDir, "iphone67_fix.png");
			const fixImg = new Jimp({
				width: 1290,
				height: 2796,
				color: 0xff000080,
			});
			fs.writeFileSync(fixPath, await fixImg.getBuffer("image/png"));
			const initialInfo = {
				width: 1290,
				height: 2796,
				hasAlpha: true,
				format: "png",
				sizeBytes: fs.statSync(fixPath).size,
			};
			const fixAnalysis = await analyzeScreenshot(fixPath, tempDir, null, {
				fileInfo: initialInfo,
				ocr: { available: false, text: "" },
			});
			assert.equal(fixAnalysis.fileInfo.hasAlpha, true);

			const fixResult = fixScreenshot(fixAnalysis, tempDir, {
				runCommandImpl: (bin, args = []) => {
					if (bin === "which") return null;
					return execFileSync(bin, args, {
						encoding: "utf-8",
						stdio: ["pipe", "pipe", "ignore"],
					}).trim();
				},
				getImageInfoImpl: (p) =>
					process.platform === "darwin"
						? getImageInfo(p)
						: {
								width: 1290,
								height: 2796,
								hasAlpha: autoPngHasAlpha(p),
								format: "png",
								sizeBytes: fs.statSync(p).size,
							},
			});
			assert.equal(fixResult.fixed, true);
			assert.equal(fixResult.fixFailed, undefined);
			assert.equal(fixAnalysis.fileInfo.hasAlpha, false);
			assert.equal(autoPngHasAlpha(fixPath), false);
			assert.equal(fs.readFileSync(fixPath)[25], 2);

			const reanalyzed = await analyzeScreenshot(fixPath, tempDir, null, {
				fileInfo: fixAnalysis.fileInfo,
				ocr: { available: false, text: "" },
			});
			assert.equal(reanalyzed.fileInfo.hasAlpha, false);
			assert.deepEqual(reanalyzed.issues, []);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("checkPremiumStatusWithVerification distinguishes transient RC errors from confirmed non-premium while preserving checkPremiumStatus", async () => {
		const prevMockEnv = process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		const prevIosKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
		const prevPurchases = globalThis.__mockPurchases;
		const prevOs = globalThis.__mockPlatform.OS;

		try {
			globalThis.__mockPlatform.OS = "ios";
			globalThis.__mockAsyncStorage.clear();

			// 1. configure() throws -> verified: false, isPremium: false
			delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = "appl_test_key";
			globalThis.__mockPurchases = {
				configure: async () => {
					throw new Error("Transient RC configure failure");
				},
				getCustomerInfo: async () => ({
					entitlements: { active: { premium: { isActive: true } } },
				}),
				getOfferings: async () => ({ current: null }),
				purchasePackage: async () => ({
					customerInfo: { entitlements: { active: {} } },
				}),
				restorePurchases: async () => ({ entitlements: { active: {} } }),
				addCustomerInfoUpdateListener: () => {},
				removeCustomerInfoUpdateListener: () => true,
			};

			const pCfgErr = await import("../../lib/purchases.ts?t3=cfgerr");
			const premCfgErr = await import("../../lib/premium.ts?t3=cfgerr");
			assert.deepEqual(await pCfgErr.checkPremiumStatusWithVerification(), {
				isPremium: false,
				verified: false,
			});
			assert.equal(await pCfgErr.checkPremiumStatus(), false);
			assert.equal(await premCfgErr.isPremiumUser(), false);

			// 2. getCustomerInfo() throws -> verified: false, isPremium: false
			globalThis.__mockPurchases = {
				...globalThis.__mockPurchases,
				configure: async () => {},
				getCustomerInfo: async () => {
					throw new Error("Transient RC network timeout");
				},
			};
			const pInfoErr = await import("../../lib/purchases.ts?t3=infoerr");
			assert.deepEqual(await pInfoErr.checkPremiumStatusWithVerification(), {
				isPremium: false,
				verified: false,
			});
			assert.equal(await pInfoErr.checkPremiumStatus(), false);

			// 3. Missing API key (!isConfigured) -> verified: false, isPremium: false
			delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
			const pNoKey = await import("../../lib/purchases.ts?t3=nokey");
			assert.deepEqual(await pNoKey.checkPremiumStatusWithVerification(), {
				isPremium: false,
				verified: false,
			});

			// 4. Confirmed unentitled -> verified: true, isPremium: false
			process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = "appl_test_key";
			globalThis.__mockPurchases = {
				...globalThis.__mockPurchases,
				configure: async () => {},
				getCustomerInfo: async () => ({ entitlements: { active: {} } }),
			};
			const pUnentitled = await import("../../lib/purchases.ts?t3=unentitled");
			assert.deepEqual(await pUnentitled.checkPremiumStatusWithVerification(), {
				isPremium: false,
				verified: true,
			});
			assert.equal(await pUnentitled.checkPremiumStatus(), false);

			// 5. Confirmed entitled -> verified: true, isPremium: true
			globalThis.__mockPurchases.getCustomerInfo = async () => ({
				entitlements: { active: { premium: { isActive: true } } },
			});
			assert.deepEqual(await pUnentitled.checkPremiumStatusWithVerification(), {
				isPremium: true,
				verified: true,
			});
			assert.equal(await pUnentitled.checkPremiumStatus(), true);

			// 6. USE_MOCK=true -> verified: true
			process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = "true";
			const pMock = await import("../../lib/purchases.ts?t3=mock");
			assert.deepEqual(await pMock.checkPremiumStatusWithVerification(), {
				isPremium: false,
				verified: true,
			});
			await pMock.purchasePackage("premium_monthly");
			assert.deepEqual(await pMock.checkPremiumStatusWithVerification(), {
				isPremium: true,
				verified: true,
			});
		} finally {
			globalThis.__mockPurchases = prevPurchases;
			globalThis.__mockPlatform.OS = prevOs;
			if (prevMockEnv === undefined) {
				delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			} else {
				process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = prevMockEnv;
			}
			if (prevIosKey === undefined) {
				delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
			} else {
				process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = prevIosKey;
			}
		}
	});

	it("HomeScreen preserves region.override.v1 on transient RC errors, clears on confirmed non-premium, and reloads UI on handleUpdateLocation permissionDenied", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "home-probe-"));
		const loaderPath = path.join(tempDir, "loader.mjs");
		const runnerPath = path.join(tempDir, "runner.mjs");

		const loaderCode = `
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
			alerts: [],
			componentFn: null,
		};
		export function resetRuntime(fn) {
			runtime.states = [];
			runtime.effects = [];
			runtime.hookIdx = 0;
			runtime.alerts = [];
			runtime.componentFn = fn;
		}
		export function renderOnce() {
			runtime.hookIdx = 0;
			runtime.currentTree = runtime.componentFn();
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
			addEventListener() { return { remove() {} }; },
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
	"expo-constants": "export default { expoConfig: { version: '1.0.0' } };",
	"expo-image": "export const Image = 'Image';",
	"expo-linear-gradient": "export const LinearGradient = 'LinearGradient';",
	"expo-router": "export const Link = Object.assign('Link', { Trigger: 'Trigger' }); export function useRouter() { return { push() {} }; }",
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
	"@/components/IridescentOverlay": "export const IridescentOverlay = 'IridescentOverlay';",
	"@/components/ModernFlipCard": "export default 'FlipCard';",
	"@/hooks/useOnline": "export function useOnline() { return true; }",
	"@/shared/components/PremiumModal": "export default 'PremiumModal';",
	"@/styles/home.styles": "export const styles = new Proxy({}, { get: () => ({}) });",
	"@/data/defaults": \`
		export const DEFAULT_FLOWER = {
			common: "California Poppy",
			latin: "Eschscholzia californica",
			blurb: "Default poppy",
			variants: [{ time: "midday", fromHour: 0, image: 1 }],
		};
		export function pickVariant() { return DEFAULT_FLOWER.variants[0]; }
	\`,
	"@/lib/speciesDb": \`
		export const MAX_QUERY_CHARS = 200;
		export function isSearchQueryEligible(q) { return q.trim().length >= 2; }
		export async function getDailyFlowerOffline() { return null; }
		export async function getSpeciesCount() { return 396; }
		export async function searchSpeciesVector() { return []; }
	\`,
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

		const runnerCode = `
import assert from "node:assert/strict";
import { renderOnce, resetRuntime, runtime } from "react";

globalThis.__DEV__ = false;
globalThis.__probeStorage = new Map();
globalThis.__probeAlerts = [];
globalThis.__probePermStatus = "granted";
globalThis.require = (id) => {
	if (id === "react-native-purchases") return { default: globalThis.__probePurchases };
	throw new Error("Unexpected require: " + id);
};

const fetchedUrls = [];
globalThis.fetch = async (url) => {
	fetchedUrls.push(String(url));
	const m = String(url).match(/\\/daily\\/([^/]+)\\/([^/]+)\\.json$/);
	const region = m ? m[1] : "default";
	return new Response(JSON.stringify({
		common: region + " Flower",
		latin: "Rosa " + region,
		blurb: "Blurb",
		imageExt: "png",
	}), { status: 200 });
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

// Scenario A: Transient RC getCustomerInfo error -> preserves region.override.v1 = "MX-MEX"
globalThis.__probeStorage.set("region.override.v1", "MX-MEX");
globalThis.__probePurchases = {
	configure: async () => {},
	getCustomerInfo: async () => { throw new Error("Transient RC timeout"); },
	getOfferings: async () => ({ current: null }),
	addCustomerInfoUpdateListener: () => {},
	removeCustomerInfoUpdateListener: () => true,
};
const { default: HomeA } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "app/index.tsx")).href)} + "?case=A");
resetRuntime(HomeA);
renderOnce();
await settle();
assert.equal(globalThis.__probeStorage.get("region.override.v1"), "MX-MEX", "Transient getCustomerInfo error must preserve region.override.v1");
assert.ok(fetchedUrls.some((u) => u.includes("/daily/MX-MEX/")), "Must still load MX-MEX on transient RC error");

// Scenario B: Transient RC configure error -> preserves region.override.v1 = "MX-MEX"
fetchedUrls.length = 0;
globalThis.__probeStorage.clear();
globalThis.__probeStorage.set("region.override.v1", "MX-MEX");
globalThis.__probePurchases = {
	...globalThis.__probePurchases,
	configure: async () => { throw new Error("Transient RC configure failure"); },
};
const { default: HomeB } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "app/index.tsx")).href)} + "?case=B");
resetRuntime(HomeB);
renderOnce();
await settle();
assert.equal(globalThis.__probeStorage.get("region.override.v1"), "MX-MEX", "Transient configure error must preserve region.override.v1");
assert.ok(fetchedUrls.some((u) => u.includes("/daily/MX-MEX/")));

// Scenario C: Confirmed unentitled user -> deletes region.override.v1 and loads CA
fetchedUrls.length = 0;
globalThis.__probeStorage.clear();
globalThis.__probeStorage.set("region.override.v1", "MX-MEX");
globalThis.__probePurchases = {
	...globalThis.__probePurchases,
	configure: async () => {},
	getCustomerInfo: async () => ({ entitlements: { active: {} } }),
};
const { default: HomeC } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "app/index.tsx")).href)} + "?case=C");
resetRuntime(HomeC);
renderOnce();
await settle();
assert.equal(globalThis.__probeStorage.get("region.override.v1"), undefined, "Confirmed non-premium must delete region.override.v1");
assert.equal(fetchedUrls.some((u) => u.includes("/daily/MX-MEX/")), false);
assert.ok(fetchedUrls.some((u) => u.includes("/daily/CA/")));

// Scenario D: handleUpdateLocation() with permissionDenied while activeOverride === "MX-MEX" reloads UI to YOUR AREA (default)
fetchedUrls.length = 0;
globalThis.__probeStorage.clear();
globalThis.__probeAlerts.length = 0;
globalThis.__probeStorage.set("region.override.v1", "MX-MEX");
globalThis.__probePermStatus = "denied";
globalThis.__probePurchases = {
	...globalThis.__probePurchases,
	configure: async () => {},
	getCustomerInfo: async () => ({ entitlements: { active: { premium: { isActive: true } } } }),
};
const { default: HomeD } = await import(${JSON.stringify(pathToFileURL(path.join(ROOT, "app/index.tsx")).href)} + "?case=D");
resetRuntime(HomeD);
renderOnce();
await settle();
assert.ok(fetchedUrls.some((u) => u.includes("/daily/MX-MEX/")));
fetchedUrls.length = 0;
const updateBtns = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"));
assert.equal(updateBtns.length, 1);
await updateBtns[0].props.onPress();
await settle();
assert.equal(globalThis.__probeStorage.get("region.override.v1"), undefined);
assert.equal(globalThis.__probeAlerts.length, 1);
assert.ok(fetchedUrls.some((u) => u.includes("/daily/default/")), "Clearing override on permissionDenied must reload fallback default region");
const eyebrowsAfter = findNodes(runtime.currentTree, (n) => n.type === "Text" && textContent(n).includes("·")).map(textContent);
assert.ok(eyebrowsAfter.some((t) => t.startsWith("YOUR AREA")), "Eyebrow must update from MX-MEX to YOUR AREA, got: " + eyebrowsAfter.join(", "));

// Scenario E: handleUpdateLocation() with permissionDenied when NO override was active does NOT trigger extra reload
fetchedUrls.length = 0;
globalThis.__probeAlerts.length = 0;
const updateBtns2 = findNodes(runtime.currentTree, (n) => n.type === "Pressable" && textContent(n).includes("Update location"));
await updateBtns2[0].props.onPress();
await settle();
assert.equal(globalThis.__probeAlerts.length, 1);
assert.equal(fetchedUrls.length, 0, "Should not reload when no override was active on permissionDenied");
`;

		fs.writeFileSync(loaderPath, loaderCode, "utf8");
		fs.writeFileSync(runnerPath, runnerCode, "utf8");
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
				`HomeScreen probe failed:\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`,
			);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
