import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Jimp } from "jimp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "../..");

function createMockResponse({ ok, status, jsonData, textData, headers = {} }) {
	return {
		ok,
		status,
		headers: {
			get(name) {
				const key = Object.keys(headers).find(
					(k) => k.toLowerCase() === name.toLowerCase(),
				);
				return key ? headers[key] : null;
			},
		},
		async json() {
			return jsonData;
		},
		async text() {
			return (
				textData ?? (jsonData !== undefined ? JSON.stringify(jsonData) : "")
			);
		},
	};
}

describe("M4 module import safety", () => {
	it("imports all M4 scripts cleanly with zero side effects", async () => {
		const origApiKey = process.env.GEMINI_API_KEY;
		delete process.env.GEMINI_API_KEY;
		try {
			const modules = await Promise.all([
				import("../../scripts/generate-daily.mjs"),
				import("../../scripts/verify_screenshots.mjs"),
				import("../../scripts/capture_screenshots.mjs"),
				import("../../scripts/capture_screenshots_auto.mjs"),
				import("../../scripts/agent-squash-popups.mjs"),
				import("../../scripts/manage-subscriptions.mjs"),
				import("../../scripts/delete-draft-submission.mjs"),
				import("../../scripts/remove-version-from-submission.mjs"),
			]);
			assert.equal(modules.length, 8);
			assert.equal(typeof modules[0].run, "function");
			assert.equal(typeof modules[1].main, "function");
			assert.equal(typeof modules[2].main, "function");
			assert.equal(typeof modules[3].main, "function");
			assert.equal(typeof modules[4].main, "function");
			assert.equal(typeof modules[5].main, "function");
			assert.equal(typeof modules[6].main, "function");
			assert.equal(typeof modules[7].main, "function");
		} finally {
			if (origApiKey !== undefined) {
				process.env.GEMINI_API_KEY = origApiKey;
			}
		}
	});
});

