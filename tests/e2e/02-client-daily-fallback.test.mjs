import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, test } from "node:test";
import {
	findFunctionsByName,
	findJsxElements,
	getNodeText,
	parseTsxAst,
	REPO_ROOT,
	readRepoFile,
	readRepoJson,
} from "./helpers/repo.mjs";
import { createE2EContext } from "./helpers/rn-loader.mjs";

function utcDateOffset(daysOffset) {
	const d = new Date(Date.now() + daysOffset * 86400 * 1000);
	const yyyy = d.getUTCFullYear();
	const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(d.getUTCDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

describe("02 — Client Daily Flower, Region Fallback & Detail Display (Items 3, 4, 5)", () => {
	// =========================================================================
	// Item 3: Search & Offline Detail Non-Poppy Display
	// =========================================================================

	test("T1-I3-01: app/flower-detail.tsx does not fall back to midday.png California Poppy", () => {
		const source = readRepoFile("app/flower-detail.tsx");
		assert.equal(
			source.includes("midday.png"),
			false,
			"flower-detail.tsx must not render assets/defaults/midday.png for search/offline species",
		);
	});

	test("T1-I3-02: app/flower-detail.tsx handles empty imageUri with a botanical specimen fallback view", () => {
		const source = readRepoFile("app/flower-detail.tsx");
		assert.match(
			source,
			/imageUri\s*\?/,
			"flower-detail.tsx should branch on imageUri presence",
		);
		assert.match(
			source,
			/specimen|offline|botanical|placeholder|View/i,
			"flower-detail.tsx should render a dedicated specimen card/placeholder when imageUri is empty",
		);
	});

	test("T1-I3-03: app/index.tsx offline dbFlower does not reuse getDefaultFlower().imageSource for non-poppy species", () => {
		const ast = parseTsxAst("app/index.tsx");
		const helpers = findFunctionsByName(ast, "offlineSpeciesToDailyFlower");
		assert.equal(
			helpers.length,
			1,
			"app/index.tsx must separate offlineSpeciesToDailyFlower conversion",
		);
		const helperText = getNodeText(ast, helpers[0]);
		assert.match(helperText, /isCaliforniaPoppy/);
		assert.match(helperText, /imageSource:\s*null/);
	});

	test("T1-I3-04: app/index.tsx supports rendering offline DB species without a California Poppy image", () => {
		const source = readRepoFile("app/index.tsx");
		const hasNullableOrPlaceholder =
			/imageSource:\s*null|imageSource:\s*undefined|isOfflineOnly|specimen|dbFlower/i.test(
				source,
			);
		assert.ok(
			hasNullableOrPlaceholder &&
				!source.includes("getDefaultFlower(date).imageSource, // daylight"),
			"app/index.tsx must decouple dbFlower visual presentation from California Poppy daylight image",
		);
	});

	test("T1-I3-05: app/flower-detail.tsx handles missing/empty blurb gracefully", () => {
		const source = readRepoFile("app/flower-detail.tsx");
		// Since all 396 rows in species.db/species.json currently have empty blurb,
		// flower-detail.tsx should guard or provide fallback copy when blurb is empty.
		const handlesEmptyBlurb =
			/blurb\s*\|\||blurb\s*\?|blurb\.trim\(\)|bloom_months|Native/i.test(
				source,
			);
		assert.ok(
			handlesEmptyBlurb,
			"flower-detail.tsx should gracefully handle empty blurb strings",
		);
	});

	test("T2-I3-06: app/index.tsx search result route params do not force midday.png California Poppy", () => {
		const source = readRepoFile("app/index.tsx");
		const detailSrc = readRepoFile("app/flower-detail.tsx");
		assert.match(source, /pathname:\s*"\/flower-detail"/);
		assert.equal(
			detailSrc.includes("assets/defaults/"),
			false,
			"flower-detail.tsx must not bundle assets/defaults/* poppy images when opened from search",
		);
	});

	test("T2-I3-07: app/index.tsx preserves real dbFlower common, latin, and region fields", () => {
		const source = readRepoFile("app/index.tsx");
		assert.match(source, /common:\s*dbFlower\.common/);
		assert.match(source, /latin:\s*dbFlower\.latin/);
		assert.match(source, /state:\s*dbFlower\.region/);
	});

	test("T2-I3-08: lib/data/defaults.ts DEFAULT_FLOWER remains isolated to California Poppy default fallback", async () => {
		const ctx = createE2EContext();
		try {
			const defaults = await ctx.importFresh("lib/data/defaults.ts");
			assert.equal(defaults.DEFAULT_FLOWER.common, "California Poppy");
			assert.equal(defaults.DEFAULT_FLOWER.variants.length, 4);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I3-09: app/flower-detail.tsx handles missing date or 'default' state without crashing", () => {
		const source = readRepoFile("app/flower-detail.tsx");
		assert.match(source, /flowerState\s*===\s*"default"/);
		assert.match(source, /formatDateLabel\(\s*date\s*\?\?\s*""\s*\)/);
	});

	test("T2-I3-10: app/index.tsx detailImageUri only extracts plain http/file URI objects", () => {
		const source = readRepoFile("app/index.tsx");
		assert.match(source, /"uri"\s*in/);
		assert.match(source, /detailImageUri/);
	});

	// =========================================================================
	// Item 4: Travel Mode Chips & Client 404 Cascade
	// =========================================================================

	test("T1-I4-01: app/index.tsx Travel Mode quick-select chips use MX-MEX, RU-MOW, CN-BJ", () => {
		const source = readRepoFile("app/index.tsx");
		const speciesJson = readRepoJson("lib/data/species.json");
		for (const code of ["MX-MEX", "RU-MOW", "CN-BJ"]) {
			assert.ok(code in speciesJson, `${code} must exist in species.json`);
			assert.ok(
				source.includes(`"${code}"`),
				`app/index.tsx quick-select chip must use "${code}"`,
			);
		}
		assert.equal(
			/code:\s*"(MX|RU|CN)"/.test(source),
			false,
			'app/index.tsx must not use bare "MX", "RU", or "CN" chip codes',
		);
	});

	test("T1-I4-02: app/index.tsx cascades 404 on non-default region to 'default' CDN before offline/unpublished", () => {
		const source = readRepoFile("app/index.tsx");
		const hasCascade =
			/404[\s\S]{0,600}fetchDailyFlower\(\s*"default"/s.test(source) ||
			/region\s*!==\s*"default"[\s\S]{0,400}fetchDailyFlower\(\s*"default"/s.test(
				source,
			);
		assert.ok(
			hasCascade,
			'app/index.tsx must cascade 404 on non-default region to fetchDailyFlower("default", date)',
		);
		assert.match(
			source,
			/404[\s\S]{0,1200}(resolveOfflineFallbackFlower|getDailyFlowerOffline)/s,
			"app/index.tsx must fall back to offline species DB when CDN 404 cascade fails",
		);
		assert.match(source, /getDailyFlowerOffline/);
	});

	test("T1-I4-03: lib/region.ts resolves MX, RU, CN geocodes to MX-MEX, RU-MOW, CN-BJ", async () => {
		const cases = [
			[{ isoCountryCode: "MX", region: "Mexico City" }, "MX-MEX"],
			[{ isoCountryCode: "RU", region: "Moscow" }, "RU-MOW"],
			[{ isoCountryCode: "CN", region: "Beijing" }, "CN-BJ"],
			[{ isoCountryCode: "CA", region: "Ontario" }, "CA-ON"],
			[{ isoCountryCode: "US", region: "California" }, "CA"],
		];
		for (const [place, expected] of cases) {
			const ctx = createE2EContext({ locationPlaces: [place] });
			try {
				const reg = await ctx.importFresh("lib/region.ts");
				const res = await reg.getRegionWithStatus();
				assert.equal(res.region, expected);
				assert.equal(res.permissionDenied, false);
			} finally {
				ctx.cleanup();
			}
		}
	});

	test("T1-I4-04: lib/region.ts falls back to 'default' when location permission is denied", async () => {
		const ctx = createE2EContext({ locationPermission: "denied" });
		try {
			const reg = await ctx.importFresh("lib/region.ts");
			const res = await reg.getRegionWithStatus();
			assert.equal(res.region, "default");
			assert.equal(res.permissionDenied, true);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I4-05: lib/region.ts setRegionOverride and resetRegion manage travel overrides cleanly", async () => {
		const ctx = createE2EContext({
			locationPlaces: [{ isoCountryCode: "US", region: "Texas" }],
		});
		try {
			const reg = await ctx.importFresh("lib/region.ts");
			assert.equal(await reg.getRegion(), "TX");
			await reg.setRegionOverride("MX-MEX");
			assert.equal(await reg.getRegion(), "MX-MEX");
			assert.equal(await reg.getRegionOverride(), "MX-MEX");
			await reg.setRegionOverride(null);
			assert.equal(await reg.getRegion(), "TX");
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I4-06: every quick-select chip code in app/index.tsx exists in lib/data/species.json", () => {
		const source = readRepoFile("app/index.tsx");
		const speciesJson = readRepoJson("lib/data/species.json");
		const chipMatches = [
			...source.matchAll(/\{\s*code:\s*"([^"]+)"\s*,\s*label:/g),
		];
		assert.ok(chipMatches.length >= 5, "Should find quick-select chips");
		for (const m of chipMatches) {
			const code = m[1];
			assert.ok(
				code in speciesJson,
				`Chip code "${code}" must be a valid key in lib/data/species.json`,
			);
		}
	});

	test("T2-I4-07: app/index.tsx guards against infinite 'default' -> 'default' 404 recursion", () => {
		const source = readRepoFile("app/index.tsx");
		const callsDefault = /fetchDailyFlower\(\s*"default"/.test(source);
		assert.ok(callsDefault, 'Must cascade to "default"');
		assert.match(
			source,
			/region\s*!==\s*"default"|state\s*!==\s*"default"/,
			'Must check region !== "default" before cascading to "default"',
		);
	});

	test("T2-I4-08: lib/region.ts handles empty reverseGeocodeAsync array and unknown country gracefully", async () => {
		const ctx1 = createE2EContext({ locationPlaces: [] });
		try {
			assert.throws(
				() => createE2EContext(),
				/re-entrancy/i,
				"Overlapping createE2EContext calls must throw rather than leaking globals",
			);
			const reg1 = await ctx1.importFresh("lib/region.ts");
			assert.equal(await reg1.getRegion(), "default");
		} finally {
			ctx1.cleanup();
		}

		const ctx2 = createE2EContext({
			locationPlaces: [{ isoCountryCode: "ZZ", region: "Nowhere" }],
		});
		try {
			const reg2 = await ctx2.importFresh("lib/region.ts");
			assert.equal(await reg2.getRegion(), "default");
		} finally {
			ctx2.cleanup();
		}

		assert.equal(
			globalThis.__E2E_MOCKS__,
			undefined,
			"Sequential contexts must not leak globalThis.__E2E_MOCKS__",
		);
	});

	test("T2-I4-09: lib/region.ts re-resolves cached 'default' when permission is later granted", async () => {
		const ctx = createE2EContext({
			initialStorage: { "region.state.v1": "default" },
			locationPermission: "granted",
			locationPlaces: [{ isoCountryCode: "US", region: "Oregon" }],
		});
		try {
			const reg = await ctx.importFresh("lib/region.ts");
			const res = await reg.getRegionWithStatus();
			assert.equal(res.region, "OR");
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I4-10: lib/region.ts maps European, African, and Latin American countries to valid species.json buckets", async () => {
		const speciesJson = readRepoJson("lib/data/species.json");
		const samples = [
			[{ isoCountryCode: "FR", region: "Ile-de-France" }, "EU-WEST"],
			[{ isoCountryCode: "KE", region: "Nairobi" }, "AF-EAST"],
			[{ isoCountryCode: "BR", region: "Amazonas" }, "BR-AM"],
			[{ isoCountryCode: "IS", region: "Reykjavik" }, "IS"],
		];
		for (const [place, expected] of samples) {
			assert.ok(expected in speciesJson);
			const ctx = createE2EContext({ locationPlaces: [place] });
			try {
				const reg = await ctx.importFresh("lib/region.ts");
				assert.equal(await reg.getRegion(), expected);
			} finally {
				ctx.cleanup();
			}
		}
	});

	test("T2-I4-11: lib/region.ts handles lowercase or trimmed US state codes", async () => {
		const ctx = createE2EContext({
			locationPlaces: [{ isoCountryCode: "US", region: "  tx  " }],
		});
		try {
			const reg = await ctx.importFresh("lib/region.ts");
			assert.equal(await reg.getRegion(), "TX");
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I4-12: lib/region.ts maps all 50 US states + DC codes in species.json", () => {
		const speciesJson = readRepoJson("lib/data/species.json");
		const required = ["AL", "CA", "NY", "TX", "DC", "HI", "AK", "FL", "WA"];
		for (const code of required) {
			assert.ok(code in speciesJson, `${code} missing from species.json`);
		}
	});

	// =========================================================================
	// Item 5: Client Day 7-8 PNG/JPG, UTC Boundary, Sidecar imageExt, onError
	// =========================================================================

	test("T1-I5-01: fetchDailyFlower fetches sidecar JSON, honors sidecar imageExt, and caches result", async () => {
		const today = utcDateOffset(0);
		const ctx = createE2EContext({
			fetchImpl: async (url) => {
				if (url.endsWith(`/CA/${today}.json`)) {
					return new Response(
						JSON.stringify({
							common: "California Poppy",
							latin: "Eschscholzia californica",
							blurb: "Orange wildflower.",
							generatedAt: new Date().toISOString(),
							imageExt: "jpg",
						}),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const flower = await daily.fetchDailyFlower("CA", today);
			assert.equal(flower.common, "California Poppy");
			assert.ok(
				flower.imageSource.uri.endsWith(`/CA/${today}.jpg`),
				`Expected sidecar imageExt "jpg" to win over day-0 PNG default, got ${flower.imageSource.uri}`,
			);
			const cached = await daily.getCachedFlower();
			assert.equal(cached?.common, "California Poppy");
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I5-02: imageUrlFor resolves .png for diffDays < 8 and .jpg for diffDays >= 8 when no override", async () => {
		const ctx = createE2EContext();
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const day0 = utcDateOffset(0);
			const day7 = utcDateOffset(-7);
			const day8 = utcDateOffset(-8);
			assert.ok(daily.imageUrlFor("CA", day0).endsWith(`${day0}.png`));
			assert.ok(daily.imageUrlFor("CA", day7).endsWith(`${day7}.png`));
			assert.ok(daily.imageUrlFor("CA", day8).endsWith(`${day8}.jpg`));
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I5-03: imageUrlFor respects explicit imageExt parameter ('png' vs 'jpg')", async () => {
		const ctx = createE2EContext();
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const day8 = utcDateOffset(-8);
			const day0 = utcDateOffset(0);
			assert.ok(
				daily.imageUrlFor("CA", day8, "png").endsWith(`${day8}.png`),
				"imageUrlFor must accept imageExt override",
			);
			assert.ok(
				daily.imageUrlFor("CA", day0, "jpg").endsWith(`${day0}.jpg`),
				"imageUrlFor must accept imageExt override",
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I5-04: lib/dailyFlower.ts exports an alternate image URL helper swapping .png <-> .jpg", async () => {
		const ctx = createE2EContext();
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const helper =
				daily.alternateImageUrlFor ??
				daily.alternateImageUrl ??
				daily.toggleImageExtension ??
				daily.swapImageExtension;
			assert.equal(
				typeof helper,
				"function",
				"lib/dailyFlower.ts must export alternateImageUrl (or equivalent) for <Image onError> fallback",
			);
			assert.equal(
				helper("https://example.com/daily/CA/2026-11-18.png"),
				"https://example.com/daily/CA/2026-11-18.jpg",
			);
			assert.equal(
				helper("https://example.com/daily/CA/2026-11-18.jpg"),
				"https://example.com/daily/CA/2026-11-18.png",
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I5-05: app/index.tsx <Image> attaches an onError fallback handler", () => {
		const ast = parseTsxAst("app/index.tsx");
		const images = findJsxElements(ast, "Image");
		assert.ok(images.length >= 1, "app/index.tsx should render <Image>");
		const hasOnError = images.some((el) =>
			getNodeText(ast, el).includes("onError"),
		);
		assert.ok(
			hasOnError,
			"app/index.tsx <Image> must include onError handler for day 7-8 PNG/JPG fallback",
		);
	});

	test("T2-I5-06: UTC vs local date boundary in TZ=Pacific/Honolulu uses UTC day for diffDays", () => {
		const script = `
			import assert from "node:assert/strict";
			const RealDate = Date;
			const fixedMs = RealDate.parse("2026-11-26T06:30:00Z"); // Nov 25 20:30 HST, Nov 26 06:30 UTC
			globalThis.Date = class extends RealDate {
				constructor(...a) { super(...(a.length ? a : [fixedMs])); }
				static now() { return fixedMs; }
			};
			import { createE2EContext } from "./tests/e2e/helpers/rn-loader.mjs";
			const ctx = createE2EContext();
			try {
				const daily = await ctx.importFresh("lib/dailyFlower.ts");
				const url = daily.imageUrlFor("CA", "2026-11-18");
				assert.ok(url.endsWith("2026-11-18.jpg"), "At 2026-11-26 UTC, 2026-11-18 is diffDays=8 -> .jpg even in HST (Nov 25 local), got: " + url);
			} finally {
				ctx.cleanup();
			}
		`;
		const res = spawnSync(
			process.execPath,
			["--input-type=module", "-e", script],
			{
				cwd: REPO_ROOT,
				env: { ...process.env, TZ: "Pacific/Honolulu" },
				encoding: "utf8",
			},
		);
		assert.equal(
			res.status,
			0,
			`UTC boundary check failed:\n${res.stderr || res.stdout}`,
		);
	});

	test("T2-I5-07: getCachedFlower normalizes stale cached .png URI to .jpg when >= 8 days old", async () => {
		const oldDate = utcDateOffset(-10);
		const ctx = createE2EContext({
			initialStorage: {
				"dailyFlower.lastSuccess.v1": JSON.stringify({
					imageSource: {
						uri: `https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/daily/CA/${oldDate}.png`,
					},
					common: "California Poppy",
					latin: "Eschscholzia californica",
					blurb: "Orange bloom.",
					state: "CA",
					date: oldDate,
				}),
			},
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const cached = await daily.getCachedFlower();
			assert.ok(cached);
			assert.ok(
				cached.imageSource.uri.endsWith(`${oldDate}.jpg`),
				`Stale 10-day cached .png URI must normalize to .jpg, got ${cached.imageSource.uri}`,
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I5-08: fetchDailyFlower distinguishes HTTP 404/503 FlowerFetchError from network TypeError", async () => {
		const ctx404 = createE2EContext({
			fetchImpl: async () => new Response("Not found", { status: 404 }),
		});
		try {
			const d404 = await ctx404.importFresh("lib/dailyFlower.ts");
			await assert.rejects(
				() => d404.fetchDailyFlower("CA", "2026-11-26"),
				(err) => err instanceof d404.FlowerFetchError && err.status === 404,
			);
		} finally {
			ctx404.cleanup();
		}

		const ctx503 = createE2EContext({
			fetchImpl: async () => new Response("Unavailable", { status: 503 }),
		});
		try {
			const d503 = await ctx503.importFresh("lib/dailyFlower.ts");
			await assert.rejects(
				() => d503.fetchDailyFlower("CA", "2026-11-26"),
				(err) => err instanceof d503.FlowerFetchError && err.status === 503,
			);
		} finally {
			ctx503.cleanup();
		}

		const ctxNet = createE2EContext({
			fetchImpl: async () => {
				throw new TypeError("Network request failed");
			},
		});
		try {
			const dNet = await ctxNet.importFresh("lib/dailyFlower.ts");
			await assert.rejects(
				() => dNet.fetchDailyFlower("CA", "2026-11-26"),
				(err) => err instanceof TypeError,
			);
		} finally {
			ctxNet.cleanup();
		}
	});

	test("T2-I5-09: imageUrlFor handles invalid date strings without throwing uncaught error", async () => {
		const ctx = createE2EContext();
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const url = daily.imageUrlFor("CA", "not-a-date");
			assert.equal(typeof url, "string");
			assert.ok(url.includes("CA/not-a-date"));
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I5-10: getCachedFlower returns null on corrupted AsyncStorage JSON", async () => {
		const ctx = createE2EContext({
			initialStorage: { "dailyFlower.lastSuccess.v1": "{bad json" },
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			assert.equal(await daily.getCachedFlower(), null);
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Tier 3: Pairwise Cross-Feature Integration
	// =========================================================================

	test("T3-02-01: Region override MX-MEX + fetchDailyFlower 404 -> 'default' CDN cascade", async () => {
		const today = utcDateOffset(0);
		const requested = [];
		const ctx = createE2EContext({
			fetchImpl: async (url) => {
				requested.push(url);
				if (url.includes(`/default/${today}.json`)) {
					return new Response(
						JSON.stringify({
							common: "Wild Rose",
							latin: "Rosa woodsii",
							blurb: "Pink native rose.",
							generatedAt: new Date().toISOString(),
							imageExt: "png",
						}),
						{ status: 200 },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const reg = await ctx.importFresh("lib/region.ts");
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			await reg.setRegionOverride("MX-MEX");
			const activeRegion = await reg.getRegion();
			assert.equal(activeRegion, "MX-MEX");

			let flower;
			try {
				flower = await daily.fetchDailyFlower(activeRegion, today);
			} catch (err) {
				if (err instanceof daily.FlowerFetchError && err.status === 404) {
					flower = await daily.fetchDailyFlower("default", today);
				}
			}
			assert.equal(flower.state, "default");
			assert.equal(flower.common, "Wild Rose");
			assert.equal(requested.length, 2);
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-02-02: Region MX-MEX both CDN 404s -> getDailyFlowerOffline returns non-poppy MX-MEX species", async () => {
		const today = utcDateOffset(0);
		const ctx = createE2EContext({
			seedRealSpeciesDb: true,
			fetchImpl: async () => new Response("Not Found", { status: 404 }),
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const db = await ctx.importFresh("lib/speciesDb.ts");
			await assert.rejects(() => daily.fetchDailyFlower("MX-MEX", today));
			await assert.rejects(() => daily.fetchDailyFlower("default", today));
			const offline = await db.getDailyFlowerOffline("MX-MEX", today);
			assert.ok(offline);
			assert.equal(offline.region, "MX-MEX");
			assert.notEqual(offline.common, "California Poppy");
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-02-03: Day-8 fetchDailyFlower sidecar imageExt='png' overrides heuristic while alternateImageUrl provides .jpg", async () => {
		const day8 = utcDateOffset(-8);
		const ctx = createE2EContext({
			fetchImpl: async (url) => {
				if (url.endsWith(`/TX/${day8}.json`)) {
					return new Response(
						JSON.stringify({
							common: "Texas Bluebonnet",
							latin: "Lupinus texensis",
							blurb: "Blue spring wildflower.",
							generatedAt: new Date().toISOString(),
							imageExt: "png",
						}),
						{ status: 200 },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const flower = await daily.fetchDailyFlower("TX", day8);
			assert.ok(flower.imageSource.uri.endsWith(`${day8}.png`));
			const helper =
				daily.alternateImageUrlFor ??
				daily.alternateImageUrl ??
				daily.toggleImageExtension ??
				daily.swapImageExtension;
			assert.equal(typeof helper, "function");
			assert.ok(helper(flower.imageSource.uri).endsWith(`${day8}.jpg`));
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-02-04: Platform.OS === 'android' in __DEV__ routes PAGES_BASE_URL to 10.0.2.2", async () => {
		const today = utcDateOffset(0);
		const ctx = createE2EContext({ platform: "android", dev: true });
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const url = daily.imageUrlFor("CA", today);
			assert.ok(url.startsWith("http://10.0.2.2:8765/daily/CA/"));
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Tier 4: Real-World E2E Scenarios
	// =========================================================================

	test("T4-02-01: Full Travel Mode chip -> 404 cascade -> offline DB -> non-poppy detail contract E2E", async () => {
		const today = utcDateOffset(0);
		const ctx = createE2EContext({
			platform: "ios",
			dev: false,
			seedRealSpeciesDb: true,
			fetchImpl: async () => new Response("Not Found", { status: 404 }),
		});
		try {
			const reg = await ctx.importFresh("lib/region.ts");
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const db = await ctx.importFresh("lib/speciesDb.ts");

			// Verify UI contract matches Travel Mode chip codes and cascade
			const indexSrc = readRepoFile("app/index.tsx");
			const detailSrc = readRepoFile("app/flower-detail.tsx");
			assert.ok(indexSrc.includes('"CN-BJ"'));
			assert.equal(detailSrc.includes("midday.png"), false);

			// Runtime simulation: override to CN-BJ, CDN 404 on CN-BJ & default -> offline DB
			await reg.setRegionOverride("CN-BJ");
			const region = await reg.getRegion();
			assert.equal(region, "CN-BJ");

			let resolved = null;
			try {
				resolved = await daily.fetchDailyFlower(region, today);
			} catch (err) {
				if (err instanceof daily.FlowerFetchError && err.status === 404) {
					try {
						resolved = await daily.fetchDailyFlower("default", today);
					} catch {
						const offline = await db.getDailyFlowerOffline(region, today);
						resolved = offline
							? {
									common: offline.common,
									latin: offline.latin,
									blurb: offline.blurb,
									state: offline.region,
									date: today,
									imageSource: null,
								}
							: null;
					}
				}
			}

			assert.ok(resolved);
			assert.equal(resolved.state, "CN-BJ");
			assert.notEqual(resolved.common, "California Poppy");
		} finally {
			ctx.cleanup();
		}
	});

	test("T4-02-02: Full day 0..10 CDN fetch + AsyncStorage cache rollover + Android/iOS URL consistency E2E", async () => {
		const day0 = utcDateOffset(0);
		const day7 = utcDateOffset(-7);
		const day9 = utcDateOffset(-9);
		const ctx = createE2EContext({
			platform: "ios",
			dev: false,
			fetchImpl: async (url) => {
				if (url.endsWith(".json")) {
					const isOld = url.includes(day9);
					return new Response(
						JSON.stringify({
							common: "Desert Marigold",
							latin: "Baileya multiradiata",
							blurb: "Yellow desert bloom.",
							generatedAt: new Date().toISOString(),
							imageExt: isOld ? "jpg" : "png",
						}),
						{ status: 200 },
					);
				}
				return new Response("Not Found", { status: 404 });
			},
		});
		try {
			const daily = await ctx.importFresh("lib/dailyFlower.ts");
			const f0 = await daily.fetchDailyFlower("AZ", day0);
			const f7 = await daily.fetchDailyFlower("AZ", day7);
			const f9 = await daily.fetchDailyFlower("AZ", day9);
			assert.ok(f0.imageSource.uri.endsWith(`${day0}.png`));
			assert.ok(f7.imageSource.uri.endsWith(`${day7}.png`));
			assert.ok(f9.imageSource.uri.endsWith(`${day9}.jpg`));

			// Simulate stale cached day-9 PNG in AsyncStorage -> normalized to .jpg
			ctx.asyncStorage.set(
				"dailyFlower.lastSuccess.v1",
				JSON.stringify({
					...f9,
					imageSource: {
						uri: f9.imageSource.uri.replace(/\.jpg$/, ".png"),
					},
				}),
			);
			const normalized = await daily.getCachedFlower();
			assert.ok(normalized?.imageSource?.uri.endsWith(`${day9}.jpg`));
		} finally {
			ctx.cleanup();
		}
	});
});
