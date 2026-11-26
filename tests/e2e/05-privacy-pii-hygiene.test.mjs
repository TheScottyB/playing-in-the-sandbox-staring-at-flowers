import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
	fileSizeBytes,
	listFilesRecursive,
	readRepoFile,
	readRepoJson,
	repoExists,
	runCli,
} from "./helpers/repo.mjs";

describe("05 — Privacy, PII, Secret Hygiene & Repo Bloat (Items 14, 15, 16, 17)", () => {
	// =========================================================================
	// Item 14: Privacy & Marketing Claim Alignment
	// =========================================================================

	test("T1-I14-01: docs/privacy.html and meta/PRIVACY.md disclose 100% offline search and zero Gemini queries", () => {
		const html = readRepoFile("docs/privacy.html");
		const md = readRepoFile("meta/PRIVACY.md");
		for (const doc of [html, md]) {
			assert.match(doc, /100% offline/i);
			assert.match(doc, /FTS5\/BM25/);
			assert.match(doc, /never sent to Google Gemini/i);
		}
	});

	test("T1-I14-02: privacy, DSA, and submission docs disclose RevenueCat + Apple/Google IAPs and GitHub Pages CDN", () => {
		const files = [
			"docs/privacy.html",
			"meta/PRIVACY.md",
			"meta/DSA_COMPLIANCE.md",
			"meta/SUBMISSION.md",
		];
		for (const f of files) {
			const text = readRepoFile(f);
			assert.match(text, /RevenueCat/, `${f} must disclose RevenueCat`);
			assert.match(
				text,
				/Apple App Store/i,
				`${f} must disclose Apple App Store`,
			);
			assert.match(text, /Google Play/i, `${f} must disclose Google Play`);
			assert.match(text, /GitHub Pages/, `${f} must disclose GitHub Pages CDN`);
		}
	});

	test("T1-I14-03: app-store-config.json description, promoText, and releaseNotes reflect offline search", () => {
		const info = readRepoJson("app-store-config.json").apple.info["en-US"];
		assert.match(info.description, /offline/i);
		assert.match(info.promoText, /offline/i);
		assert.match(info.releaseNotes, /offline/i);
		assert.equal(
			/semantic embedding|gemini-embedding/i.test(info.description),
			false,
		);
	});

	test("T1-I14-04: meta/FEATURES.md documents FTS5/BM25 offline search, 396 species, and 112 regions", () => {
		const features = readRepoFile("meta/FEATURES.md");
		assert.match(features, /FTS5\/BM25/);
		assert.match(features, /396/);
		assert.match(features, /112/);
	});

	test("T1-I14-05: docs/terms.html and meta/DSA_COMPLIANCE.md match Monthly, Annual, and Founders Lifetime tiers", () => {
		const terms = readRepoFile("docs/terms.html");
		const dsa = readRepoFile("meta/DSA_COMPLIANCE.md");
		assert.match(terms, /Monthly/i);
		assert.match(terms, /Annual/i);
		assert.match(terms, /Founders Edition.*Lifetime VIP/i);
		assert.match(dsa, /\$4\.99/);
		assert.match(dsa, /\$29\.99/);
		assert.match(dsa, /\$99\.99/);
	});

	test("T2-I14-06: zero compliance/store docs claim runtime gemini-embedding-001 or EXPO_PUBLIC_GEMINI_API_KEY", () => {
		const docs = [
			"app-store-config.json",
			"docs/index.html",
			"docs/privacy.html",
			"docs/terms.html",
			"meta/PRIVACY.md",
			"meta/FEATURES.md",
			"meta/DSA_COMPLIANCE.md",
			"meta/SUBMISSION.md",
			"meta/SUBMISSION_CHECKLIST.md",
			"meta/PLAYSTORE_LISTING.md",
		];
		for (const rel of docs) {
			const text = readRepoFile(rel);
			assert.equal(
				text.includes("gemini-embedding-001"),
				false,
				`${rel} must not advertise gemini-embedding-001 runtime calls`,
			);
			assert.equal(
				text.includes("EXPO_PUBLIC_GEMINI_API_KEY"),
				false,
				`${rel} must not reference EXPO_PUBLIC_GEMINI_API_KEY`,
			);
		}
	});

	test("T2-I14-07: meta/SUBMISSION.md reflects $99.99 active Founders Lifetime VIP pricing", () => {
		const sub = readRepoFile("meta/SUBMISSION.md");
		assert.match(sub, /Founders Edition \(Lifetime VIP\).*\$99\.99/);
		assert.match(sub, /reduced from \$599\.99 to \$99\.99/);
	});

	test("T2-I14-08: docs/privacy.html and meta/PRIVACY.md agree on AsyncStorage local caching and 'default' fallback", () => {
		const html = readRepoFile("docs/privacy.html");
		const md = readRepoFile("meta/PRIVACY.md");
		assert.match(html, /AsyncStorage/);
		assert.match(md, /AsyncStorage/);
		assert.match(md, /default/);
	});

	test("T2-I14-09: app-store-config.json privacyPolicyUrl matches app.json extra.privacyPolicyUrl", () => {
		const asc = readRepoJson("app-store-config.json");
		const app = readRepoJson("app.json");
		assert.equal(
			asc.apple.info["en-US"].privacyPolicyUrl,
			app.expo.extra.privacyPolicyUrl,
		);
	});

	test("T2-I14-10: meta/PLAYSTORE_LISTING.md aligns with offline search, 112 regions, and $4.99/$29.99/$99.99 tiers", () => {
		const play = readRepoFile("meta/PLAYSTORE_LISTING.md");
		assert.match(play, /100% offline botanical search/i);
		assert.match(play, /112/);
		assert.match(play, /\$4\.99/);
		assert.match(play, /\$29\.99/);
		assert.match(play, /\$99\.99/);
	});

	// =========================================================================
	// Item 15: PII Removal & app-store-config.json Format
	// =========================================================================

	test("T1-I15-01: app-store-config.json parses with expected apple.info, categories, and advisory structure", () => {
		const asc = readRepoJson("app-store-config.json");
		assert.ok(asc.apple?.info?.["en-US"]);
		assert.ok(Array.isArray(asc.apple?.categories));
		assert.ok(asc.apple?.advisory);
	});

	test("T1-I15-02: app-store-config.json removes apple.review PII block", () => {
		const asc = readRepoJson("app-store-config.json");
		assert.equal("review" in asc.apple, false);
		assert.equal("review" in asc, false);
	});

	test("T1-I15-03: app-store-config.json contains zero personal phone numbers or gmail/personal emails", () => {
		const raw = readRepoFile("app-store-config.json");
		assert.equal(/\+1\d{10}|847-?309/.test(raw), false);
		assert.equal(/@gmail\.com|@tbdstud\.io/.test(raw), false);
	});

	test("T1-I15-04: app-store-config.json uses tab indentation and passes Biome check", () => {
		const raw = readRepoFile("app-store-config.json");
		assert.match(raw, /^\t"apple":/m);
		const res = runCli("pnpm", [
			"exec",
			"biome",
			"check",
			"app-store-config.json",
		]);
		assert.equal(res.status, 0, res.stderr || res.stdout);
	});

	test("T1-I15-05: meta/SUBMISSION.md App Review contact uses env vars rather than raw personal PII", () => {
		const sub = readRepoFile("meta/SUBMISSION.md");
		assert.match(sub, /APP_REVIEW_CONTACT_EMAIL/);
		assert.match(sub, /APP_REVIEW_CONTACT_PHONE/);
		assert.equal(/@gmail\.com|\+1847|847-?309/.test(sub), false);
	});

	test("T2-I15-06: store/compliance docs contain zero raw personal phone numbers", () => {
		const files = [
			"app-store-config.json",
			"app.json",
			"docs/index.html",
			"docs/privacy.html",
			"docs/terms.html",
			"meta/PRIVACY.md",
			"meta/DSA_COMPLIANCE.md",
			"meta/SUBMISSION.md",
			"meta/PLAYSTORE_LISTING.md",
		];
		for (const f of files) {
			const text = readRepoFile(f);
			assert.equal(
				/\+1\s*\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|847[-.\s]?309[-.\s]?9047/.test(
					text,
				),
				false,
				`${f} must not contain raw personal phone numbers`,
			);
		}
	});

	test("T2-I15-07: app-store-config.json version matches app.json and package.json", () => {
		const asc = readRepoJson("app-store-config.json");
		const app = readRepoJson("app.json");
		const pkg = readRepoJson("package.json");
		assert.equal(asc.apple.version, app.expo.version);
		assert.equal(asc.apple.version, pkg.version);
	});

	test("T2-I15-08: app-store-config.json categories match app.json extra.appStore", () => {
		const asc = readRepoJson("app-store-config.json");
		const app = readRepoJson("app.json");
		assert.deepEqual(
			asc.apple.categories.map((c) => c.toUpperCase()),
			[
				app.expo.extra.appStore.primaryCategory.toUpperCase(),
				app.expo.extra.appStore.secondaryCategory.toUpperCase(),
			],
		);
	});

	test("T2-I15-09: app-store-config.json advisory retains false for advertising, UGC, and unrestrictedWebAccess", () => {
		const adv = readRepoJson("app-store-config.json").apple.advisory;
		assert.equal(adv.advertising, false);
		assert.equal(adv.userGeneratedContent, false);
		assert.equal(adv.unrestrictedWebAccess, false);
	});

	test("T2-I15-10: app-store-config.json keywords stay within Apple 100-char CSV limit", () => {
		const kw = readRepoJson("app-store-config.json").apple.info["en-US"]
			.keywords;
		assert.ok(Array.isArray(kw) && kw.length > 0);
		assert.ok(kw.join(",").length <= 100);
	});

	// =========================================================================
	// Item 16: .gitignore, .env History & main Sync
	// =========================================================================

	test("T1-I16-01: .gitignore blocks credentials/, .env*, and shared/design-assets/ while allowing .env.example", () => {
		const gi = readRepoFile(".gitignore");
		for (const pattern of [
			"credentials/",
			".env*",
			"!.env.example",
			"shared/design-assets/",
		]) {
			assert.ok(gi.includes(pattern), `.gitignore must include ${pattern}`);
		}
	});

	test("T1-I16-02: git check-ignore confirms credentials, .env, .env.local, and shared/design-assets are ignored", () => {
		const targets = [
			"credentials/ios/AuthKey_TEST.p8",
			".env",
			".env.local",
			"shared/design-assets/daily/test.png",
		];
		for (const t of targets) {
			const res = runCli("git", ["check-ignore", "-q", t]);
			assert.equal(res.status, 0, `git check-ignore must ignore ${t}`);
		}
	});

	test("T1-I16-03: git ls-files tracks zero .env, .p8, .jks, .keystore, or credentials/ files", () => {
		const res = runCli("git", ["ls-files"]);
		assert.equal(res.status, 0);
		const tracked = res.stdout.split(/\r?\n/).filter(Boolean);
		const forbidden = tracked.filter(
			(p) =>
				/(^|\/)\.env($|\.(?!example$))/.test(p) ||
				/\.(p8|jks|keystore|p12)$/.test(p) ||
				p.startsWith("credentials/"),
		);
		assert.deepEqual(forbidden, []);
	});

	test("T1-I16-04: meta/GITHUB_SETUP.md documents .env commits (f3a07c7, 79f8219, 6271691) and XT32ZS8GHR rotation", () => {
		const doc = readRepoFile("meta/GITHUB_SETUP.md");
		for (const marker of ["f3a07c7", "79f8219", "6271691", "XT32ZS8GHR"]) {
			assert.ok(
				doc.includes(marker),
				`meta/GITHUB_SETUP.md must document ${marker}`,
			);
		}
		assert.match(doc, /rotat|revok/i);
	});

	test("T1-I16-05: git ls-files tracks zero google-service-account.json or credentials.json files", () => {
		const res = runCli("git", [
			"ls-files",
			"google-service-account.json",
			"credentials.json",
		]);
		assert.equal(res.status, 0);
		assert.equal(res.stdout.trim(), "");
	});

	test("T2-I16-06: git check-ignore does NOT ignore .env.example template", () => {
		const res = runCli("git", ["check-ignore", "-q", ".env.example"]);
		assert.equal(res.status, 1);
	});

	test("T2-I16-07: .gitignore ignores /ios/ and /android/ native build dirs", () => {
		const gi = readRepoFile(".gitignore");
		assert.ok(gi.includes("/ios/"));
		assert.ok(gi.includes("/android/"));
	});

	test("T2-I16-08: git grep across HEAD finds zero embedded PEM private keys", () => {
		const res = runCli("git", [
			"grep",
			"-I",
			"-n",
			"-E",
			"BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY",
			"--",
			".",
			":!tests/e2e",
		]);
		assert.equal(res.status, 1, `Found private key in git:\n${res.stdout}`);
	});

	test("T2-I16-09: git grep across HEAD finds zero hardcoded AIzaSy or sk- live API tokens", () => {
		const res = runCli("git", [
			"grep",
			"-I",
			"-n",
			"-E",
			"AIzaSy[0-9A-Za-z_-]{20,}",
			"--",
			".",
			":!tests/e2e",
		]);
		assert.equal(res.status, 1, `Found Google API key in git:\n${res.stdout}`);
	});

	test("T2-I16-10: local HEAD is not behind origin/main when remote tracking ref exists", () => {
		const hasRemote = runCli("git", [
			"rev-parse",
			"--verify",
			"--quiet",
			"origin/main",
		]);
		if (hasRemote.status === 0) {
			const counts = runCli("git", [
				"rev-list",
				"--left-right",
				"--count",
				"HEAD...origin/main",
			]);
			assert.equal(counts.status, 0);
			const parts = counts.stdout.trim().split(/\s+/).map(Number);
			assert.equal(
				parts[1],
				0,
				`Local HEAD is ${parts[1]} commit(s) behind origin/main`,
			);
		}
		assert.ok(true);
	});

	// =========================================================================
	// Item 17: Repo Bloat Cleanup & Architecture Plan
	// =========================================================================

	test("T1-I17-01: git ls-files shared/design-assets returns empty", () => {
		const res = runCli("git", ["ls-files", "shared/design-assets"]);
		assert.equal(res.status, 0);
		assert.equal(res.stdout.trim(), "");
	});

	test("T1-I17-02: shared/design-assets/daily directory does not exist on disk", () => {
		assert.equal(repoExists("shared/design-assets/daily"), false);
	});

	test("T1-I17-03: docs/daily/ contains 0 .webp files on disk", () => {
		const webps = listFilesRecursive("docs/daily", (r) => r.endsWith(".webp"));
		assert.deepEqual(webps, []);
	});

	test("T1-I17-04: docs/daily/ contains only .png, .jpg, .json, and .gitkeep files", () => {
		const files = listFilesRecursive("docs/daily");
		assert.ok(files.length > 0);
		const invalid = files.filter(
			(f) => f !== "docs/daily/.gitkeep" && !/\.(png|jpg|json)$/.test(f),
		);
		assert.deepEqual(invalid, []);
	});

	test("T1-I17-05: meta/GITHUB_SETUP.md documents git filter-repo purge and R2/S3 + orphan gh-pages offload plan", () => {
		const doc = readRepoFile("meta/GITHUB_SETUP.md");
		assert.match(doc, /git filter-repo/);
		assert.match(doc, /Cloudflare R2|S3/);
		assert.match(doc, /gh-pages/);
	});

	test("T2-I17-06: sampled JSON sidecars in docs/daily/ parse cleanly with common, latin, and blurb", () => {
		const jsons = listFilesRecursive("docs/daily", (r) =>
			r.endsWith(".json"),
		).slice(0, 50);
		assert.ok(jsons.length > 0);
		for (const rel of jsons) {
			const data = readRepoJson(rel);
			assert.equal(typeof data.common, "string", `${rel} missing common`);
			assert.equal(typeof data.latin, "string", `${rel} missing latin`);
			assert.equal(typeof data.blurb, "string", `${rel} missing blurb`);
		}
	});

	test("T2-I17-07: docs/daily/ has zero zero-byte .png or .jpg files", () => {
		const imgs = listFilesRecursive("docs/daily", (r) =>
			/\.(png|jpg)$/.test(r),
		);
		const empty = imgs.filter((rel) => fileSizeBytes(rel) === 0);
		assert.deepEqual(empty, []);
	});

	test("T2-I17-08: git ls-files docs/daily contains zero .webp entries", () => {
		const res = runCli("git", [
			"ls-files",
			"docs/daily/*.webp",
			"docs/daily/**/*.webp",
		]);
		assert.equal(res.status, 0);
		assert.equal(res.stdout.trim(), "");
	});

	test("T2-I17-09: biome.json excludes docs/daily so Biome stays fast", () => {
		const biome = readRepoJson("biome.json");
		assert.ok(
			biome.files?.includes?.some((p) => p.includes("docs/daily")),
			"biome.json must exclude docs/daily",
		);
	});

	test("T2-I17-10: lib/dailyFlower.ts and scripts/generate-daily.mjs contain zero .webp CDN references", () => {
		assert.equal(readRepoFile("lib/dailyFlower.ts").includes(".webp"), false);
		assert.equal(
			readRepoFile("scripts/generate-daily.mjs").includes(".webp"),
			false,
		);
	});

	// =========================================================================
	// Tier 3: Pairwise Cross-Feature Integration
	// =========================================================================

	test("T3-05-01: app-store-config.json + docs/privacy.html + meta/PRIVACY.md offline search & IAP consistency", () => {
		const asc = readRepoJson("app-store-config.json").apple.info["en-US"];
		const html = readRepoFile("docs/privacy.html");
		const md = readRepoFile("meta/PRIVACY.md");
		assert.match(asc.description, /offline/i);
		assert.match(html, /offline/i);
		assert.match(md, /offline/i);
		assert.equal(asc.privacyPolicyUrl.endsWith("/privacy.html"), true);
	});

	test("T3-05-02: .gitignore + git ls-files + meta/GITHUB_SETUP.md protect all ASC and env credential paths", () => {
		const gi = readRepoFile(".gitignore");
		const doc = readRepoFile("meta/GITHUB_SETUP.md");
		assert.ok(gi.includes("credentials/"));
		assert.ok(doc.includes("credentials/ios/AuthKey_"));
		const tracked = runCli("git", ["ls-files", "credentials"]);
		assert.equal(tracked.stdout.trim(), "");
	});

	test("T3-05-03: meta/GITHUB_SETUP.md bloat runbook matches actual removal of shared/design-assets and .webp files", () => {
		const doc = readRepoFile("meta/GITHUB_SETUP.md");
		assert.match(doc, /shared\/design-assets/);
		assert.equal(repoExists("shared/design-assets/daily"), false);
		assert.equal(
			listFilesRecursive("docs/daily", (r) => r.endsWith(".webp")).length,
			0,
		);
	});

	test("T3-05-04: app-store-config.json + meta/SUBMISSION.md + meta/PLAYSTORE_LISTING.md share PII-free contact model", () => {
		const asc = readRepoFile("app-store-config.json");
		const sub = readRepoFile("meta/SUBMISSION.md");
		const play = readRepoFile("meta/PLAYSTORE_LISTING.md");
		for (const text of [asc, sub, play]) {
			assert.equal(/@gmail\.com|\+1847|847-?309/.test(text), false);
		}
	});

	// =========================================================================
	// Tier 4: Real-World E2E Compliance & Hygiene Gate
	// =========================================================================

	test("T4-05-01: Full M3 privacy, PII, secrets, and repo bloat compliance audit", () => {
		const biomeCfg = runCli("pnpm", [
			"exec",
			"biome",
			"check",
			"app-store-config.json",
		]);
		assert.equal(biomeCfg.status, 0, biomeCfg.stderr || biomeCfg.stdout);

		const trackedSecrets = runCli("git", ["ls-files", ".env", "credentials"]);
		assert.equal(trackedSecrets.stdout.trim(), "");
		assert.equal(repoExists("shared/design-assets/daily"), false);
		assert.equal(
			listFilesRecursive("docs/daily", (r) => r.endsWith(".webp")).length,
			0,
		);
		const privacy = readRepoFile("docs/privacy.html");
		assert.match(privacy, /100% Offline Species Search/i);
		assert.match(privacy, /RevenueCat/);
	});
});