describe("generate-daily.mjs", () => {
	it("computes todayIso() in UTC", async () => {
		const { todayIso } = await import("../../scripts/generate-daily.mjs");
		const d = new Date("2026-06-02T03:00:00.000Z");
		assert.equal(todayIso(d), "2026-06-02");
	});

	it("derives blooming month from targetDate in monthNameForDate and buildImagePrompt", async () => {
		const { monthNameForDate, buildImagePrompt } = await import(
			"../../scripts/generate-daily.mjs"
		);
		assert.equal(monthNameForDate("2026-04-15"), "April");
		assert.equal(monthNameForDate("2026-11-01"), "November");
		const prompt = buildImagePrompt(
			{ common: "California Poppy", latin: "Eschscholzia californica" },
			"CA",
			"2026-04-15",
		);
		assert.match(prompt, /blooming in April\./);
	});

	it("retries transient HTTP 429 with RESOURCE_EXHAUSTED before succeeding and uses targetDate month in fallback blurb", async () => {
		const { generateImage } = await import("../../scripts/generate-daily.mjs");
		let calls = 0;
		const sleeps = [];
		const mockFetch = async () => {
			calls++;
			if (calls < 3) {
				return createMockResponse({
					ok: false,
					status: 429,
					jsonData: {
						error: {
							status: "RESOURCE_EXHAUSTED",
							message: "Rate limit exceeded, try again soon.",
						},
					},
				});
			}
			return createMockResponse({
				ok: true,
				status: 200,
				jsonData: {
					candidates: [
						{
							content: {
								parts: [
									{
										inlineData: {
											mimeType: "image/png",
											data: Buffer.from("fake-png").toString("base64"),
										},
									},
								],
							},
						},
					],
				},
			});
		};

		const result = await generateImage(
			"test-key",
			{ common: "Lupine", latin: "Lupinus perennis" },
			"MA",
			"gemini-3.1-flash-image",
			"2026-04-15",
			{
				fetchImpl: mockFetch,
				sleepImpl: async (ms) => {
					sleeps.push(ms);
				},
				backoffBaseMs: 10,
				maxAttempts: 3,
			},
		);

		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [10, 20]);
		assert.equal(
			result.blurb,
			"A Lupine (Lupinus perennis) blooming in April.",
		);
	});

	it("throws quota exhausted after all 429 retries are exhausted", async () => {
		const { generateImage } = await import("../../scripts/generate-daily.mjs");
		let calls = 0;
		await assert.rejects(
			() =>
				generateImage(
					"test-key",
					{ common: "Lupine", latin: "Lupinus perennis" },
					"MA",
					"gemini-3.1-flash-image",
					"2026-04-15",
					{
						fetchImpl: async () => {
							calls++;
							return createMockResponse({
								ok: false,
								status: 429,
								jsonData: {
									error: {
										status: "RESOURCE_EXHAUSTED",
										message: "Quota exhausted",
									},
								},
							});
						},
						sleepImpl: async () => {},
						backoffBaseMs: 1,
						maxAttempts: 3,
					},
				),
			/Quota Exhausted/,
		);
		assert.equal(calls, 3);
	});

	it("fails fast on permanent 403 prepayment credits billing error", async () => {
		const { generateImage } = await import("../../scripts/generate-daily.mjs");
		let calls = 0;
		await assert.rejects(
			() =>
				generateImage(
					"test-key",
					{ common: "Lupine", latin: "Lupinus perennis" },
					"MA",
					"gemini-3.1-flash-image",
					"2026-04-15",
					{
						fetchImpl: async () => {
							calls++;
							return createMockResponse({
								ok: false,
								status: 403,
								jsonData: {
									error: {
										message: "You must add prepayment credits to continue.",
									},
								},
							});
						},
						sleepImpl: async () => {},
						backoffBaseMs: 1,
						maxAttempts: 3,
					},
				),
			/billing\/auth error/i,
		);
		assert.equal(calls, 1);
	});

	it("retries HTTP 500 and transient network errors and succeeds", async () => {
		const { generateImage } = await import("../../scripts/generate-daily.mjs");
		let calls = 0;
		const res = await generateImage(
			"test-key",
			{ common: "Iris", latin: "Iris versicolor" },
			"ME",
			"gemini-3.1-flash-image",
			"2026-05-10",
			{
				fetchImpl: async () => {
					calls++;
					if (calls === 1) {
						throw new Error("ECONNRESET");
					}
					if (calls === 2) {
						return createMockResponse({
							ok: false,
							status: 500,
							textData: "Internal Server Error",
						});
					}
					return createMockResponse({
						ok: true,
						status: 200,
						jsonData: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													mimeType: "image/png",
													data: Buffer.from("ok").toString("base64"),
												},
											},
											{
												text: "Here is your description: Vivid purple petals.",
											},
										],
									},
								},
							],
						},
					});
				},
				sleepImpl: async () => {},
				backoffBaseMs: 1,
				maxAttempts: 3,
			},
		);
		assert.equal(calls, 3);
		assert.equal(res.blurb, "Vivid purple petals.");
	});

	it("selects all 112 regions by default (including default and international) and supports usOnly & trimmed targetStates", async () => {
		const { selectTargetRegions, getRegionPromptText } = await import(
			"../../scripts/generate-daily.mjs"
		);
		const allSpecies = JSON.parse(
			fs.readFileSync(path.join(ROOT, "lib/data/species.json"), "utf8"),
		);

		const allRegions = selectTargetRegions(allSpecies);
		assert.equal(allRegions.length, 112);
		assert.ok(allRegions.includes("default"));
		assert.ok(allRegions.includes("MX-MEX"));
		assert.ok(allRegions.includes("RU-MOW"));
		assert.ok(allRegions.includes("CN-BJ"));

		const usOnlyRegions = selectTargetRegions(allSpecies, { usOnly: true });
		assert.equal(usOnlyRegions.length, 51);
		assert.ok(!usOnlyRegions.includes("default"));
		assert.ok(!usOnlyRegions.includes("MX-MEX"));

		const explicit = selectTargetRegions(allSpecies, {
			targetStates: [" CA ", " MX-MEX", ""],
		});
		assert.deepEqual(explicit, ["CA", "MX-MEX"]);

		for (const region of allRegions) {
			const promptText = getRegionPromptText(region);
			assert.ok(
				typeof promptText === "string" && promptText.trim().length > 0,
				`Expected prompt text for ${region}`,
			);
		}
	});

	it("picks species deterministically and seasonally", async () => {
		const { pickSpecies } = await import("../../scripts/generate-daily.mjs");
		const speciesList = [
			{ common: "Spring Bloom", latin: "Veris flora", bloomMonths: [4] },
			{ common: "Winter Bloom", latin: "Hiemis flora", bloomMonths: [12] },
		];
		const a = pickSpecies(speciesList, "CA", "2026-04-15");
		const b = pickSpecies(speciesList, "CA", "2026-04-15");
		assert.deepEqual(a, b);
		assert.equal(a.common, "Spring Bloom");
	});

	it("enforces 2-day PNG/JPG overlap in archiveOldPngs across days 6, 7, 8, and 9 in UTC", async () => {
		const { archiveOldPngs } = await import("../../scripts/generate-daily.mjs");
		const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "daily-archive-"));
		const docsDir = path.join(tempRoot, "docs");
		const warehouseDir = path.join(tempRoot, "warehouse");

		try {
			const img = new Jimp({ width: 4, height: 4, color: 0xff0000ff });
			const pngBuf = await img.getBuffer("image/png");

			// targetDate = 2026-03-10 (crosses US DST boundary on 2026-03-08)
			const cases = [
				{ date: "2026-03-04", region: "CA" }, // diffDays = 6
				{ date: "2026-03-03", region: "CA" }, // diffDays = 7
				{ date: "2026-03-02", region: "CA" }, // diffDays = 8
				{ date: "2026-03-01", region: "CA" }, // diffDays = 9
			];

			const regionDir = path.join(docsDir, "CA");
			fs.mkdirSync(regionDir, { recursive: true });

			for (const c of cases) {
				fs.writeFileSync(path.join(regionDir, `${c.date}.png`), pngBuf);
				fs.writeFileSync(
					path.join(regionDir, `${c.date}.json`),
					JSON.stringify({
						common: "Poppy",
						latin: "Eschscholzia californica",
						blurb: `Blurb for ${c.date}`,
						generatedAt: `${c.date}T11:00:00.000Z`,
						imageExt: "png",
					}),
				);
			}

			const stats = await archiveOldPngs({
				targetDate: "2026-03-10",
				docsDir,
				warehouseDir,
			});
			assert.equal(stats.convertedCount, 3);
			assert.equal(stats.archivedCount, 1);

			// Day 6: PNG kept, no JPG, imageExt still "png"
			assert.equal(fs.existsSync(path.join(regionDir, "2026-03-04.png")), true);
			assert.equal(
				fs.existsSync(path.join(regionDir, "2026-03-04.jpg")),
				false,
			);
			assert.equal(
				JSON.parse(
					fs.readFileSync(path.join(regionDir, "2026-03-04.json"), "utf8"),
				).imageExt,
				"png",
			);

			// Days 7 and 8: valid JPEG created, sidecar updated to "jpg" preserving fields, PNG KEPT
			for (const d of ["2026-03-03", "2026-03-02"]) {
				assert.equal(fs.existsSync(path.join(regionDir, `${d}.png`)), true);
				const jpgBytes = fs.readFileSync(path.join(regionDir, `${d}.jpg`));
				assert.ok(jpgBytes.length > 0);
				assert.equal(jpgBytes[0], 0xff);
				assert.equal(jpgBytes[1], 0xd8);
				const meta = JSON.parse(
					fs.readFileSync(path.join(regionDir, `${d}.json`), "utf8"),
				);
				assert.equal(meta.imageExt, "jpg");
				assert.equal(meta.blurb, `Blurb for ${d}`);
			}

			// Day 9: backed up to warehouseDir and original PNG deleted
			assert.equal(
				fs.existsSync(path.join(regionDir, "2026-03-01.png")),
				false,
			);
			assert.equal(fs.existsSync(path.join(regionDir, "2026-03-01.jpg")), true);
			assert.equal(
				fs.existsSync(path.join(warehouseDir, "CA", "2026-03-01.png")),
				true,
			);
			assert.equal(
				JSON.parse(
					fs.readFileSync(path.join(regionDir, "2026-03-01.json"), "utf8"),
				).imageExt,
				"jpg",
			);

			// Also verify running with empty warehouseDir succeeds without errors
			fs.writeFileSync(path.join(regionDir, "2026-02-20.png"), Buffer.alloc(0));
			const noWarehouse = await archiveOldPngs({
				targetDate: "2026-03-10",
				docsDir,
				warehouseDir: "",
			});
			assert.equal(noWarehouse.archivedCount, 1);
			assert.equal(
				fs.existsSync(path.join(regionDir, "2026-02-20.png")),
				false,
			);
		} finally {
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	it("writes imageExt: png in sidecar JSON during run() dry-run", async () => {
		const { run } = await import("../../scripts/generate-daily.mjs");
		const tempDocs = fs.mkdtempSync(path.join(os.tmpdir(), "daily-dryrun-"));
		try {
			const res = await run({
				targetDate: "2026-04-15",
				targetStates: ["default", "MX-MEX"],
				dryRun: true,
				docsDir: tempDocs,
				warehouseDir: "",
			});
			assert.equal(res.ok, 2);
			assert.equal(res.fail, 0);

			for (const region of ["default", "MX-MEX"]) {
				const sidecar = JSON.parse(
					fs.readFileSync(
						path.join(tempDocs, region, "2026-04-15.json"),
						"utf8",
					),
				);
				assert.equal(sidecar.imageExt, "png");
				assert.match(sidecar.blurb, /blooming in April\.$/);
			}
		} finally {
			fs.rmSync(tempDocs, { recursive: true, force: true });
		}
	});

	it("retries HTTP 429 mentioning 'billing' / RESOURCE_EXHAUSTED, honors Retry-After seconds/HTTP-date/whitespace, and fails fast on 403/400", async () => {
		const { generateImage, parseRetryAfterMs } = await import(
			"../../scripts/generate-daily.mjs"
		);

		assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "3" })), 3000);
		assert.equal(
			parseRetryAfterMs(new Headers({ "Retry-After": "   " })),
			null,
		);
		assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "-1" })), null);
		assert.equal(
			parseRetryAfterMs(
				new Headers({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }),
			),
			0,
		);

		// 429 with "billing" wording + RESOURCE_EXHAUSTED must retry (not fail on attempt 1)
		let calls = 0;
		const sleeps = [];
		const res = await generateImage(
			"test-key",
			{ common: "Lupine", latin: "Lupinus perennis" },
			"MA",
			"gemini-3.1-flash-image",
			"2026-04-15",
			{
				backoffBaseMs: 25,
				maxAttempts: 4,
				sleepImpl: async (ms) => {
					sleeps.push(ms);
				},
				fetchImpl: async () => {
					calls++;
					if (calls === 1) {
						return createMockResponse({
							ok: false,
							status: 429,
							headers: {
								"Retry-After": new Date(Date.now() + 1500).toUTCString(),
							},
							jsonData: {
								error: {
									status: "RESOURCE_EXHAUSTED",
									message:
										"Quota exceeded, check your plan and billing details.",
								},
							},
						});
					}
					if (calls === 2) {
						return createMockResponse({
							ok: false,
							status: 429,
							headers: { "Retry-After": "1" },
							jsonData: {
								error: {
									message: "Rate limit hit, check your billing details.",
								},
							},
						});
					}
					if (calls === 3) {
						return createMockResponse({
							ok: false,
							status: 429,
							headers: { "Retry-After": "   " },
							jsonData: { error: { message: "Rate limit" } },
						});
					}
					return createMockResponse({
						ok: true,
						status: 200,
						jsonData: {
							candidates: [
								{
									content: {
										parts: [
											{
												inlineData: {
													mimeType: "image/png",
													data: Buffer.from("img").toString("base64"),
												},
											},
										],
									},
								},
							],
						},
					});
				},
			},
		);
		assert.equal(calls, 4);
		assert.ok(res.imageData);
		assert.ok(
			sleeps[0] >= 500 && sleeps[0] <= 2000,
			`Expected HTTP-date Retry-After ~1500ms, got ${sleeps[0]}`,
		);
		assert.equal(sleeps[1], 1000);
		assert.equal(sleeps[2], 75);

		// 403 and 400 fail fast on attempt 1
		for (const status of [403, 400]) {
			let failFastCalls = 0;
			await assert.rejects(() =>
				generateImage(
					"test-key",
					{ common: "Lupine", latin: "Lupinus perennis" },
					"MA",
					"gemini-3.1-flash-image",
					"2026-04-15",
					{
						backoffBaseMs: 10,
						maxAttempts: 3,
						sleepImpl: async () => {},
						fetchImpl: async () => {
							failFastCalls++;
							return createMockResponse({
								ok: false,
								status,
								jsonData: { error: { message: `Client error ${status}` } },
							});
						},
					},
				),
			);
			assert.equal(failFastCalls, 1, `HTTP ${status} must fail fast`);
		}
	});

	it("rejects --states ../../outside and prototype key toString, rejects invalid targetDate, and skips symlinked dirs in archiveOldPngs()", async () => {
		const { run, archiveOldPngs, isValidIsoDate } = await import(
			"../../scripts/generate-daily.mjs"
		);
		assert.equal(isValidIsoDate("2026-04-15"), true);
		assert.equal(isValidIsoDate("2024-02-29"), true);
		assert.equal(isValidIsoDate("2026-02-29"), false);
		assert.equal(isValidIsoDate("2026-13-01"), false);
		assert.equal(isValidIsoDate("../2026-04-15"), false);

		const tempRoot = fs.mkdtempSync(
			path.join(os.tmpdir(), "daily-confinement-"),
		);
		const docsDir = path.join(tempRoot, "docs.png.dir");
		const outsideDir = path.join(tempRoot, "outside");
		const prevExitCode = process.exitCode;
		try {
			fs.mkdirSync(docsDir, { recursive: true });
			fs.mkdirSync(outsideDir, { recursive: true });

			// Invalid targetDate rejection
			const invalidRes = await run({
				targetDate: "2026-02-30",
				targetStates: ["CA"],
				dryRun: true,
				docsDir,
				warehouseDir: "",
			});
			assert.equal(invalidRes.ok, 0);
			assert.equal(process.exitCode, 1);
			process.exitCode = prevExitCode;
			assert.equal(fs.existsSync(path.join(docsDir, "CA")), false);

			// Path traversal & prototype-key rejection
			const traversalRes = await run({
				targetDate: "2026-04-15",
				targetStates: ["../../outside", "toString"],
				dryRun: true,
				docsDir,
				warehouseDir: "",
			});
			assert.equal(traversalRes.ok, 0);
			assert.equal(traversalRes.fail, 1);
			assert.deepEqual(traversalRes.failedStates, ["../../outside"]);
			assert.equal(traversalRes.skip, 1);
			assert.equal(
				fs.existsSync(path.join(outsideDir, "2026-04-15.json")),
				false,
			);
			assert.equal(fs.existsSync(path.join(docsDir, "toString")), false);

			// archiveOldPngs skips symlinked directory and handles parent path containing ".png"
			const externalPngDir = path.join(tempRoot, "external-ca");
			fs.mkdirSync(externalPngDir, { recursive: true });
			const img = new Jimp({ width: 4, height: 4, color: 0xff0000ff });
			const pngBuf = await img.getBuffer("image/png");
			fs.writeFileSync(path.join(externalPngDir, "2026-03-01.png"), pngBuf);

			const symlinkStateDir = path.join(docsDir, "SYMLINK_CA");
			fs.symlinkSync(externalPngDir, symlinkStateDir, "dir");

			const realStateDir = path.join(docsDir, "CA");
			fs.mkdirSync(realStateDir, { recursive: true });
			fs.writeFileSync(path.join(realStateDir, "2026-03-03.png"), pngBuf);

			const stats = await archiveOldPngs({
				targetDate: "2026-03-10",
				docsDir,
				warehouseDir: "",
			});
			assert.equal(stats.convertedCount, 1);
			assert.equal(stats.archivedCount, 0);
			// Symlink target must remain untouched
			assert.equal(
				fs.existsSync(path.join(externalPngDir, "2026-03-01.png")),
				true,
			);
			assert.equal(
				fs.existsSync(path.join(externalPngDir, "2026-03-01.jpg")),
				false,
			);
			// Real dir inside path containing ".png" must create <date>.jpg cleanly
			assert.equal(
				fs.existsSync(path.join(realStateDir, "2026-03-03.jpg")),
				true,
			);
		} finally {
			process.exitCode = prevExitCode;
			fs.rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe("CI & EAS Workflows hygiene", () => {
	it("has zero /Users/ paths in scripts/generate-daily.mjs and aligned workflow configs", () => {
		const genDailySrc = fs.readFileSync(
			path.join(ROOT, "scripts/generate-daily.mjs"),
			"utf8",
		);
		assert.equal(genDailySrc.includes("/Users/"), false);

		const ciYml = fs.readFileSync(
			path.join(ROOT, ".github/workflows/ci.yml"),
			"utf8",
		);
		assert.match(ciYml, /version:\s*'11\.2\.2'/);
		assert.match(ciYml, /node-version:\s*'22\.18\.0'/);
		assert.match(ciYml, /pnpm db:smoke/);
		assert.match(ciYml, /pnpm test/);
		assert.ok(
			ciYml.indexOf("pnpm/action-setup@v4") <
				ciYml.indexOf("actions/setup-node@v5"),
		);

		const dailyYml = fs.readFileSync(
			path.join(ROOT, ".github/workflows/generate-daily.yml"),
			"utf8",
		);
		assert.match(dailyYml, /version:\s*'11\.2\.2'/);
		assert.match(dailyYml, /node-version:\s*'22\.18\.0'/);
		assert.match(dailyYml, /"\$\{ARGS\[@\]\}"/);
		assert.match(dailyYml, /default: today UTC/);

		const easYml = fs.readFileSync(
			path.join(ROOT, ".eas/workflows/update-on-push.yml"),
			"utf8",
		);
		assert.doesNotMatch(easYml, /^#\s*on:/m);
		assert.equal(easYml.includes("paths-ignore"), false);
		assert.match(easYml, /^on:\n\s+push:/m);
		assert.match(easYml, /paths:\n\s+- "\*\*"\n\s+- "!docs\/daily\/\*\*"/);
		assert.match(
			easYml,
			/github\.ref_name == 'main' && 'production' \|\| github\.ref_name \|\| 'production'/,
		);
	});
});

describe("verify_screenshots.mjs", () => {
	it("resolves store/apple/screenshot/en-US as default directory and discovers existing PNGs", async () => {
		const { getDefaultScreenshotsDir, scanScreenshotsDir } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const defaultDir = getDefaultScreenshotsDir(ROOT);
		assert.equal(defaultDir, path.join(ROOT, "store/apple/screenshot/en-US"));
		const found = scanScreenshotsDir(defaultDir);
		assert.ok(found.length > 0);
		assert.ok(found.every((f) => /\.(png|jpe?g)$/i.test(f)));
	});

	it("handles null fileInfo.format and null dimensions without throwing and emits relative links", async () => {
		const { analyzeScreenshot, generateMarkdownReport } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-shots-"));
		try {
			const fakeFile = path.join(tempDir, "APP_IPHONE_67", "iphone67_test.png");
			fs.mkdirSync(path.dirname(fakeFile), { recursive: true });
			fs.writeFileSync(fakeFile, Buffer.from("not-an-image"));

			const analysis = await analyzeScreenshot(fakeFile, tempDir, null, {
				fileInfo: {
					width: null,
					height: null,
					hasAlpha: false,
					format: null,
					sizeBytes: 12,
				},
				ocr: { available: false, text: "" },
			});
			assert.ok(analysis.issues.some((i) => i.includes("unknown")));

			const report = generateMarkdownReport([analysis], tempDir);
			assert.equal(report.includes("file://"), false);
			assert.equal(report.includes("/Users/"), false);
			assert.equal(report.includes("qc-screenshots"), false);
			assert.ok(report.includes("screenshots:verify"));
			assert.ok(report.includes("./APP_IPHONE_67/iphone67_test.png"));
			assert.ok(report.includes("`? x ? px`"));
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("retries HTTP 429 and 503 in analyzeScreenshotWithGemini and throws on billing error without exiting", async () => {
		const { analyzeScreenshotWithGemini } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		let calls = 0;
		const sleeps = [];
		const result = await analyzeScreenshotWithGemini("/fake/shot.png", "key", {
			readFile: () => Buffer.from("png"),
			sleepImpl: async (ms) => {
				sleeps.push(ms);
			},
			backoffBaseMs: 5,
			fetchImpl: async () => {
				calls++;
				if (calls === 1) {
					return createMockResponse({
						ok: false,
						status: 429,
						jsonData: {
							error: { status: "RESOURCE_EXHAUSTED", message: "429" },
						},
					});
				}
				if (calls === 2) {
					return createMockResponse({
						ok: false,
						status: 503,
						textData: "Unavailable",
					});
				}
				return createMockResponse({
					ok: true,
					status: 200,
					jsonData: {
						candidates: [
							{
								content: {
									parts: [
										{
											text: JSON.stringify({
												isHomeScreen: false,
												isDevLauncher: false,
												hasDebugOverlay: false,
												hasPopupOrModal: false,
												statusBarTime: "9:41",
												explanation: "Clean",
											}),
										},
									],
								},
							},
						],
					},
				});
			},
		});

		assert.equal(calls, 3);
		assert.deepEqual(sleeps, [5, 10]);
		assert.equal(result.statusBarTime, "9:41");

		let billingCalls = 0;
		await assert.rejects(
			() =>
				analyzeScreenshotWithGemini("/fake/shot.png", "key", {
					readFile: () => Buffer.from("png"),
					sleepImpl: async () => {},
					fetchImpl: async () => {
						billingCalls++;
						return createMockResponse({
							ok: false,
							status: 403,
							jsonData: { error: { message: "prepayment credits required" } },
						});
					},
				}),
			(err) => err.isFatalBillingOrQuota === true,
		);
		assert.equal(billingCalls, 1);
	});

	it("returns null dimensions/format for corrupt images and preserves original file when fixScreenshot conversion fails", async () => {
		const { getImageInfo, analyzeScreenshot, fixScreenshot } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-corrupt-"));
		try {
			const corruptPng = path.join(
				tempDir,
				"APP_IPHONE_67",
				"iphone67_corrupt.png",
			);
			const corruptJpg = path.join(
				tempDir,
				"APP_IPHONE_67",
				"iphone67_corrupt.jpg",
			);
			fs.mkdirSync(path.dirname(corruptPng), { recursive: true });
			fs.writeFileSync(corruptPng, "not actually a png image at all");
			fs.writeFileSync(corruptJpg, "not actually a jpg image at all");

			const pngInfo = getImageInfo(corruptPng);
			assert.equal(pngInfo.width, null);
			assert.equal(pngInfo.height, null);
			assert.notEqual(pngInfo.format, "<nil>");

			const jpgInfo = getImageInfo(corruptJpg);
			assert.equal(jpgInfo.width, null);
			assert.equal(jpgInfo.height, null);
			assert.notEqual(jpgInfo.format, "<nil>");

			const jpgAnalysis = await analyzeScreenshot(corruptJpg, tempDir, null, {
				ocr: { available: false, text: "" },
			});
			assert.equal(
				jpgAnalysis.issues.some((i) => i.includes("NaN")),
				false,
			);

			const jpgFix = fixScreenshot(jpgAnalysis, tempDir);
			assert.equal(jpgFix.fixed, false);
			assert.equal(jpgFix.fixFailed, true);
			assert.equal(fs.existsSync(corruptJpg), true);

			const pngAnalysis = await analyzeScreenshot(corruptPng, tempDir, null, {
				fileInfo: {
					width: null,
					height: null,
					hasAlpha: false,
					format: null,
					sizeBytes: 31,
				},
				ocr: { available: false, text: "" },
			});
			const pngFix = fixScreenshot(pngAnalysis, tempDir);
			assert.equal(pngFix.fixed, false);
			assert.equal(pngFix.fixFailed, true);
			assert.equal(fs.existsSync(corruptPng), true);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("retries 429 with 'billing' wording, parses Retry-After HTTP-date/seconds/whitespace, fails fast on 403/400, and handles corrupt Vision JSON / {}", async () => {
		const {
			analyzeScreenshotWithGemini,
			analyzeScreenshot,
			parseRetryAfterMs,
		} = await import("../../scripts/verify_screenshots.mjs");

		assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "2" })), 2000);
		assert.equal(parseRetryAfterMs(new Headers({ "Retry-After": "  " })), null);

		// 429 with "billing" + RESOURCE_EXHAUSTED retries with HTTP-date, then succeeds
		let calls = 0;
		const sleeps = [];
		const okRes = await analyzeScreenshotWithGemini("/fake/shot.png", "key", {
			readFile: () => Buffer.from("png"),
			backoffBaseMs: 25,
			maxAttempts: 4,
			sleepImpl: async (ms) => {
				sleeps.push(ms);
			},
			fetchImpl: async () => {
				calls++;
				if (calls === 1) {
					return createMockResponse({
						ok: false,
						status: 429,
						headers: {
							"Retry-After": new Date(Date.now() + 1500).toUTCString(),
						},
						jsonData: {
							error: {
								status: "RESOURCE_EXHAUSTED",
								message: "Quota exceeded; check your plan and billing details.",
							},
						},
					});
				}
				if (calls === 2) {
					return createMockResponse({
						ok: false,
						status: 429,
						headers: { "Retry-After": "   " },
						jsonData: { error: { message: "Rate limit" } },
					});
				}
				return createMockResponse({
					ok: true,
					status: 200,
					jsonData: {
						candidates: [{ content: { parts: [{ text: "{}" }] } }],
					},
				});
			},
		});
		assert.equal(calls, 3);
		assert.deepEqual(okRes, {});
		assert.ok(sleeps[0] >= 500 && sleeps[0] <= 2000);
		assert.equal(sleeps[1], 50);

		// Empty {} from Vision must not crash analyzeScreenshot
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-vision-"));
		try {
			const shotPath = path.join(tempDir, "iphone67_empty.png");
			fs.writeFileSync(shotPath, Buffer.from("png"));
			const emptyAnalysis = await analyzeScreenshot(shotPath, tempDir, "key", {
				fileInfo: {
					width: 1290,
					height: 2796,
					hasAlpha: false,
					format: "png",
					sizeBytes: 100,
				},
				ocr: { available: false, text: "" },
				geminiOptions: {
					readFile: () => Buffer.from("png"),
					fetchImpl: async () =>
						createMockResponse({
							ok: true,
							status: 200,
							jsonData: {
								candidates: [{ content: { parts: [{ text: "{}" }] } }],
							},
						}),
				},
			});
			assert.equal(emptyAnalysis.issues.length, 0);

			// Corrupt JSON from Vision returns null cleanly without crashing analyzeScreenshot
			let corruptCalls = 0;
			const corruptAnalysis = await analyzeScreenshot(
				shotPath,
				tempDir,
				"key",
				{
					fileInfo: {
						width: 1290,
						height: 2796,
						hasAlpha: false,
						format: "png",
						sizeBytes: 100,
					},
					ocr: { available: false, text: "" },
					geminiOptions: {
						readFile: () => Buffer.from("png"),
						fetchImpl: async () => {
							corruptCalls++;
							return createMockResponse({
								ok: true,
								status: 200,
								jsonData: {
									candidates: [{ content: { parts: [{ text: "{bad" }] } }],
								},
							});
						},
					},
				},
			);
			assert.equal(corruptCalls, 1);
			assert.equal(corruptAnalysis.issues.length, 0);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}

		// HTTP 400 non-billing fails fast (calls === 1, returns null) & 403 fails fast (calls === 1, throws fatal)
		let calls400 = 0;
		const res400 = await analyzeScreenshotWithGemini("/fake/shot.png", "key", {
			readFile: () => Buffer.from("png"),
			sleepImpl: async () => {},
			fetchImpl: async () => {
				calls400++;
				return createMockResponse({
					ok: false,
					status: 400,
					jsonData: { error: { message: "Invalid image bytes" } },
				});
			},
		});
		assert.equal(calls400, 1);
		assert.equal(res400, null);

		let calls403 = 0;
		await assert.rejects(
			() =>
				analyzeScreenshotWithGemini("/fake/shot.png", "key", {
					readFile: () => Buffer.from("png"),
					sleepImpl: async () => {},
					fetchImpl: async () => {
						calls403++;
						return createMockResponse({
							ok: false,
							status: 403,
							jsonData: { error: { message: "Forbidden" } },
						});
					},
				}),
			(err) => err.isFatalBillingOrQuota === true,
		);
		assert.equal(calls403, 1);
	});

	it("fixScreenshot() does not report fixed = true when alpha-removal command fails or alpha remains", async () => {
		const { fixScreenshot } = await import(
			"../../scripts/verify_screenshots.mjs"
		);
		const tempDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "verify-alpha-fail-"),
		);
		try {
			const shotPath = path.join(tempDir, "iphone67_alpha.png");
			fs.writeFileSync(shotPath, "not-a-valid-png");

			// Case 1: command fails (returns null)
			const analysis1 = {
				filePath: shotPath,
				relativePath: "iphone67_alpha.png",
				fileInfo: {
					width: 1290,
					height: 2796,
					hasAlpha: true,
					format: "png",
					sizeBytes: 15,
				},
				issues: [],
			};
			const res1 = fixScreenshot(analysis1, tempDir, {
				runCommandImpl: () => null,
				getImageInfoImpl: () => ({
					width: 1290,
					height: 2796,
					hasAlpha: false,
					format: "png",
					sizeBytes: 15,
				}),
			});
			assert.equal(res1.fixed, false);
			assert.equal(res1.fixFailed, true);
			assert.deepEqual(res1.actionsTaken, []);
			assert.ok(analysis1.issues.some((i) => /alpha channel/i.test(i)));

			// Case 2: command exits 0 but getImageInfo still sees hasAlpha: true
			const analysis2 = {
				filePath: shotPath,
				relativePath: "iphone67_alpha.png",
				fileInfo: {
					width: 1290,
					height: 2796,
					hasAlpha: true,
					format: "png",
					sizeBytes: 15,
				},
				issues: [],
			};
			const res2 = fixScreenshot(analysis2, tempDir, {
				runCommandImpl: (cmd) => (cmd.startsWith("which") ? "" : ""),
				getImageInfoImpl: () => ({
					width: 1290,
					height: 2796,
					hasAlpha: true,
					format: "png",
					sizeBytes: 15,
				}),
			});
			assert.equal(res2.fixed, false);
			assert.equal(res2.fixFailed, true);
			assert.deepEqual(res2.actionsTaken, []);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});

describe("capture_screenshots*.mjs and agent-squash-popups.mjs", () => {
	it("migrated app IDs, deep links, script references, and temp path handling", async () => {
		const { buildDeepLink, APP_ID, APP_SCHEME } = await import(
			"../../scripts/capture_screenshots_auto.mjs"
		);
		const { getOutputDir } = await import(
			"../../scripts/capture_screenshots.mjs"
		);
		const {
			APP_ID: squashAppId,
			buildTapFlowYaml,
			getApiKey,
			analyzeScreenshot,
		} = await import("../../scripts/agent-squash-popups.mjs");

		assert.equal(APP_ID, "com.djscottyb.playinginthesandoxlookingatflowers");
		assert.equal(squashAppId, APP_ID);
		assert.equal(APP_SCHEME, "staring-at-flowers");
		assert.equal(buildDeepLink(), "staring-at-flowers://?disableOnboarding=1");
		assert.equal(
			getOutputDir("APP_IPHONE_67", ROOT),
			path.join(ROOT, "store/apple/screenshot/en-US/APP_IPHONE_67"),
		);

		const yaml = buildTapFlowYaml(42, 78);
		assert.match(
			yaml,
			/^appId: com\.djscottyb\.playinginthesandoxlookingatflowers/m,
		);
		assert.match(yaml, /point: 42%, 78%/);

		for (const file of [
			"scripts/verify_screenshots.mjs",
			"scripts/capture_screenshots.mjs",
			"scripts/capture_screenshots_auto.mjs",
			"scripts/agent-squash-popups.mjs",
		]) {
			const src = fs.readFileSync(path.join(ROOT, file), "utf8");
			assert.equal(
				src.includes("qc-screenshots"),
				false,
				`${file} should not reference qc-screenshots`,
			);
			assert.equal(
				src.includes("host.exp.Exponent"),
				false,
				`${file} should not reference host.exp.Exponent`,
			);
			assert.equal(
				src.includes("exp://"),
				false,
				`${file} should not reference exp://`,
			);
			assert.equal(
				src.includes("app_store_assets"),
				false,
				`${file} should not reference app_store_assets`,
			);
			assert.equal(
				src.includes("/tmp/"),
				false,
				`${file} should not reference /tmp/`,
			);
		}

		// getApiKey prefers process.env.GEMINI_API_KEY
		const prevKey = process.env.GEMINI_API_KEY;
		process.env.GEMINI_API_KEY = "env-key-123";
		try {
			assert.equal(getApiKey("/nonexistent/.env.local"), "env-key-123");
		} finally {
			if (prevKey === undefined) {
				delete process.env.GEMINI_API_KEY;
			} else {
				process.env.GEMINI_API_KEY = prevKey;
			}
		}

		// analyzeScreenshot retries 429 before succeeding
		let calls = 0;
		const parsed = await analyzeScreenshot("key", "abc", {
			sleepImpl: async () => {},
			backoffBaseMs: 1,
			fetchImpl: async () => {
				calls++;
				if (calls === 1) {
					return createMockResponse({
						ok: false,
						status: 429,
						jsonData: { error: { status: "RESOURCE_EXHAUSTED" } },
					});
				}
				return createMockResponse({
					ok: true,
					status: 200,
					jsonData: {
						candidates: [
							{
								content: {
									parts: [{ text: JSON.stringify({ hasPopup: false }) }],
								},
							},
						],
					},
				});
			},
		});
		assert.equal(calls, 2);
		assert.deepEqual(parsed, { hasPopup: false });

		// 429 with "billing" wording + HTTP-date Retry-After retries, while 403/400 fail fast
		let squashBilling429Calls = 0;
		const squashSleeps = [];
		const squashOk = await analyzeScreenshot("key", "abc", {
			backoffBaseMs: 20,
			maxAttempts: 3,
			sleepImpl: async (ms) => {
				squashSleeps.push(ms);
			},
			fetchImpl: async () => {
				squashBilling429Calls++;
				if (squashBilling429Calls === 1) {
					return createMockResponse({
						ok: false,
						status: 429,
						headers: {
							"Retry-After": new Date(Date.now() + 1500).toUTCString(),
						},
						jsonData: {
							error: {
								status: "RESOURCE_EXHAUSTED",
								message: "Check your plan and billing details.",
							},
						},
					});
				}
				return createMockResponse({
					ok: true,
					status: 200,
					jsonData: {
						candidates: [
							{
								content: {
									parts: [{ text: JSON.stringify({ hasPopup: false }) }],
								},
							},
						],
					},
				});
			},
		});
		assert.equal(squashBilling429Calls, 2);
		assert.deepEqual(squashOk, { hasPopup: false });
		assert.ok(squashSleeps[0] >= 500 && squashSleeps[0] <= 2000);

		for (const status of [403, 400]) {
			let squashFailCalls = 0;
			await assert.rejects(() =>
				analyzeScreenshot("key", "abc", {
					sleepImpl: async () => {},
					fetchImpl: async () => {
						squashFailCalls++;
						return createMockResponse({
							ok: false,
							status,
							jsonData: { error: { message: `Error ${status}` } },
						});
					},
				}),
			);
			assert.equal(squashFailCalls, 1);
		}
	});
});

describe("App Store Connect scripts", () => {
	it("preserves ../../eas-app-store-kit/src/index.mjs import path across all 3 scripts", async () => {
		const m = await import("../../scripts/manage-subscriptions.mjs");
		const d = await import("../../scripts/delete-draft-submission.mjs");
		const r = await import("../../scripts/remove-version-from-submission.mjs");

		assert.equal(
			m.EAS_APP_STORE_KIT_SPECIFIER,
			"../../eas-app-store-kit/src/index.mjs",
		);
		assert.equal(
			d.EAS_APP_STORE_KIT_SPECIFIER,
			"../../eas-app-store-kit/src/index.mjs",
		);
		assert.equal(
			r.EAS_APP_STORE_KIT_SPECIFIER,
			"../../eas-app-store-kit/src/index.mjs",
		);
	});

	it("defines $4.99 monthly, $29.99 annual, and $99.99 Founders non-consumable plans with zero hardcoded 0.99", async () => {
		const { SUBSCRIPTION_PLANS, NON_CONSUMABLE_IAPS } = await import(
			"../../scripts/manage-subscriptions.mjs"
		);
		const src = fs.readFileSync(
			path.join(ROOT, "scripts/manage-subscriptions.mjs"),
			"utf8",
		);
		assert.equal(src.includes('"0.99"'), false);

		const monthly = SUBSCRIPTION_PLANS.find((p) => p.key === "monthly");
		const annual = SUBSCRIPTION_PLANS.find((p) => p.key === "annual");
		const founders = NON_CONSUMABLE_IAPS.find((i) => i.key === "founders");

		assert.equal(monthly.usdPrice, "4.99");
		assert.equal(monthly.subscriptionPeriod, "ONE_MONTH");
		assert.equal(
			monthly.productId,
			"com.djscottyb.playinginthesandoxlookingatflowers.premium_monthly",
		);

		assert.equal(annual.usdPrice, "29.99");
		assert.equal(annual.subscriptionPeriod, "ONE_YEAR");
		assert.equal(
			annual.productId,
			"com.djscottyb.playinginthesandoxlookingatflowers.premium_annual",
		);

		assert.equal(founders.usdPrice, "99.99");
		assert.equal(founders.inAppPurchaseType, "NON_CONSUMABLE");
		assert.equal(
			founders.productId,
			"com.djscottyb.playinginthesandoxlookingatflowers.premium_founders",
		);
	});

	it("paginates links.next with cursor= and tolerates dry-run non-array payloads", async () => {
		const { paginateAll } = await import(
			"../../scripts/manage-subscriptions.mjs"
		);

		const requested = [];
		const mockClient = {
			dryRun: false,
			async request(method, apiPath, opts) {
				requested.push({ method, apiPath, opts });
				if (!opts?.query?.cursor) {
					return {
						data: [{ id: "pp-1", attributes: { customerPrice: "4.99" } }],
						links: {
							next: "https://api.appstoreconnect.apple.com/v1/subscriptions/sub-1/pricePoints?filter%5Bterritory%5D=USA&limit=200&cursor=page2",
						},
					};
				}
				return {
					data: [{ id: "pp-2", attributes: { customerPrice: "29.99" } }],
					links: {},
				};
			},
		};

		const items = await paginateAll(
			mockClient,
			"/subscriptions/sub-1/pricePoints",
			{
				query: { "filter[territory]": "USA", limit: 200 },
				matchFn: (p) => p.attributes?.customerPrice === "29.99",
			},
		);
		assert.equal(items.length, 2);
		assert.equal(items[1].id, "pp-2");
		assert.equal(requested[1].apiPath, "/subscriptions/sub-1/pricePoints");
		assert.equal(requested[1].opts.query.cursor, "page2");

		// Dry-run non-array payload tolerance
		const dryItems = await paginateAll(
			{
				dryRun: true,
				async request() {
					return { data: { id: "dry-run-resource" } };
				},
			},
			"/subscriptionGroups/dry-run/subscriptions",
		);
		assert.deepEqual(dryItems, []);
	});

	it("updates mismatched existing subscription price ($0.99 -> $4.99) instead of skipping", async () => {
		const { ensureSubscriptionPlan } = await import(
			"../../scripts/manage-subscriptions.mjs"
		);

		const calls = [];
		const mockClient = {
			dryRun: false,
			async request(method, apiPath, opts) {
				calls.push({ method, apiPath, opts });
				if (
					method === "GET" &&
					apiPath === "/subscriptionGroups/grp-1/subscriptions"
				) {
					return {
						data: [
							{
								id: "sub-1",
								attributes: {
									name: "Premium Monthly",
									productId:
										"com.djscottyb.playinginthesandoxlookingatflowers.premium_monthly",
								},
							},
						],
					};
				}
				if (
					method === "GET" &&
					apiPath === "/subscriptions/sub-1/subscriptionLocalizations"
				) {
					return {
						data: [
							{
								id: "loc-1",
								attributes: { locale: "en-US", name: "Premium Monthly" },
							},
						],
					};
				}
				if (
					method === "GET" &&
					apiPath === "/subscriptions/sub-1/subscriptionAvailability"
				) {
					return { data: { id: "avail-1" } };
				}
				if (
					method === "GET" &&
					apiPath === "/subscriptions/sub-1/pricePoints"
				) {
					return {
						data: [
							{ id: "pp-099", attributes: { customerPrice: "0.99" } },
							{ id: "pp-499", attributes: { customerPrice: "4.99" } },
						],
					};
				}
				if (method === "GET" && apiPath === "/subscriptions/sub-1/prices") {
					return {
						data: [
							{
								id: "old-price-usa",
								relationships: {
									territory: { data: { id: "USA" } },
									subscriptionPricePoint: { data: { id: "pp-099" } },
								},
							},
						],
					};
				}
				if (
					method === "GET" &&
					apiPath === "/subscriptionPricePoints/pp-499/equalizations"
				) {
					return { data: [] };
				}
				if (
					method === "DELETE" &&
					apiPath === "/subscriptionPrices/old-price-usa"
				) {
					return {};
				}
				if (method === "POST" && apiPath === "/subscriptionPrices") {
					return { data: { id: "new-price-usa" } };
				}
				throw new Error(`Unexpected call: ${method} ${apiPath}`);
			},
		};

		await ensureSubscriptionPlan(
			mockClient,
			"app-1",
			{
				id: "grp-1",
				attributes: { referenceName: "Premium Subscription Group" },
			},
			{
				key: "monthly",
				name: "Premium Monthly",
				productId:
					"com.djscottyb.playinginthesandoxlookingatflowers.premium_monthly",
				subscriptionPeriod: "ONE_MONTH",
				usdPrice: "4.99",
				description: "Monthly pass",
			},
			{ delayMs: 0, sleepImpl: async () => {} },
		);

		assert.ok(
			calls.some(
				(c) =>
					c.method === "DELETE" &&
					c.apiPath === "/subscriptionPrices/old-price-usa",
			),
		);
		const postCall = calls.find(
			(c) => c.method === "POST" && c.apiPath === "/subscriptionPrices",
		);
		assert.ok(postCall);
		assert.equal(
			postCall.opts.body.data.relationships.subscriptionPricePoint.data.id,
			"pp-499",
		);
	});

	it("drives v2 + v1 endpoints in ensureNonConsumableIap for Founders $99.99", async () => {
		const { ensureNonConsumableIap, NON_CONSUMABLE_IAPS } = await import(
			"../../scripts/manage-subscriptions.mjs"
		);

		const v1Calls = [];
		const v2Calls = [];

		const mockClient = {
			dryRun: false,
			token: () => "mock-jwt",
			async fetch(url, init) {
				const u = new URL(url.toString());
				const body = init.body ? JSON.parse(init.body) : null;
				v2Calls.push({
					method: init.method,
					pathname: u.pathname,
					search: u.search,
					body,
				});
				if (init.method === "POST" && u.pathname === "/v2/inAppPurchases") {
					return createMockResponse({
						ok: true,
						status: 201,
						jsonData: {
							data: {
								id: "iap-founders-1",
								attributes: { name: "Founders Edition (Lifetime VIP)" },
							},
						},
					});
				}
				if (
					init.method === "GET" &&
					u.pathname ===
						"/v2/inAppPurchases/iap-founders-1/inAppPurchaseLocalizations"
				) {
					return createMockResponse({
						ok: true,
						status: 200,
						jsonData: { data: [] },
					});
				}
				if (
					init.method === "GET" &&
					u.pathname ===
						"/v2/inAppPurchases/iap-founders-1/inAppPurchaseAvailability"
				) {
					return createMockResponse({ ok: false, status: 404, jsonData: {} });
				}
				if (
					init.method === "GET" &&
					u.pathname === "/v2/inAppPurchases/iap-founders-1/pricePoints"
				) {
					return createMockResponse({
						ok: true,
						status: 200,
						jsonData: {
							data: [
								{ id: "iap-pp-9999", attributes: { customerPrice: "99.99" } },
							],
						},
					});
				}
				if (
					init.method === "GET" &&
					u.pathname === "/v2/inAppPurchases/iap-founders-1/iapPriceSchedule"
				) {
					return createMockResponse({ ok: false, status: 404, jsonData: {} });
				}
				throw new Error(`Unexpected v2 fetch: ${init.method} ${u.pathname}`);
			},
			async request(method, apiPath, opts) {
				v1Calls.push({ method, apiPath, opts });
				if (method === "GET" && apiPath === "/apps/app-1/inAppPurchasesV2") {
					return { data: [] };
				}
				if (method === "GET" && apiPath === "/territories") {
					return { data: [{ id: "USA" }, { id: "CAN" }] };
				}
				if (
					method === "POST" &&
					[
						"/inAppPurchaseLocalizations",
						"/inAppPurchaseAvailabilities",
						"/inAppPurchasePriceSchedules",
					].includes(apiPath)
				) {
					return { data: { id: `created-${apiPath.slice(1)}` } };
				}
				throw new Error(`Unexpected v1 request: ${method} ${apiPath}`);
			},
		};

		const iap = await ensureNonConsumableIap(
			mockClient,
			"app-1",
			NON_CONSUMABLE_IAPS[0],
		);
		assert.equal(iap.id, "iap-founders-1");
		assert.ok(
			v1Calls.some((c) => c.apiPath === "/apps/app-1/inAppPurchasesV2"),
		);
		assert.ok(
			v2Calls.some(
				(c) =>
					c.method === "POST" &&
					c.pathname === "/v2/inAppPurchases" &&
					c.body.data.attributes.inAppPurchaseType === "NON_CONSUMABLE",
			),
		);
		assert.ok(v1Calls.some((c) => c.apiPath === "/inAppPurchaseLocalizations"));
		assert.ok(
			v1Calls.some((c) => c.apiPath === "/inAppPurchaseAvailabilities"),
		);
		assert.ok(
			v2Calls.some(
				(c) => c.pathname === "/v2/inAppPurchases/iap-founders-1/pricePoints",
			),
		);
		assert.ok(
			v1Calls.some((c) => c.apiPath === "/inAppPurchasePriceSchedules"),
		);
	});

	it("retries /v2/ requests in ascRequest on 429, 5xx, and network errors", async () => {
		const { ascRequest } = await import(
			"../../scripts/manage-subscriptions.mjs"
		);
		let calls = 0;
		const sleeps = [];
		const mockClient = {
			dryRun: false,
			verbose: false,
			token: () => "mock-jwt",
			async fetch() {
				calls++;
				if (calls === 1) {
					throw new Error("ECONNRESET");
				}
				if (calls === 2) {
					return createMockResponse({
						ok: false,
						status: 429,
						headers: { "Retry-After": "1" },
						jsonData: { errors: [{ code: "RATE_LIMIT" }] },
					});
				}
				if (calls === 3) {
					return createMockResponse({
						ok: false,
						status: 503,
						textData: "Service Unavailable",
					});
				}
				return createMockResponse({
					ok: true,
					status: 200,
					jsonData: { data: [{ id: "ok-1" }] },
				});
			},
		};

		const res = await ascRequest(
			mockClient,
			"GET",
			"/v2/inAppPurchases/iap-1/pricePoints",
			{
				sleepImpl: async (ms) => {
					sleeps.push(ms);
				},
				backoffBaseMs: 10,
				maxAttempts: 4,
			},
		);
		assert.equal(calls, 4);
		assert.deepEqual(sleeps, [10, 1000, 30]);
		assert.deepEqual(res, { data: [{ id: "ok-1" }] });

		// HTTP-date Retry-After and whitespace fallback in ascRequest, plus 400 fail-fast
		let ascDateCalls = 0;
		const ascDateSleeps = [];
		const ascClient = {
			dryRun: false,
			verbose: false,
			token: () => "mock-jwt",
			async fetch() {
				ascDateCalls++;
				if (ascDateCalls === 1) {
					return createMockResponse({
						ok: false,
						status: 429,
						headers: {
							"Retry-After": new Date(Date.now() + 1500).toUTCString(),
						},
						jsonData: { errors: [{ code: "RATE_LIMIT" }] },
					});
				}
				if (ascDateCalls === 2) {
					return createMockResponse({
						ok: false,
						status: 429,
						headers: { "Retry-After": "   " },
						jsonData: { errors: [{ code: "RATE_LIMIT" }] },
					});
				}
				return createMockResponse({
					ok: true,
					status: 200,
					jsonData: { data: [] },
				});
			},
		};
		await ascRequest(ascClient, "GET", "/v2/inAppPurchases/iap-1/pricePoints", {
			sleepImpl: async (ms) => {
				ascDateSleeps.push(ms);
			},
			backoffBaseMs: 25,
			maxAttempts: 4,
		});
		assert.equal(ascDateCalls, 3);
		assert.ok(ascDateSleeps[0] >= 500 && ascDateSleeps[0] <= 2000);
		assert.equal(ascDateSleeps[1], 50);

		let asc400Calls = 0;
		await assert.rejects(
			() =>
				ascRequest(
					{
						dryRun: false,
						token: () => "mock-jwt",
						async fetch() {
							asc400Calls++;
							return createMockResponse({
								ok: false,
								status: 400,
								jsonData: { errors: [{ code: "BAD_REQUEST" }] },
							});
						},
					},
					"GET",
					"/v2/inAppPurchases/iap-1/pricePoints",
					{ sleepImpl: async () => {}, maxAttempts: 4 },
				),
			/failed with 400/,
		);
		assert.equal(asc400Calls, 1);
	});

	it("runs manage-subscriptions main() cleanly end-to-end in dryRun mode", async () => {
		const { main } = await import("../../scripts/manage-subscriptions.mjs");
		const kitPath = path.resolve(ROOT, "../eas-app-store-kit/src/index.mjs");

		if (fs.existsSync(kitPath)) {
			const { AppStoreConnectClient } = await import(kitPath);
			const { privateKey: ephemeralKey } = generateKeyPairSync("ec", {
				namedCurve: "prime256v1",
			});
			const client = new AppStoreConnectClient({
				keyId: "test-key",
				issuerId: "test-issuer",
				privateKey: ephemeralKey,
				dryRun: true,
				quiet: true,
				fetch: async (url) => {
					const u = new URL(url.toString());
					if (u.pathname === "/v1/apps/app-1") {
						return createMockResponse({
							ok: true,
							status: 200,
							jsonData: {
								data: {
									id: "app-1",
									attributes: {
										name: "Looking at Flowers",
										bundleId:
											"com.djscottyb.playinginthesandoxlookingatflowers",
									},
								},
							},
						});
					}
					return createMockResponse({
						ok: true,
						status: 200,
						jsonData: { data: [] },
					});
				},
			});

			await main({
				client,
				config: { appId: "app-1", dryRun: true },
				delayMs: 0,
				sleepImpl: async () => {},
			});
		} else {
			const mockDryClient = {
				dryRun: true,
				log() {},
				async request(method, apiPath) {
					if (method !== "GET") {
						return { data: { id: `dry-run-${apiPath}`, attributes: {} } };
					}
					return { data: [] };
				},
			};
			await main({
				client: mockDryClient,
				config: { appId: "app-1", dryRun: true },
				delayMs: 0,
				sleepImpl: async () => {},
			});
		}
	});

	it("validates submissionId, filters --submission-id for strict kit.loadConfig, and passes { query: { limit: 50 } } in remove-version-from-submission.mjs", async () => {
		const {
			resolveSubmissionId,
			filterKitArgv,
			paginateSubmissionItems,
			validateCredentials,
		} = await import("../../scripts/remove-version-from-submission.mjs");

		assert.throws(
			() => resolveSubmissionId([], {}),
			/Missing review submission ID/,
		);
		assert.equal(
			resolveSubmissionId(["--submission-id", "sub-123"], {}),
			"sub-123",
		);
		assert.equal(resolveSubmissionId(["--submission-id=sub-eq"], {}), "sub-eq");
		assert.equal(
			resolveSubmissionId(["--app-id", "12345", "sub-123"], {}),
			"sub-123",
		);
		assert.equal(
			resolveSubmissionId(
				["--config", "app-store-config.json", "--dry-run", "sub-pos"],
				{},
			),
			"sub-pos",
		);
		assert.equal(
			resolveSubmissionId([], { ASC_SUBMISSION_ID: "sub-env" }),
			"sub-env",
		);
		assert.throws(() => validateCredentials({}), /Missing required/);

		const filtered = filterKitArgv([
			"node",
			"scripts/remove-version-from-submission.mjs",
			"--app-id",
			"12345",
			"--submission-id",
			"sub-123",
			"--dry-run",
		]);
		assert.deepEqual(filtered, [
			"node",
			"scripts/remove-version-from-submission.mjs",
			"--app-id",
			"12345",
			"--dry-run",
		]);
		assert.deepEqual(filterKitArgv(["--submission-id=sub-123", "--dry-run"]), [
			"--dry-run",
		]);

		// Verify strict parseArgs compatibility matching eas-app-store-kit/src/config.mjs
		const parsed = parseArgs({
			args: filtered.slice(2),
			options: {
				config: { type: "string" },
				"app-id": { type: "string" },
				version: { type: "string" },
				"asc-build-id": { type: "string" },
				"build-id": { type: "string" },
				"release-type": { type: "string" },
				"wait-processing-minutes": { type: "string" },
				"poll-interval-seconds": { type: "string" },
				"dry-run": { type: "boolean" },
				verbose: { type: "boolean" },
				quiet: { type: "boolean" },
				"skip-local-checks": { type: "boolean" },
				"skip-eas-upload": { type: "boolean" },
				"skip-review-submit": { type: "boolean" },
				"allow-first-iap-unattached": { type: "boolean" },
				resume: { type: "boolean" },
				help: { type: "boolean", short: "h" },
			},
			strict: true,
			allowPositionals: true,
		});
		assert.equal(parsed.values["app-id"], "12345");
		assert.equal(parsed.values["dry-run"], true);

		const kitConfigPath = path.resolve(
			ROOT,
			"../eas-app-store-kit/src/config.mjs",
		);
		if (fs.existsSync(kitConfigPath)) {
			const { loadConfig } = await import(kitConfigPath);
			const cfg = await loadConfig({
				projectRoot: ROOT,
				argv: filtered,
				env: {},
			});
			assert.equal(cfg.appId, "12345");
			assert.equal(cfg.dryRun, true);
		}

		const src = fs.readFileSync(
			path.join(ROOT, "scripts/remove-version-from-submission.mjs"),
			"utf8",
		);
		assert.equal(src.includes("ea9e6b99"), false);

		const recorded = [];
		const items = await paginateSubmissionItems(
			{
				async request(method, apiPath, opts) {
					recorded.push({ method, apiPath, opts });
					return { data: [{ id: "item-1", type: "reviewSubmissionItems" }] };
				},
			},
			"sub-123",
		);
		assert.equal(items.length, 1);
		assert.deepEqual(recorded[0].opts, { query: { limit: 50 } });
	});

	it("validates credentials and paginates submissions in delete-draft-submission.mjs", async () => {
		const { validateCredentials, paginateSubmissions } = await import(
			"../../scripts/delete-draft-submission.mjs"
		);
		assert.throws(
			() => validateCredentials({ keyId: "k" }),
			/Missing required/,
		);

		const items = await paginateSubmissions(
			{
				async request(_m, _p, opts) {
					if (!opts?.query?.cursor) {
						return {
							data: [{ id: "s1", attributes: { state: "READY_FOR_REVIEW" } }],
							links: {
								next: "https://api.appstoreconnect.apple.com/v1/apps/a1/reviewSubmissions?cursor=next1",
							},
						};
					}
					return {
						data: [{ id: "s2", attributes: { state: "COMPLETE" } }],
					};
				},
			},
			"a1",
		);
		assert.deepEqual(
			items.map((s) => s.id),
			["s1", "s2"],
		);
	});
});

describe("Maestro YAML static contract", () => {
	it("targets com.djscottyb.playinginthesandoxlookingatflowers and staring-at-flowers:// across all 9 flows", () => {
		const maestroFiles = [
			".maestro/smoke.yml",
			".maestro/capture_flow.yml",
			".maestro/change-region.yml",
			".maestro/error-states.yml",
			".maestro/flip-card.yml",
			".maestro/location-denied.yml",
			".maestro/navigation.yml",
			".maestro/tap-read.yml",
			".maestro/subflows/connect.yml",
		];

		for (const relPath of maestroFiles) {
			const content = fs.readFileSync(path.join(ROOT, relPath), "utf8");
			assert.match(
				content,
				/^appId:\s*com\.djscottyb\.playinginthesandoxlookingatflowers$/m,
				`${relPath} must set appId to com.djscottyb.playinginthesandoxlookingatflowers`,
			);
			assert.equal(
				content.includes("host.exp.Exponent"),
				false,
				`${relPath} must not reference host.exp.Exponent`,
			);
			assert.equal(
				content.includes("exp://"),
				false,
				`${relPath} must not reference exp://`,
			);
			assert.equal(
				content.includes("app_store_assets"),
				false,
				`${relPath} must not reference app_store_assets`,
			);
		}

		const locationDenied = fs.readFileSync(
			path.join(ROOT, ".maestro/location-denied.yml"),
			"utf8",
		);
		assert.match(locationDenied, /openLink:\s*"staring-at-flowers:\/\/"/);

		const connectFlow = fs.readFileSync(
			path.join(ROOT, ".maestro/subflows/connect.yml"),
			"utf8",
		);
		assert.match(
			connectFlow,
			/openLink:\s*"staring-at-flowers:\/\/\?disableOnboarding=1"/,
		);

		const captureFlow = fs.readFileSync(
			path.join(ROOT, ".maestro/capture_flow.yml"),
			"utf8",
		);
		assert.match(captureFlow, /visible:\s*"Botanical Search"/);
		assert.equal(captureFlow.includes("Vector Vibe Search"), false);
		assert.ok(captureFlow.includes("SCREENSHOT_DIR"));
		assert.ok(captureFlow.includes("store/apple/screenshot/_staging"));

		const captureAuto = fs.readFileSync(
			path.join(ROOT, "scripts/capture_screenshots_auto.mjs"),
			"utf8",
		);
		assert.match(captureAuto, /"-e",\s*`SCREENSHOT_DIR=/);
	});
});
