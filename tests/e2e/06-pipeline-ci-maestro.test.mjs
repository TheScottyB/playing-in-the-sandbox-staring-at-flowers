import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import {
	createEphemeralEcPrivateKeyPem,
	createPngBase64,
	createPngBuffer,
} from "./helpers/fixtures.mjs";
import { startMockServer } from "./helpers/mock-http.mjs";
import {
	listFilesRecursive,
	readRepoFile,
	readRepoJson,
	runCli,
	validateYamlBasic,
} from "./helpers/repo.mjs";
import { createE2EContext } from "./helpers/rn-loader.mjs";
import {
	runScriptInSandbox,
	runScriptInSandboxAsync,
} from "./helpers/sandbox.mjs";

function shiftIso(baseIso, daysDelta) {
	const d = new Date(`${baseIso}T12:00:00Z`);
	d.setUTCDate(d.getUTCDate() + daysDelta);
	return d.toISOString().slice(0, 10);
}

function parseYamlScalar(raw) {
	const trimmed = raw.trim();
	if (trimmed.startsWith('"')) {
		const m = trimmed.match(/^"([^"]*)"/);
		return m ? m[1] : trimmed;
	}
	if (trimmed.startsWith("'")) {
		const m = trimmed.match(/^'([^']*)'/);
		return m ? m[1] : trimmed;
	}
	return trimmed.replace(/\s+#.*$/, "").trim();
}

