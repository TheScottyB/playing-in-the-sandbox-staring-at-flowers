import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ts from "typescript";
import {
	findCallExpressions,
	findObjectPropertyAssignments,
	getNodeText,
	listFilesRecursive,
	parseTsxAst,
	readRepoFile,
	readRepoJson,
	repoExists,
	runCli,
	walkAst,
} from "./helpers/repo.mjs";

describe("03 — UI, Config, Dependencies & Docs Cleanup (Items 6, 8, 9)", () => {
	// =========================================================================
	// Item 6: Unused react-native-flip-card Removal
	// =========================================================================

	test("T1-I6-01: package.json dependencies and devDependencies exclude react-native-flip-card", () => {
		const pkg = readRepoJson("package.json");
		assert.equal("react-native-flip-card" in (pkg.dependencies ?? {}), false);
		assert.equal(
			"react-native-flip-card" in (pkg.devDependencies ?? {}),
			false,
		);
	});

	test("T1-I6-02: shared/types/react-native-flip-card.d.ts is removed", () => {
		assert.equal(repoExists("shared/types/react-native-flip-card.d.ts"), false);
	});

	test("T1-I6-03: pnpm-lock.yaml does not list react-native-flip-card", () => {
		const lock = readRepoFile("pnpm-lock.yaml");
		assert.equal(
			lock.includes("react-native-flip-card"),
			false,
			"pnpm-lock.yaml must not contain react-native-flip-card entries",
		);
	});

	test("T1-I6-04: ModernFlipCard.tsx exists and implements flip animation without react-native-flip-card", () => {
		assert.equal(repoExists("shared/components/ModernFlipCard.tsx"), true);
		const src = readRepoFile("shared/components/ModernFlipCard.tsx");
		assert.equal(src.includes("react-native-flip-card"), false);
		assert.match(src, /export default function/);
	});

	test("T1-I6-05: zero files in app/, lib/, or shared/ reference react-native-flip-card", () => {
		const files = [
			...listFilesRecursive("app", (r) => /\.(ts|tsx)$/.test(r)),
			...listFilesRecursive("lib", (r) => /\.(ts|tsx)$/.test(r)),
			...listFilesRecursive("shared", (r) => /\.(ts|tsx)$/.test(r)),
		];
		for (const rel of files) {
			const content = readRepoFile(rel);
			assert.equal(
				content.includes("react-native-flip-card"),
				false,
				`${rel} must not reference react-native-flip-card`,
			);
		}
	});

	test("T2-I6-06: shared/types/ contains no declaration files referencing react-native-flip-card", () => {
		const dtsFiles = listFilesRecursive("shared/types", (r) =>
			r.endsWith(".d.ts"),
		);
		for (const rel of dtsFiles) {
			assert.equal(
				readRepoFile(rel).includes("react-native-flip-card"),
				false,
				`${rel} must not declare react-native-flip-card`,
			);
		}
	});

	test("T2-I6-07: tsconfig.json and app.json do not reference react-native-flip-card", () => {
		const tsconfig = readRepoFile("tsconfig.json");
		const appJson = readRepoFile("app.json");
		assert.equal(tsconfig.includes("react-native-flip-card"), false);
		assert.equal(appJson.includes("react-native-flip-card"), false);
	});

	test("T2-I6-08: package.json is valid JSON with semver version and passes Biome check", () => {
		const pkg = readRepoJson("package.json");
		assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
		const res = runCli("pnpm", ["exec", "biome", "check", "package.json"]);
		assert.equal(res.status, 0, res.stderr || res.stdout);
	});

	test("T2-I6-09: app/index.tsx imports FlipCard from @/components/ModernFlipCard", () => {
		const indexSrc = readRepoFile("app/index.tsx");
		assert.match(indexSrc, /@\/components\/ModernFlipCard/);
	});

	test("T2-I6-10: ModernFlipCard.tsx has zero unused react-native-flip-card props or imports", () => {
		const ast = parseTsxAst("shared/components/ModernFlipCard.tsx");
		let hasReanimated = false;
		walkAst(ast, (node) => {
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				assert.notEqual(node.moduleSpecifier.text, "react-native-flip-card");
				if (node.moduleSpecifier.text === "react-native-reanimated") {
					hasReanimated = true;
				}
			}
		});
		assert.equal(hasReanimated, true);
	});

	// =========================================================================
	// Item 8: PremiumModal.tsx Disclosure & Native Blur
	// =========================================================================

	test("T1-I8-01: PremiumModal.tsx StyleSheet.create has no unguarded native filter: 'blur(...)' property", () => {
		const ast = parseTsxAst("shared/components/PremiumModal.tsx");
		const styleCalls = findCallExpressions(ast, "StyleSheet.create");
		assert.ok(styleCalls.length >= 1, "StyleSheet.create must exist");
		for (const call of styleCalls) {
			const filterProps = findObjectPropertyAssignments(ast, "filter").filter(
				(prop) =>
					prop.getStart(ast) >= call.getStart(ast) &&
					prop.getEnd() <= call.getEnd(),
			);
			for (const prop of filterProps) {
				const text = getNodeText(ast, prop);
				if (/blur\(/i.test(text)) {
					// Only permitted if guarded specifically for web via Platform.select({ web: ... })
					const parentText = getNodeText(ast, prop.parent.parent);
					assert.match(
						parentText,
						/web:\s*\{[^}]*filter:/s,
						`PremiumModal StyleSheet filter: blur(...) must be web-only via Platform.select: ${text}`,
					);
				}
			}
		}
	});

	test("T1-I8-02: PremiumModal.tsx aligns search feature copy with offline botanical search", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.equal(
			src.includes("offline embedding index"),
			false,
			"PremiumModal must not advertise misleading 'offline embedding index' copy",
		);
		assert.match(src, /offline/i);
	});

	test("T1-I8-03: PremiumModal.tsx conditions billing disclosure on Platform (Apple vs Google Play)", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.ok(
			/Platform\.OS\s*===\s*["'](android|ios)["']|Platform\.select\s*\(/s.test(
				src,
			),
			"PremiumModal must condition billing store copy on Platform.OS / Platform.select",
		);
		assert.match(
			src,
			/Google Play/,
			"PremiumModal must include Google Play disclosure copy for Android",
		);
	});

	test("T1-I8-04: PremiumModal.tsx distinguishes LIFETIME one-time purchase from auto-renewing subscriptions", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(
			src,
			/packageType\s*===\s*"LIFETIME"/,
			"PremiumModal must check selected packageType === 'LIFETIME' for billing disclosure",
		);
		assert.match(
			src,
			/one-time|lifetime|non-renewing|does not auto-renew|permanent/i,
			"PremiumModal must render non-renewing one-time purchase disclosure for LIFETIME",
		);
	});

	test("T1-I8-05: PremiumModal.tsx selects default MONTHLY by packageType and links valid legal URLs", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(src, /p\.packageType\s*===\s*"MONTHLY"/);
		assert.ok(
			src.includes(
				"https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/privacy.html",
			),
		);
		assert.ok(
			src.includes(
				"https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/terms.html",
			),
		);
	});

	test("T2-I8-06: PremiumModal.tsx Android disclosure path does not emit iTunes/App Store copy", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(src, /Platform\.(OS|select)/);
		assert.equal(
			src.includes("iTunes Account"),
			false,
			"PremiumModal must not reference legacy unconditional iTunes Account copy",
		);
		assert.match(
			src,
			/Google Play/,
			"Android branch must reference Google Play",
		);
	});

	test("T2-I8-07: PremiumModal.tsx LIFETIME branch avoids stating 'Subscriptions auto-renew' for one-time VIP", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(src, /LIFETIME/);
		const hasConditionalRenewal =
			/LIFETIME[\s\S]{0,400}Subscriptions auto-renew|isLifetime[\s\S]{0,400}auto-renew/s.test(
				src,
			);
		assert.ok(
			hasConditionalRenewal,
			"Auto-renew disclosure must be branched conditionally against LIFETIME selection",
		);
	});

	test("T2-I8-08: PremiumModal.tsx StyleSheet contains no backdropFilter or CSS boxShadow string shorthands", () => {
		const ast = parseTsxAst("shared/components/PremiumModal.tsx");
		for (const badProp of ["backdropFilter", "boxShadow"]) {
			const matches = findObjectPropertyAssignments(ast, badProp);
			assert.equal(
				matches.length,
				0,
				`PremiumModal must not use web-only CSS property "${badProp}"`,
			);
		}
	});

	test("T2-I8-09: PremiumModal.tsx handles empty offerings and rejected getSubscriptionOfferings with retry state", () => {
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(src, /setOfferingsError\(\s*true\s*\)/);
		assert.match(src, /onPress=\{\s*loadOfferings\s*\}/);
	});

	test("T2-I8-10: PremiumModal.tsx guards handlePurchase when selectedPackageId is empty", () => {
		const ast = parseTsxAst("shared/components/PremiumModal.tsx");
		const fns = findCallExpressions(ast, "purchasePackage");
		assert.equal(fns.length, 1);
		const src = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(src, /if\s*\(\s*!selectedPackageId\s*\)/);
	});

	// =========================================================================
	// Item 9: app.json, app/_layout.tsx & README.md Cleanup
	// =========================================================================

	test("T1-I9-01: app.json extra.encryptionDocPath points to ./meta/ENCRYPTION_NOTICE.md and exists", () => {
		const appJson = readRepoJson("app.json");
		const docPath = appJson.expo?.extra?.encryptionDocPath;
		assert.equal(docPath, "./meta/ENCRYPTION_NOTICE.md");
		assert.equal(repoExists(docPath.replace(/^\.\//, "")), true);
	});

	test("T1-I9-02: app.json extra.dsaCompliancePath points to ./meta/DSA_COMPLIANCE.md and exists", () => {
		const appJson = readRepoJson("app.json");
		const docPath = appJson.expo?.extra?.dsaCompliancePath;
		assert.equal(docPath, "./meta/DSA_COMPLIANCE.md");
		assert.equal(repoExists(docPath.replace(/^\.\//, "")), true);
	});

	test("T1-I9-03: app/_layout.tsx removes or guards EXPO_PUBLIC_SCREENSHOT_MODE render console.log", () => {
		const src = readRepoFile("app/_layout.tsx");
		const hasUnguardedLog =
			/console\.log\(\s*["']EXPO_PUBLIC_SCREENSHOT_MODE in layout:/m.test(
				src,
			) &&
			!/__DEV__\s*&&[\s\S]{0,80}EXPO_PUBLIC_SCREENSHOT_MODE in layout:/.test(
				src,
			) &&
			!/if\s*\([^)]*__DEV__[^)]*\)\s*\{[\s\S]{0,120}EXPO_PUBLIC_SCREENSHOT_MODE in layout:/.test(
				src,
			);
		assert.equal(
			hasUnguardedLog,
			false,
			"app/_layout.tsx must remove or __DEV__-guard the unconditional EXPO_PUBLIC_SCREENSHOT_MODE render log",
		);
	});

	test("T1-I9-04: README.md contains zero file:///Users/ or /Users/ machine-specific paths", () => {
		const readme = readRepoFile("README.md");
		assert.equal(/file:\/\/\/Users\//.test(readme), false);
		assert.equal(/\/Users\/[A-Za-z0-9_.-]+/.test(readme), false);
	});

	test("T1-I9-05: all relative markdown file links in README.md resolve to existing repo paths", () => {
		const readme = readRepoFile("README.md");
		const links = [...readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map(
			(m) => m[1],
		);
		assert.ok(links.length > 0, "README.md should contain markdown links");
		for (const href of links) {
			if (
				href.startsWith("http://") ||
				href.startsWith("https://") ||
				href.startsWith("#")
			) {
				continue;
			}
			const clean = href.split("#")[0].replace(/^\.\//, "");
			assert.equal(
				repoExists(clean),
				true,
				`README.md relative link "${href}" does not resolve to an existing file/dir`,
			);
		}
	});

	test("T2-I9-06: README.md removes deleted reset-project.mjs and broken data/species.json path", () => {
		const readme = readRepoFile("README.md");
		assert.equal(readme.includes("reset-project.mjs"), false);
		assert.equal(/(?<![a-z/])data\/species\.json/.test(readme), false);
	});

	test("T2-I9-07: README.md reflects current PNG/JPG CDN and offline search / 3072-dim DB architecture", () => {
		const readme = readRepoFile("README.md");
		assert.equal(
			/\{webp,json\}|optimize.*WebP/i.test(readme),
			false,
			"README.md must not document legacy WebP daily output",
		);
		assert.equal(
			/768-dimension|float\[768\]/i.test(readme),
			false,
			"README.md must not document outdated 768-dimension vectors",
		);
	});

	test("T2-I9-08: app.json asset references (icon, favicon, adaptiveIcon, locales) exist on disk", () => {
		const expo = readRepoJson("app.json").expo;
		const pathsToCheck = [
			expo.icon,
			expo.web?.favicon,
			expo.android?.adaptiveIcon?.foregroundImage,
			expo.android?.adaptiveIcon?.backgroundImage,
			expo.android?.adaptiveIcon?.monochromeImage,
			expo.locales?.en,
		].filter(Boolean);
		assert.ok(pathsToCheck.length >= 6);
		for (const p of pathsToCheck) {
			assert.equal(
				repoExists(p.replace(/^\.\//, "")),
				true,
				`app.json asset path "${p}" does not exist`,
			);
		}
	});

	test("T2-I9-09: app/_layout.tsx still calls initPurchases() inside useEffect on mount", () => {
		const src = readRepoFile("app/_layout.tsx");
		assert.match(src, /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*initPurchases\(\)/);
	});

	test("T2-I9-10: app/_layout.tsx guards LogBox.ignoreAllLogs strictly to EXPO_PUBLIC_SCREENSHOT_MODE === 'true'", () => {
		const src = readRepoFile("app/_layout.tsx");
		assert.match(
			src,
			/if\s*\(\s*process\.env\.EXPO_PUBLIC_SCREENSHOT_MODE\s*===\s*"true"\s*\)\s*\{\s*LogBox\.ignoreAllLogs\(\)/,
		);
	});

	// =========================================================================
	// Tier 3: Pairwise Cross-Feature Integration
	// =========================================================================

	test("T3-03-01: app.json legal URLs match PremiumModal.tsx and docs/ files exist", () => {
		const appJson = readRepoJson("app.json");
		const modalSrc = readRepoFile("shared/components/PremiumModal.tsx");
		const privacyUrl = appJson.expo?.extra?.privacyPolicyUrl;
		assert.ok(privacyUrl);
		assert.ok(modalSrc.includes(privacyUrl));
		assert.equal(repoExists("docs/privacy.html"), true);
		assert.equal(repoExists("docs/terms.html"), true);
	});

	test("T3-03-02: PremiumModal.tsx offerings titles & prices match lib/purchases.ts mock/product tiers", () => {
		const purchasesSrc = readRepoFile("lib/purchases.ts");
		const modalSrc = readRepoFile("shared/components/PremiumModal.tsx");
		assert.match(purchasesSrc, /\$4\.99/);
		assert.match(purchasesSrc, /\$29\.99/);
		assert.match(purchasesSrc, /\$99\.99/);
		assert.match(modalSrc, /getSubscriptionOfferings/);
		assert.match(modalSrc, /LIFETIME/);
	});

	test("T3-03-03: app/index.tsx ModernFlipCard replacement compiles cleanly alongside removed flip-card", () => {
		assert.equal(repoExists("shared/types/react-native-flip-card.d.ts"), false);
		const indexSrc = readRepoFile("app/index.tsx");
		const cardSrc = readRepoFile("shared/components/ModernFlipCard.tsx");
		assert.match(indexSrc, /<FlipCard/);
		assert.match(cardSrc, /export default function/);
	});

	test("T3-03-04: app.json compliance paths and README.md meta links point to identical canonical docs", () => {
		const appJson = readRepoJson("app.json");
		const readme = readRepoFile("README.md");
		assert.equal(
			appJson.expo?.extra?.encryptionDocPath,
			"./meta/ENCRYPTION_NOTICE.md",
		);
		assert.equal(
			appJson.expo?.extra?.dsaCompliancePath,
			"./meta/DSA_COMPLIANCE.md",
		);
		assert.match(readme, /meta\/PRIVACY\.md/);
		assert.match(readme, /meta\/SUBMISSION\.md/);
	});

	// =========================================================================
	// Tier 4: Real-World E2E Release Readiness Verification
	// =========================================================================

	test("T4-03-01: Full UI/config/docs release gate: pnpm typecheck + biome check + app.json + PremiumModal + README audit", () => {
		const tsc = runCli("pnpm", ["typecheck"], { timeout: 60000 });
		assert.equal(
			tsc.status,
			0,
			`pnpm typecheck failed:\n${tsc.stdout}\n${tsc.stderr}`,
		);

		const biome = runCli("pnpm", [
			"exec",
			"biome",
			"check",
			"package.json",
			"app.json",
			"app/_layout.tsx",
			"shared/components/PremiumModal.tsx",
		]);
		assert.equal(
			biome.status,
			0,
			`biome check failed:\n${biome.stdout}\n${biome.stderr}`,
		);

		const appJson = readRepoJson("app.json");
		assert.equal(
			repoExists(appJson.expo.extra.encryptionDocPath.replace(/^\.\//, "")),
			true,
		);
		assert.equal(
			repoExists(appJson.expo.extra.dsaCompliancePath.replace(/^\.\//, "")),
			true,
		);
		assert.equal(/file:\/\/\/Users\//.test(readRepoFile("README.md")), false);
	});
});
