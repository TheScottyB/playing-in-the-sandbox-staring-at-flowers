import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../..",
);

function readRepoFile(relPath) {
	return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf8");
}

describe("M1 static contracts & R4 remediation", () => {
	it("removes react-native-flip-card and its ambient .d.ts shim", () => {
		const pkg = JSON.parse(readRepoFile("package.json"));
		assert.equal(pkg.dependencies["react-native-flip-card"], undefined);
		assert.equal(
			fs.existsSync(
				path.join(REPO_ROOT, "shared/types/react-native-flip-card.d.ts"),
			),
			false,
		);
	});

	it("points app.json compliance doc paths to existing files under ./meta/", () => {
		const appJson = JSON.parse(readRepoFile("app.json"));
		const encPath = appJson.expo.extra.encryptionDocPath;
		const dsaPath = appJson.expo.extra.dsaCompliancePath;
		assert.equal(encPath, "./meta/ENCRYPTION_NOTICE.md");
		assert.equal(dsaPath, "./meta/DSA_COMPLIANCE.md");
		assert.equal(fs.existsSync(path.join(REPO_ROOT, encPath)), true);
		assert.equal(fs.existsSync(path.join(REPO_ROOT, dsaPath)), true);
	});

	it("removes unconditional EXPO_PUBLIC_SCREENSHOT_MODE render log in app/_layout.tsx", () => {
		const layout = readRepoFile("app/_layout.tsx");
		assert.doesNotMatch(layout, /EXPO_PUBLIC_SCREENSHOT_MODE in layout:/);
		assert.match(layout, /void initPurchases\(\)/);
	});

	it("cleans README.md absolute file:/// links and outdated architecture claims", () => {
		const readme = readRepoFile("README.md");
		assert.doesNotMatch(readme, /file:\/\/\//);
		assert.doesNotMatch(readme, /Gemini 2\.5 Flash/);
		assert.doesNotMatch(readme, /reset-project\.mjs/);
		assert.doesNotMatch(readme, /float\[768\]|768-dimension/);
		assert.doesNotMatch(readme, /\bWebP\b/);
		assert.match(readme, /float\[3072\]|3072-dimension/);
		assert.match(readme, /100% offline/i);
	});

	it("fixes PremiumModal.tsx disclosure, cross-platform glow, and offline search copy", () => {
		const modal = readRepoFile("shared/components/PremiumModal.tsx");
		assert.doesNotMatch(modal, /Vector Vibe/);
		assert.doesNotMatch(modal, /semantic embeddings/);
		assert.doesNotMatch(modal, /iTunes Account/);
		assert.match(modal, /Google Play/);
		assert.match(modal, /isLifetime/);
		assert.match(modal, /Platform\.select<ViewStyle>/);
	});

	it("enforces __DEV__ Travel Mode guards, regional chips, 404 cascade & search placeholder params in app/index.tsx", () => {
		const indexSrc = readRepoFile("app/index.tsx");
		assert.match(
			indexSrc,
			/function handleEyebrowPress\(\) \{\s*if \(!__DEV__\) return;/,
		);
		assert.match(indexSrc, /if \(__DEV__ && devMenuVisible\)/);
		assert.match(indexSrc, /if \(!__DEV__ && !isPremium\) return;/);
		assert.match(
			indexSrc,
			/visible=\{devMenuVisible && \(__DEV__ \|\| isPremium\)\}/,
		);
		assert.match(indexSrc, /\{__DEV__ && \(\s*<>\s*<Text[^>]*>\s*Diagnostics/);
		assert.match(indexSrc, /"MX-MEX"/);
		assert.match(indexSrc, /"RU-MOW"/);
		assert.match(indexSrc, /"CN-BJ"/);
		assert.doesNotMatch(indexSrc, /\{ code: "(MX|RU|CN)",/);
		assert.doesNotMatch(indexSrc, /Vector Vibe/);
		assert.doesNotMatch(indexSrc, /semantic embeddings/);
		assert.match(indexSrc, /source:\s*"search"/);
		assert.match(indexSrc, /isPlaceholder:\s*(photo \? "0" : )?"1"/);
		assert.match(indexSrc, /AppState\.addEventListener/);
		assert.match(indexSrc, /getCachedFlower\(region\)/);
		assert.match(indexSrc, /cached\.state === region/);
	});

	it("prevents California Poppy midday.png misattribution in app/flower-detail.tsx", () => {
		const detailSrc = readRepoFile("app/flower-detail.tsx");
		assert.doesNotMatch(detailSrc, /midday\.png/);
		assert.match(detailSrc, /alternateImageUrlFor/);
		assert.match(detailSrc, /NO PHOTO CACHED/);
		assert.match(detailSrc, /BLOOM SEASON:/);
	});
});