function extractPushTriggerList(yamlText, keyName) {
	const lines = yamlText.split(/\r?\n/);
	let inOn = false;
	let onIndent = -1;
	let inPush = false;
	let pushIndent = -1;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const indent = line.match(/^ */)[0].length;

		if (!inOn) {
			if (/^on:\s*(#.*)?$/.test(trimmed)) {
				inOn = true;
				onIndent = indent;
			}
			continue;
		}
		if (indent <= onIndent) {
			inOn = false;
			inPush = false;
			i--;
			continue;
		}
		if (!inPush) {
			if (/^push:\s*(#.*)?$/.test(trimmed)) {
				inPush = true;
				pushIndent = indent;
			}
			continue;
		}
		if (indent <= pushIndent) {
			inPush = false;
			i--;
			continue;
		}

		if (!trimmed.startsWith(`${keyName}:`)) continue;
		const rest = trimmed.slice(keyName.length + 1).trim();
		if (rest.startsWith("[")) {
			const endBracket = rest.indexOf("]");
			if (endBracket !== -1) {
				return rest
					.slice(1, endBracket)
					.split(",")
					.map((s) => parseYamlScalar(s))
					.filter(Boolean);
			}
		}

		const items = [];
		for (let j = i + 1; j < lines.length; j++) {
			const sub = lines[j];
			const subTrimmed = sub.trim();
			if (subTrimmed === "" || subTrimmed.startsWith("#")) continue;
			const subIndent = sub.match(/^ */)[0].length;
			if (subTrimmed.startsWith("- ") && subIndent >= indent) {
				items.push(parseYamlScalar(subTrimmed.slice(2)));
			} else {
				break;
			}
		}
		return items;
	}
	return null;
}

describe("06 — Pipeline, CI/EAS, ASC Scripts & Maestro E2E (Items 18, 19, 20, 21)", () => {
	// =========================================================================
	// Item 18: scripts/generate-daily.mjs Pipeline Fixes
	// =========================================================================

	test("T1-I18-01: generate-daily.mjs DRY_RUN=1 without --states includes 'default', US, and international buckets", () => {
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-05-15"],
			env: { DRY_RUN: "1" },
			inspect: (projectRoot) => ({
				hasDefault: existsSync(
					join(projectRoot, "docs/daily/default/2026-05-15.json"),
				),
				hasCA: existsSync(join(projectRoot, "docs/daily/CA/2026-05-15.json")),
				hasMX: existsSync(
					join(projectRoot, "docs/daily/MX-MEX/2026-05-15.json"),
				),
				hasRU: existsSync(
					join(projectRoot, "docs/daily/RU-MOW/2026-05-15.json"),
				),
				hasCN: existsSync(
					join(projectRoot, "docs/daily/CN-BJ/2026-05-15.json"),
				),
			}),
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		assert.equal(
			res.inspectResult.hasDefault,
			true,
			'Must generate "default" bucket',
		);
		assert.equal(res.inspectResult.hasCA, true);
		assert.equal(
			res.inspectResult.hasMX,
			true,
			"Must generate international MX-MEX bucket (US_ONLY must be false)",
		);
		assert.equal(res.inspectResult.hasRU, true);
		assert.equal(res.inspectResult.hasCN, true);
	});

	test("T1-I18-02: generate-daily.mjs writes sidecar JSON with common, latin, blurb, generatedAt, and imageExt: 'png'", async () => {
		const b64 = await createPngBase64();
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-04-15", "--states", "CA"],
			env: { GEMINI_API_KEY: "test_key" },
			preloadCode: `
				globalThis.fetch = async () => new Response(JSON.stringify({
					candidates: [{ content: { parts: [
						{ inlineData: { mimeType: "image/png", data: ${JSON.stringify(b64)} } },
						{ text: "Bright orange wildflower blooming on sunny hillsides." },
					] } }],
				}), { status: 200 });
			`,
			inspect: (projectRoot) =>
				JSON.parse(
					readFileSync(
						join(projectRoot, "docs/daily/CA/2026-04-15.json"),
						"utf8",
					),
				),
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		assert.equal(typeof res.inspectResult.common, "string");
		assert.equal(typeof res.inspectResult.latin, "string");
		assert.equal(typeof res.inspectResult.blurb, "string");
		assert.equal(typeof res.inspectResult.generatedAt, "string");
		assert.equal(
			res.inspectResult.imageExt,
			"png",
			'Sidecar JSON must include imageExt: "png"',
		);
	});

	test("T1-I18-03: generate-daily.mjs derives blooming month from --date in UTC rather than wall-clock month", async () => {
		const b64 = await createPngBase64();
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-01-15", "--states", "CA"],
			env: { GEMINI_API_KEY: "test_key" },
			mockTimeIso: "2026-08-10T12:00:00Z",
			preloadCode: `
				globalThis.fetch = async (_url, init) => {
					const payload = JSON.parse(init.body);
					console.log("E2E_PROMPT=" + payload.contents[0].parts[0].text);
					return new Response(JSON.stringify({
						candidates: [{ content: { parts: [
							{ inlineData: { mimeType: "image/png", data: ${JSON.stringify(b64)} } },
							{ text: "Winter bloom." },
						] } }],
					}), { status: 200 });
				};
			`,
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		assert.match(
			res.stdout,
			/E2E_PROMPT=.*blooming in January/,
			"Prompt month must come from targetDate (January), not wall-clock August",
		);
	});

	test("T1-I18-04: generate-daily.mjs day 6/7/8/9 archive keeps 2-day PNG/JPG overlap and updates sidecar imageExt", async () => {
		const target = "2026-05-15";
		const d6 = shiftIso(target, -6);
		const d7 = shiftIso(target, -7);
		const d8 = shiftIso(target, -8);
		const d9 = shiftIso(target, -9);
		const pngBuf = await createPngBuffer({ width: 16, height: 16 });
		const sidecar = (d) =>
			JSON.stringify({
				common: "Poppy",
				latin: "Eschscholzia californica",
				blurb: "Orange bloom.",
				generatedAt: `${d}T11:00:00.000Z`,
				imageExt: "png",
			});

		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", target, "--states", "CA"],
			env: { DRY_RUN: "1" },
			seedFiles: {
				[`docs/daily/CA/${d6}.png`]: pngBuf,
				[`docs/daily/CA/${d6}.json`]: sidecar(d6),
				[`docs/daily/CA/${d7}.png`]: pngBuf,
				[`docs/daily/CA/${d7}.json`]: sidecar(d7),
				[`docs/daily/CA/${d8}.png`]: pngBuf,
				[`docs/daily/CA/${d8}.json`]: sidecar(d8),
				[`docs/daily/CA/${d9}.png`]: pngBuf,
				[`docs/daily/CA/${d9}.json`]: sidecar(d9),
			},
			inspect: (projectRoot) => {
				const dir = join(projectRoot, "docs/daily/CA");
				return {
					d6Png: existsSync(join(dir, `${d6}.png`)),
					d6Jpg: existsSync(join(dir, `${d6}.jpg`)),
					d7Png: existsSync(join(dir, `${d7}.png`)),
					d7Jpg: existsSync(join(dir, `${d7}.jpg`)),
					d7Ext: JSON.parse(readFileSync(join(dir, `${d7}.json`), "utf8"))
						.imageExt,
					d8Png: existsSync(join(dir, `${d8}.png`)),
					d8Jpg: existsSync(join(dir, `${d8}.jpg`)),
					d8Ext: JSON.parse(readFileSync(join(dir, `${d8}.json`), "utf8"))
						.imageExt,
					d9Png: existsSync(join(dir, `${d9}.png`)),
					d9Jpg: existsSync(join(dir, `${d9}.jpg`)),
					d9Ext: JSON.parse(readFileSync(join(dir, `${d9}.json`), "utf8"))
						.imageExt,
				};
			},
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		const r = res.inspectResult;
		assert.equal(r.d6Png, true);
		assert.equal(r.d6Jpg, false);
		assert.equal(r.d7Jpg, true, "Day 7 must generate .jpg");
		assert.equal(r.d7Png, true, "Day 7 must preserve .png overlap");
		assert.equal(r.d7Ext, "jpg", "Day 7 sidecar imageExt must update to jpg");
		assert.equal(r.d8Jpg, true, "Day 8 must have .jpg");
		assert.equal(r.d8Png, true, "Day 8 must preserve .png overlap");
		assert.equal(r.d8Ext, "jpg");
		assert.equal(r.d9Jpg, true, "Day 9 must preserve .jpg");
		assert.equal(r.d9Png, false, "Day 9 must delete .png");
		assert.equal(r.d9Ext, "jpg");
	});

	test("T1-I18-05: generate-daily.mjs --missing-only skips partial files while heal mode regenerates 0-byte images", () => {
		const resSkip = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-05-15", "--states", "CA", "--missing-only"],
			env: { DRY_RUN: "1" },
			seedFiles: {
				"docs/daily/CA/2026-05-15.json": '{"common":"Existing"}',
			},
			inspect: (projectRoot) => ({
				hasPng: existsSync(join(projectRoot, "docs/daily/CA/2026-05-15.png")),
			}),
		});
		assert.equal(resSkip.status, 0);
		assert.equal(resSkip.inspectResult.hasPng, false);

		const resHeal = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-05-15", "--states", "CA"],
			env: { DRY_RUN: "1" },
			seedFiles: {
				"docs/daily/CA/2026-05-15.png": Buffer.alloc(0),
				"docs/daily/CA/2026-05-15.json": '{"common":"Stale"}',
			},
			inspect: (projectRoot) =>
				JSON.parse(
					readFileSync(
						join(projectRoot, "docs/daily/CA/2026-05-15.json"),
						"utf8",
					),
				),
		});
		assert.equal(resHeal.status, 0);
		assert.notEqual(resHeal.inspectResult.common, "Stale");
	});

	test("T2-I18-06: generate-daily.mjs retries HTTP 429 twice with backoff and succeeds on attempt 3", async () => {
		const b64 = await createPngBase64();
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-05-15", "--states", "CA"],
			env: { GEMINI_API_KEY: "test_429_retry" },
			fastTimers: true,
			preloadCode: `
				let calls = 0;
				globalThis.fetch = async () => {
					calls += 1;
					if (calls <= 2) {
						return new Response(JSON.stringify({ error: { message: "Rate limit 429" } }), { status: 429 });
					}
					return new Response(JSON.stringify({
						candidates: [{ content: { parts: [
							{ inlineData: { mimeType: "image/png", data: ${JSON.stringify(b64)} } },
							{ text: "Recovered after 429." },
						] } }],
					}), { status: 200 });
				};
				process.on("exit", () => console.log("E2E_FETCH_CALLS=" + calls));
			`,
		});
		assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, /E2E_FETCH_CALLS=3/);
		assert.match(res.stdout, /Generated:\s*1 images/);
	});

	test("T2-I18-07: generate-daily.mjs persistent HTTP 429 exhausts retries cleanly without leaving 0-byte files", () => {
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", "2026-05-15", "--states", "CA"],
			env: { GEMINI_API_KEY: "test_429_fail" },
			fastTimers: true,
			preloadCode: `
				let calls = 0;
				globalThis.fetch = async () => {
					calls += 1;
					return new Response(JSON.stringify({ error: { message: "Rate limit 429" } }), { status: 429 });
				};
				process.on("exit", () => console.log("E2E_FETCH_CALLS=" + calls));
			`,
			inspect: (projectRoot) => ({
				hasPng: existsSync(join(projectRoot, "docs/daily/CA/2026-05-15.png")),
			}),
		});
		assert.equal(res.status, 1);
		assert.equal(res.inspectResult.hasPng, false);
		const m = res.stdout.match(/E2E_FETCH_CALLS=(\d+)/);
		assert.ok(m && Number(m[1]) >= 3, "Must retry 429 before failing");
	});

	test("T2-I18-08: generate-daily.mjs contains zero hardcoded /Users/ paths", () => {
		const src = readRepoFile("scripts/generate-daily.mjs");
		assert.equal(/\/Users\/[A-Za-z0-9_.-]+/.test(src), false);
	});

	test("T2-I18-09: generate-daily.mjs todayIso() uses UTC date across TZ=America/Los_Angeles midnight", () => {
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--states", "CA"],
			env: { DRY_RUN: "1", TZ: "America/Los_Angeles" },
			mockTimeIso: "2026-05-02T03:00:00Z", // May 1 20:00 PDT, May 2 UTC
			inspect: (projectRoot) => ({
				utcExists: existsSync(
					join(projectRoot, "docs/daily/CA/2026-05-02.json"),
				),
				localExists: existsSync(
					join(projectRoot, "docs/daily/CA/2026-05-01.json"),
				),
			}),
		});
		assert.equal(res.status, 0);
		assert.equal(
			res.inspectResult.utcExists,
			true,
			"todayIso() must resolve UTC 2026-05-02 rather than local 2026-05-01",
		);
		assert.equal(res.inspectResult.localExists, false);
	});

	test("T2-I18-10: scripts/generate-daily.mjs passes Biome lint and formatting check", () => {
		const res = runCli("pnpm", [
			"exec",
			"biome",
			"check",
			"scripts/generate-daily.mjs",
		]);
		assert.equal(res.status, 0, res.stderr || res.stdout);
	});

	// =========================================================================
	// Item 19: CI pnpm Drift & EAS Workflow
	// =========================================================================

	test("T1-I19-01: package.json aligns volta.pnpm on 11.2.2 (and packageManager if set)", () => {
		const pkg = readRepoJson("package.json");
		assert.equal(pkg.volta?.pnpm, "11.2.2");
		if (pkg.packageManager) {
			assert.match(pkg.packageManager, /^pnpm@11\.2\.2/);
		}
	});

	test("T1-I19-02: .github/workflows/ci.yml does not pin pnpm version 10", () => {
		const ci = readRepoFile(".github/workflows/ci.yml");
		assert.equal(/version:\s*["']?10["']?/.test(ci), false);
	});

	test("T1-I19-03: .github/workflows/generate-daily.yml does not pin pnpm version 10", () => {
		const wf = readRepoFile(".github/workflows/generate-daily.yml");
		assert.equal(/version:\s*["']?10["']?/.test(wf), false);
	});

	test("T1-I19-04: .eas/workflows/update-on-push.yml has active uncommented push triggers", () => {
		const easWf = readRepoFile(".eas/workflows/update-on-push.yml");
		assert.equal(/^#\s*on:/m.test(easWf), false);
		assert.match(easWf, /^on:\s*$/m);
		assert.match(easWf, /^\s+push:\s*$/m);
	});

	test("T1-I19-05: .eas/workflows/update-on-push.yml maps main branch to production EAS channel", () => {
		const easWf = readRepoFile(".eas/workflows/update-on-push.yml");
		const easJson = readRepoJson("eas.json");
		assert.equal(easJson.build?.production?.channel, "production");
		assert.match(easWf, /production/);
		assert.equal(
			/channel:\s*\$\{\{\s*github\.ref_name/.test(easWf),
			false,
			"Must map main -> production rather than passing raw github.ref_name as channel",
		);
	});

	test("T2-I19-06: .eas/workflows/update-on-push.yml excludes docs/daily/** from push OTA triggers", () => {
		const easWf = readRepoFile(".eas/workflows/update-on-push.yml");
		const pathsIgnore = extractPushTriggerList(easWf, "paths-ignore");
		const paths = extractPushTriggerList(easWf, "paths");

		const hasPathsIgnore =
			Array.isArray(pathsIgnore) &&
			pathsIgnore.some((p) => /^docs\/(daily\/)?\*\*$/.test(p));

		const hasCatchAll =
			Array.isArray(paths) && paths.some((p) => p === "**" || p === "*");
		const hasNegatedDocsDaily =
			Array.isArray(paths) &&
			paths.some((p) => /^!docs\/(daily\/)?\*\*$/.test(p));
		const hasNegatedPaths = hasCatchAll && hasNegatedDocsDaily;

		assert.ok(
			hasPathsIgnore || hasNegatedPaths,
			`Expected on.push to exclude docs/daily/** via either paths-ignore: [docs/daily/**] or paths: ["**", "!docs/daily/**"]. Found paths-ignore=${JSON.stringify(pathsIgnore)}, paths=${JSON.stringify(paths)}`,
		);
	});

	test("T2-I19-07: .github/workflows/ci.yml executes pnpm db:smoke and automated tests", () => {
		const ci = readRepoFile(".github/workflows/ci.yml");
		assert.match(ci, /pnpm typecheck/);
		assert.match(ci, /pnpm lint/);
		assert.match(ci, /pnpm db:smoke/);
		assert.match(ci, /pnpm test|node\s+.*--test/);
	});

	test("T2-I19-08: .github/workflows/generate-daily.yml stages only docs/daily/ and handles inputs", () => {
		const wf = readRepoFile(".github/workflows/generate-daily.yml");
		assert.match(wf, /git add docs\/daily\//);
		assert.match(wf, /missing_only/);
		assert.match(wf, /dry_run/);
	});

	test("T2-I19-09: all GitHub and EAS workflow YAML files pass structural YAML checks", () => {
		const yamls = [
			".github/workflows/ci.yml",
			".github/workflows/generate-daily.yml",
			".eas/workflows/update-on-push.yml",
		];
		for (const y of yamls) {
			const errs = validateYamlBasic(readRepoFile(y));
			assert.deepEqual(errs, [], `${y} YAML errors: ${errs.join("; ")}`);
		}
	});

	test("T2-I19-10: package.json test script runs automated tests (not echo placeholder)", () => {
		const pkg = readRepoJson("package.json");
		assert.equal(pkg.scripts.test.includes("No unit tests configured"), false);
		assert.match(pkg.scripts.test, /node\b.*--test/);
	});

	// =========================================================================
	// Item 20: Screenshot & ASC Scripts Fixes
	// =========================================================================

	test("T1-I20-01: scripts/verify_screenshots.mjs references pnpm screenshots:verify (no qc-screenshots)", () => {
		const src = readRepoFile("scripts/verify_screenshots.mjs");
		assert.equal(src.includes("qc-screenshots"), false);
		assert.match(src, /screenshots:verify/);
	});

	test("T1-I20-02: verify_screenshots.mjs handles corrupt image (format: null) without TypeError", () => {
		const res = runScriptInSandbox("scripts/verify_screenshots.mjs", {
			seedFiles: {
				"store/apple/screenshot/en-US/iphone67_corrupt.png":
					"not a real png binary",
			},
			unsetEnv: ["GEMINI_API_KEY"],
		});
		assert.equal(
			res.status,
			0,
			`verify_screenshots crashed on null format:\n${res.stdout}\n${res.stderr}`,
		);
		assert.equal(res.stderr.includes("TypeError"), false);
	});

	test("T1-I20-03: verify_screenshots.mjs generates qc_report.md with relative paths and zero file:// links", async () => {
		const buf = await createPngBuffer({ width: 100, height: 100 });
		const res = runScriptInSandbox("scripts/verify_screenshots.mjs", {
			seedFiles: {
				"store/apple/screenshot/en-US/iphone67_home.png": buf,
			},
			unsetEnv: ["GEMINI_API_KEY"],
			inspect: (projectRoot) => {
				const candidates = [
					join(projectRoot, "store/apple/screenshot/en-US/qc_report.md"),
					join(projectRoot, "app_store_assets/screenshots/qc_report.md"),
				];
				const found = candidates.find((p) => existsSync(p));
				return found ? readFileSync(found, "utf8") : null;
			},
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		assert.ok(res.inspectResult, "qc_report.md must be written");
		assert.equal(res.inspectResult.includes("file://"), false);
	});

	test("T1-I20-04: scripts/manage-subscriptions.mjs defines $4.99, $29.99, $99.99 products and paginates links.next", () => {
		const src = readRepoFile("scripts/manage-subscriptions.mjs");
		assert.match(src, /4\.99/);
		assert.match(src, /29\.99/);
		assert.match(src, /99\.99/);
		assert.match(src, /links\??\.next/);
	});

	test("T1-I20-05: delete-draft-submission.mjs & remove-version-from-submission.mjs fail cleanly when ASC credentials missing", () => {
		for (const script of [
			"scripts/delete-draft-submission.mjs",
			"scripts/remove-version-from-submission.mjs",
		]) {
			const res = runScriptInSandbox(script, {
				linkEasKit: true,
				unsetEnv: [
					"APP_STORE_CONNECT_KEY_ID",
					"APP_STORE_CONNECT_ISSUER_ID",
					"APP_STORE_CONNECT_PRIVATE_KEY",
					"APP_STORE_CONNECT_PRIVATE_KEY_PATH",
					"APP_STORE_CONNECT_APP_ID",
				],
			});
			assert.notEqual(
				res.status,
				0,
				`${script} must fail when credentials missing`,
			);
			assert.equal(
				res.stderr.includes("error.key") ||
					res.stderr.includes("Cannot read properties of undefined"),
				false,
				`${script} threw raw TypeError in parsePrivateKey instead of credential validation`,
			);
		}
	});

	test("T2-I20-06: verify_screenshots.mjs retries Gemini Vision HTTP 429 before failing", async () => {
		const buf = await createPngBuffer({ width: 100, height: 100 });
		const res = runScriptInSandbox("scripts/verify_screenshots.mjs", {
			seedFiles: {
				"store/apple/screenshot/en-US/iphone67_home.png": buf,
			},
			env: { GEMINI_API_KEY: "test_vision_429" },
			fastTimers: true,
			preloadCode: `
				let calls = 0;
				globalThis.fetch = async () => {
					calls += 1;
					if (calls === 1) {
						return new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 });
					}
					return new Response(JSON.stringify({
						candidates: [{ content: { parts: [{ text: JSON.stringify({
							isHomeScreen: false,
							isDevLauncher: false,
							hasDebugOverlay: false,
							hasPopupOrModal: false,
							statusBarTime: "9:41",
							explanation: "Clean",
						}) }] } }],
					}), { status: 200 });
				};
				process.on("exit", () => console.log("E2E_VISION_CALLS=" + calls));
			`,
		});
		assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, /E2E_VISION_CALLS=2/);
	});

	test("T2-I20-07: verify_screenshots.mjs detects alpha channel & bad dimensions on RGBA PNG and exits 0 on empty dir", async () => {
		const rgbaBuf = await createPngBuffer({
			width: 64,
			height: 64,
			rgba: 0xff000080,
		});
		const resImg = runScriptInSandbox("scripts/verify_screenshots.mjs", {
			seedFiles: {
				"store/apple/screenshot/en-US/iphone67_bad.png": rgbaBuf,
			},
			unsetEnv: ["GEMINI_API_KEY"],
		});
		assert.equal(resImg.status, 0);
		assert.match(resImg.stdout, /alpha channel/i);
		assert.match(resImg.stdout, /Invalid dimensions/i);

		// Empty existing dir returns 0
		const resEmptyDir = runScriptInSandbox("scripts/verify_screenshots.mjs", {
			seedFiles: {
				"store/apple/screenshot/en-US/.keep": "",
			},
			unsetEnv: ["GEMINI_API_KEY"],
		});
		assert.equal(
			resEmptyDir.status,
			0,
			resEmptyDir.stderr || resEmptyDir.stdout,
		);
		assert.ok(resImg.stdout.length > 0);
	});

	test("T2-I20-08: manage-subscriptions.mjs traverses paginated ASC responses and configures $4.99/$29.99/$99.99", async () => {
		const privateKeyPem = createEphemeralEcPrivateKeyPem();
		const server = await startMockServer((req, res) => {
			res.setHeader("Content-Type", "application/json");
			if (req.url.startsWith("/v1/apps/12345?")) {
				res.end(
					JSON.stringify({
						data: {
							id: "12345",
							attributes: { name: "Specimen Sandbox", bundleId: "com.test" },
						},
					}),
				);
				return;
			}
			if (req.url.startsWith("/v1/apps/12345/subscriptionGroups")) {
				res.end(
					JSON.stringify({
						data: [
							{
								id: "grp1",
								attributes: { referenceName: "Premium Subscription Group" },
							},
						],
					}),
				);
				return;
			}
			if (req.url.startsWith("/v1/subscriptionGroups/grp1/subscriptions")) {
				res.end(
					JSON.stringify({
						data: [
							{
								id: "subM",
								attributes: {
									name: "Premium Monthly",
									productId:
										"com.djscottyb.playinginthesandoxlookingatflowers.premium_monthly",
								},
							},
							{
								id: "subA",
								attributes: {
									name: "Premium Annual",
									productId:
										"com.djscottyb.playinginthesandoxlookingatflowers.premium_annual",
								},
							},
						],
					}),
				);
				return;
			}
			if (req.url.includes("/inAppPurchasesV2")) {
				res.end(
					JSON.stringify({
						data: [
							{
								id: "iapL",
								attributes: {
									name: "Founders Lifetime VIP",
									productId:
										"com.djscottyb.playinginthesandoxlookingatflowers.premium_founders",
								},
							},
						],
					}),
				);
				return;
			}
			if (req.url.includes("Localizations")) {
				res.end(
					JSON.stringify({
						data: [
							{
								id: "loc1",
								attributes: { locale: "en-US", name: "Test" },
							},
						],
					}),
				);
				return;
			}
			if (req.url.includes("Availability")) {
				res.end(JSON.stringify({ data: { id: "avail1" } }));
				return;
			}
			if (req.url.includes("PriceSchedule")) {
				res.end(JSON.stringify({ data: { id: "sched1" } }));
				return;
			}
			if (req.url.includes("/pricePoints") && !req.url.includes("page=2")) {
				res.end(
					JSON.stringify({
						data: [{ id: "pp_099", attributes: { customerPrice: "0.99" } }],
						links: {
							next: `https://api.appstoreconnect.apple.com${req.url}&page=2`,
						},
					}),
				);
				return;
			}
			if (req.url.includes("/pricePoints") && req.url.includes("page=2")) {
				res.end(
					JSON.stringify({
						data: [
							{ id: "pp_499", attributes: { customerPrice: "4.99" } },
							{ id: "pp_2999", attributes: { customerPrice: "29.99" } },
							{ id: "pp_9999", attributes: { customerPrice: "99.99" } },
						],
					}),
				);
				return;
			}
			if (req.url.includes("/prices")) {
				res.end(
					JSON.stringify({
						data: [
							{
								id: "pr1",
								relationships: { territory: { data: { id: "USA" } } },
							},
						],
					}),
				);
				return;
			}
			if (req.url.includes("/equalizations")) {
				res.end(JSON.stringify({ data: [] }));
				return;
			}
			res.end(JSON.stringify({ data: [] }));
		});

		try {
			const res = await runScriptInSandboxAsync(
				"scripts/manage-subscriptions.mjs",
				{
					linkEasKit: true,
					fastTimers: true,
					httpProxyBaseMap: {
						"https://api.appstoreconnect.apple.com": server.url,
					},
					env: {
						APP_STORE_CONNECT_APP_ID: "12345",
						APP_STORE_CONNECT_KEY_ID: "TESTKEY123",
						APP_STORE_CONNECT_ISSUER_ID: "00000000-0000-0000-0000-000000000001",
						APP_STORE_CONNECT_PRIVATE_KEY: privateKeyPem,
					},
				},
			);
			assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
			assert.ok(
				server.requests.some((r) => r.url.includes("page=2")),
				"manage-subscriptions.mjs must follow links.next pagination to fetch page 2 price points ($4.99/$29.99)",
			);
		} finally {
			await server.close();
		}
	});

	test("T2-I20-09: remove-version-from-submission.mjs avoids hardcoded UUID and passes query: { limit: 50 }", () => {
		const src = readRepoFile("scripts/remove-version-from-submission.mjs");
		assert.equal(
			src.includes("ea9e6b99-5bb6-42e3-95d9-323c48d4d93e"),
			false,
			"remove-version-from-submission.mjs must not hardcode a stale submission UUID",
		);
		assert.match(src, /limit:\s*50/);
		assert.match(src, /query:\s*(currentQuery|\{\s*limit:\s*50\s*\})/);
	});

	test("T2-I20-10: all scripts under scripts/ pass Biome check", () => {
		const res = runCli("pnpm", ["exec", "biome", "check", "scripts"]);
		assert.equal(res.status, 0, res.stderr || res.stdout);
	});

	// =========================================================================
	// Item 21: Maestro & Screenshot App ID Migration
	// =========================================================================

	test("T1-I21-01: all .maestro YAML files target app bundle ID and zero active host.exp.Exponent", () => {
		const ymls = listFilesRecursive(".maestro", (r) => /\.ya?ml$/.test(r));
		assert.ok(ymls.length >= 8);
		for (const rel of ymls) {
			const text = readRepoFile(rel);
			assert.equal(
				/^appId:\s*host\.exp\.Exponent/m.test(text),
				false,
				`${rel} must not target host.exp.Exponent`,
			);
			assert.match(
				text,
				/com\.djscottyb\.playinginthesandoxlookingatflowers/,
				`${rel} must target app bundle ID`,
			);
		}
	});

	test("T1-I21-02: .maestro/subflows/connect.yml and location-denied.yml use staring-at-flowers:// (no exp://)", () => {
		const ymls = listFilesRecursive(".maestro", (r) => /\.ya?ml$/.test(r));
		for (const rel of ymls) {
			const text = readRepoFile(rel);
			assert.equal(
				/exp:\/\/localhost/.test(text),
				false,
				`${rel} must not use exp://localhost`,
			);
		}
		assert.match(
			readRepoFile(".maestro/subflows/connect.yml"),
			/staring-at-flowers:\/\//,
		);
	});

	test("T1-I21-03: scripts/capture_screenshots_auto.mjs uses app bundle ID and staring-at-flowers://", () => {
		const src = readRepoFile("scripts/capture_screenshots_auto.mjs");
		assert.equal(src.includes("host.exp.Exponent"), false);
		assert.equal(src.includes("exp://localhost"), false);
		assert.match(src, /com\.djscottyb\.playinginthesandoxlookingatflowers/);
		assert.ok(
			src.includes("staring-at-flowers://") ||
				(src.includes('APP_SCHEME = "staring-at-flowers"') &&
					src.includes("://")),
			"capture_screenshots_auto.mjs must construct staring-at-flowers:// deep links",
		);
	});

	test("T1-I21-04: scripts/agent-squash-popups.mjs generates Maestro tap flow with app bundle ID", () => {
		const src = readRepoFile("scripts/agent-squash-popups.mjs");
		assert.equal(src.includes("host.exp.Exponent"), false);
		assert.match(src, /com\.djscottyb\.playinginthesandoxlookingatflowers/);
	});

	test("T1-I21-05: .maestro/ bundle ID and scheme match app.json exactly", () => {
		const app = readRepoJson("app.json").expo;
		const connect = readRepoFile(".maestro/subflows/connect.yml");
		assert.ok(connect.includes(app.ios.bundleIdentifier));
		assert.equal(app.ios.bundleIdentifier, app.android.package);
		assert.ok(connect.includes(`${app.scheme}://`));
	});

	test("T2-I21-06: .maestro/capture_flow.yml search assertion matches app/index.tsx Search modal header", () => {
		const flow = readRepoFile(".maestro/capture_flow.yml");
		const indexSrc = readRepoFile("app/index.tsx");
		const visibleMatch = flow.match(/SEARCH[\s\S]{0,120}visible:\s*"([^"]+)"/);
		assert.ok(
			visibleMatch,
			"capture_flow.yml should assert search modal title",
		);
		assert.ok(
			indexSrc.includes(visibleMatch[1]),
			`capture_flow.yml search modal assertion "${visibleMatch[1]}" must match app/index.tsx`,
		);
	});

	test("T2-I21-07: scripts/agent-squash-popups.mjs uses os.tmpdir() and supports env GEMINI_API_KEY", () => {
		const src = readRepoFile("scripts/agent-squash-popups.mjs");
		assert.equal(src.includes('"/tmp/'), false);
		assert.match(src, /tmpdir\(\)|os\.tmpdir\(\)/);
		assert.match(src, /process\.env\.GEMINI_API_KEY/);
	});

	test("T2-I21-08: scripts/capture_screenshots_auto.mjs references pnpm screenshots:verify", () => {
		const src = readRepoFile("scripts/capture_screenshots_auto.mjs");
		assert.equal(src.includes("qc-screenshots"), false);
		assert.match(src, /screenshots:verify/);
	});

	test("T2-I21-09: scripts/capture_screenshots.mjs references pnpm screenshots:verify", () => {
		const src = readRepoFile("scripts/capture_screenshots.mjs");
		assert.equal(src.includes("qc-screenshots"), false);
		assert.match(src, /screenshots:verify/);
	});

	test("T2-I21-10: capture_screenshots_auto.mjs does not install Expo Go tar.app unconditionally", () => {
		const src = readRepoFile("scripts/capture_screenshots_auto.mjs");
		assert.equal(src.includes("Expo-Go-56.0.2.tar.app"), false);
	});

	// =========================================================================
	// Tier 3: Pairwise Cross-Feature Integration
	// =========================================================================

	test("T3-06-01: package.json <-> .github/workflows/ci.yml <-> generate-daily.yml pnpm & test script alignment", () => {
		const pkg = readRepoJson("package.json");
		const ci = readRepoFile(".github/workflows/ci.yml");
		const gen = readRepoFile(".github/workflows/generate-daily.yml");
		assert.equal(pkg.volta.pnpm, "11.2.2");
		assert.equal(/version:\s*["']?10["']?/.test(ci), false);
		assert.equal(/version:\s*["']?10["']?/.test(gen), false);
		assert.match(ci, /pnpm test|node\s+.*--test/);
	});

	test("T3-06-02: .eas/workflows/update-on-push.yml channel mapping matches eas.json build profiles", () => {
		const easJson = readRepoJson("eas.json");
		const easWf = readRepoFile(".eas/workflows/update-on-push.yml");
		assert.equal(easJson.build.production.channel, "production");
		assert.equal(easJson.build.preview.channel, "preview");
		assert.match(easWf, /production/);
	});

	test("T3-06-03: generate-daily.mjs day 0/7/9 output -> lib/dailyFlower.ts client fetch & imageUrlFor alignment", async () => {
		const target = "2026-05-15";
		const d0 = target;
		const d7 = shiftIso(target, -7);
		const d9 = shiftIso(target, -9);
		const pngBuf = await createPngBuffer({ width: 12, height: 12 });
		const sidecar = (d) =>
			JSON.stringify({
				common: "Poppy",
				latin: "Eschscholzia californica",
				blurb: "Orange bloom.",
				generatedAt: `${d}T11:00:00.000Z`,
				imageExt: "png",
			});

		let capturedSidecars = null;
		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", target, "--states", "CA"],
			env: { DRY_RUN: "1" },
			seedFiles: {
				[`docs/daily/CA/${d7}.png`]: pngBuf,
				[`docs/daily/CA/${d7}.json`]: sidecar(d7),
				[`docs/daily/CA/${d9}.png`]: pngBuf,
				[`docs/daily/CA/${d9}.json`]: sidecar(d9),
			},
			inspect: (projectRoot) => ({
				[d0]: JSON.parse(
					readFileSync(join(projectRoot, `docs/daily/CA/${d0}.json`), "utf8"),
				),
				[d7]: JSON.parse(
					readFileSync(join(projectRoot, `docs/daily/CA/${d7}.json`), "utf8"),
				),
				[d9]: JSON.parse(
					readFileSync(join(projectRoot, `docs/daily/CA/${d9}.json`), "utf8"),
				),
			}),
		});
		assert.equal(res.status, 0);
		capturedSidecars = res.inspectResult;

		const ctx = createE2EContext({
			fetchImpl: async (url) => {
				for (const d of [d0, d7, d9]) {
					if (url.endsWith(`/CA/${d}.json`)) {
						return new Response(JSON.stringify(capturedSidecars[d]), {
							status: 200,
						});
					}
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const f0 = await daily.fetchDailyFlower("CA", d0);
			const f7 = await daily.fetchDailyFlower("CA", d7);
			const f9 = await daily.fetchDailyFlower("CA", d9);
			assert.ok(f0.imageSource.uri.endsWith(`${d0}.png`));
			assert.ok(f7.imageSource.uri.endsWith(`${d7}.jpg`));
			assert.ok(f9.imageSource.uri.endsWith(`${d9}.jpg`));
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-06-04: capture_screenshots*.mjs output directory aligns with verify_screenshots.mjs input scan", () => {
		const autoSrc = readRepoFile("scripts/capture_screenshots_auto.mjs");
		const verifySrc = readRepoFile("scripts/verify_screenshots.mjs");
		assert.match(autoSrc, /store\/apple\/screenshot\/en-US/);
		assert.match(verifySrc, /store\/apple\/screenshot\/en-US/);
	});

	test("T3-06-05: app.json bundleIdentifier/scheme <-> .maestro/*.yml <-> screenshot scripts consistency", () => {
		const app = readRepoJson("app.json").expo;
		const smoke = readRepoFile(".maestro/smoke.yml");
		const squash = readRepoFile("scripts/agent-squash-popups.mjs");
		assert.ok(smoke.includes(app.ios.bundleIdentifier));
		assert.ok(squash.includes(app.ios.bundleIdentifier));
	});

	// =========================================================================
	// Tier 4: Real-World E2E Scenarios
	// =========================================================================

	test("T4-06-01: Full daily generation day 0-9 lifecycle simulation with 429 spike, UTC month, & multi-region", async () => {
		const b64 = await createPngBase64();
		const target = "2026-03-15";
		const d7 = shiftIso(target, -7);
		const d8 = shiftIso(target, -8);
		const d9 = shiftIso(target, -9);
		const pngBuf = await createPngBuffer({ width: 16, height: 16 });
		const oldJson = (d) =>
			JSON.stringify({
				common: "Poppy",
				latin: "Eschscholzia californica",
				blurb: "Orange bloom.",
				generatedAt: `${d}T11:00:00.000Z`,
				imageExt: "png",
			});

		const res = runScriptInSandbox("scripts/generate-daily.mjs", {
			copyFiles: ["lib/data/species.json"],
			args: ["--date", target, "--states", "default,CA,MX-MEX,RU-MOW,CN-BJ"],
			env: { GEMINI_API_KEY: "test_e2e_daily" },
			fastTimers: true,
			mockTimeIso: "2026-11-26T12:00:00Z",
			seedFiles: {
				[`docs/daily/CA/${d7}.png`]: pngBuf,
				[`docs/daily/CA/${d7}.json`]: oldJson(d7),
				[`docs/daily/CA/${d8}.png`]: pngBuf,
				[`docs/daily/CA/${d8}.json`]: oldJson(d8),
				[`docs/daily/CA/${d9}.png`]: pngBuf,
				[`docs/daily/CA/${d9}.json`]: oldJson(d9),
			},
			preloadCode: `
				let calls = 0;
				globalThis.fetch = async (_url, init) => {
					calls += 1;
					const prompt = JSON.parse(init.body).contents[0].parts[0].text;
					if (calls === 1) {
						return new Response(JSON.stringify({ error: { message: "Rate limit" } }), { status: 429 });
					}
					console.log("E2E_MARCH_CHECK=" + prompt.includes("blooming in March"));
					return new Response(JSON.stringify({
						candidates: [{ content: { parts: [
							{ inlineData: { mimeType: "image/png", data: ${JSON.stringify(b64)} } },
							{ text: "Spring native flower." },
						] } }],
					}), { status: 200 });
				};
			`,
			inspect: (projectRoot) => ({
				regionsOk: ["default", "CA", "MX-MEX", "RU-MOW", "CN-BJ"].every(
					(r) =>
						existsSync(join(projectRoot, `docs/daily/${r}/${target}.png`)) &&
						JSON.parse(
							readFileSync(
								join(projectRoot, `docs/daily/${r}/${target}.json`),
								"utf8",
							),
						).imageExt === "png",
				),
				d7Overlap:
					existsSync(join(projectRoot, `docs/daily/CA/${d7}.png`)) &&
					existsSync(join(projectRoot, `docs/daily/CA/${d7}.jpg`)),
				d8Overlap:
					existsSync(join(projectRoot, `docs/daily/CA/${d8}.png`)) &&
					existsSync(join(projectRoot, `docs/daily/CA/${d8}.jpg`)),
				d9Pruned:
					!existsSync(join(projectRoot, `docs/daily/CA/${d9}.png`)) &&
					existsSync(join(projectRoot, `docs/daily/CA/${d9}.jpg`)),
			}),
		});
		assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, /E2E_MARCH_CHECK=true/);
		assert.equal(res.inspectResult.regionsOk, true);
		assert.equal(res.inspectResult.d7Overlap, true);
		assert.equal(res.inspectResult.d8Overlap, true);
		assert.equal(res.inspectResult.d9Pruned, true);
	});

	test("T4-06-02: End-to-end CI, EAS, ASC scripts, screenshot pipeline, and Maestro config audit", () => {
		const pkg = readRepoJson("package.json");
		const app = readRepoJson("app.json").expo;
		const eas = readRepoJson("eas.json");
		assert.equal(pkg.volta.pnpm, "11.2.2");
		assert.equal(eas.build.production.channel, "production");

		const ci = readRepoFile(".github/workflows/ci.yml");
		const easWf = readRepoFile(".eas/workflows/update-on-push.yml");
		assert.match(ci, /pnpm db:smoke/);
		assert.match(ci, /pnpm test|node\s+.*--test/);
		assert.match(easWf, /^on:/m);
		assert.match(easWf, /production/);

		const maestroFiles = listFilesRecursive(".maestro", (r) =>
			/\.ya?ml$/.test(r),
		);
		for (const rel of maestroFiles) {
			const text = readRepoFile(rel);
			assert.equal(/^appId:\s*host\.exp\.Exponent/m.test(text), false);
			assert.ok(text.includes(app.ios.bundleIdentifier));
		}

		const biomeScripts = runCli("pnpm", ["exec", "biome", "check", "scripts"]);
		assert.equal(
			biomeScripts.status,
			0,
			biomeScripts.stderr || biomeScripts.stdout,
		);
	});
});
