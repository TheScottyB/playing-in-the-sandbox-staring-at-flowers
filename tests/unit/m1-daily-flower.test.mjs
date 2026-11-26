import "./helpers/m1-rn-loader.mjs";
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

const dailyFlower = await import("../../lib/dailyFlower.ts");

describe("lib/dailyFlower.ts PNG/JPG boundary, sidecar ext & cache normalization", () => {
	beforeEach(() => {
		globalThis.__mockAsyncStorage.clear();
		mock.timers.reset();
	});

	it("formats bloom months cleanly", () => {
		assert.equal(dailyFlower.formatBloomMonths([1, 2, 12]), "JAN · FEB · DEC");
		assert.equal(dailyFlower.formatBloomMonths([]), "");
		assert.equal(dailyFlower.formatBloomMonths(undefined), "");
		assert.equal(dailyFlower.formatBloomMonths([0, 3, 13]), "MAR");
	});

	it("computes alternateImageUrlFor between .png and .jpg", () => {
		assert.equal(
			dailyFlower.alternateImageUrlFor(
				"https://example.com/daily/CA/2026-11-18.png",
			),
			"https://example.com/daily/CA/2026-11-18.jpg",
		);
		assert.equal(
			dailyFlower.alternateImageUrlFor(
				"https://example.com/daily/CA/2026-11-18.jpg?v=2",
			),
			"https://example.com/daily/CA/2026-11-18.png?v=2",
		);
		assert.equal(
			dailyFlower.alternateImageUrlFor("https://example.com/daily/CA/2026"),
			null,
		);
	});

	it("prefers explicit sidecar ext and uses UTC day 7-8 boundary when omitted", () => {
		mock.timers.enable({
			apis: ["Date"],
			now: new Date("2026-11-26T02:00:00Z"),
		});

		assert.equal(dailyFlower.todayUtcIso(), "2026-11-26");

		// Day 7 (2026-11-19): diffDays = 7 -> .png
		assert.match(
			dailyFlower.imageUrlFor("CA", "2026-11-19"),
			/\/CA\/2026-11-19\.png$/,
		);
		// Day 8 (2026-11-18): diffDays = 8 -> .jpg
		assert.match(
			dailyFlower.imageUrlFor("CA", "2026-11-18"),
			/\/CA\/2026-11-18\.jpg$/,
		);
		// Explicit sidecar ext overrides age heuristic
		assert.match(
			dailyFlower.imageUrlFor("CA", "2026-11-18", "png"),
			/\/CA\/2026-11-18\.png$/,
		);
		assert.match(
			dailyFlower.imageUrlFor("CA", "2026-11-26", "jpg"),
			/\/CA\/2026-11-26\.jpg$/,
		);
	});

	it("uses sidecar imageExt in fetchDailyFlower and throws FlowerFetchError on 404", async () => {
		const origFetch = globalThis.fetch;
		globalThis.fetch = async (url) => {
			if (String(url).includes("/MX-MEX/")) {
				return { ok: false, status: 404 };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					common: "Desert Marigold",
					latin: "Baileya multiradiata",
					blurb: "Bright yellow desert bloom.",
					generatedAt: "2026-11-18T11:00:00Z",
					imageExt: "jpg",
				}),
			};
		};

		try {
			const flower = await dailyFlower.fetchDailyFlower("AZ", "2026-11-25");
			assert.equal(typeof flower.imageSource, "object");
			assert.match(flower.imageSource.uri, /\/AZ\/2026-11-25\.jpg$/);

			await assert.rejects(
				() => dailyFlower.fetchDailyFlower("MX-MEX", "2026-11-25"),
				(err) =>
					err instanceof dailyFlower.FlowerFetchError && err.status === 404,
			);
		} finally {
			globalThis.fetch = origFetch;
		}
	});

	it("normalizes stale cached .png URIs older than 7 days to .jpg in getCachedFlower", async () => {
		mock.timers.enable({
			apis: ["Date"],
			now: new Date("2026-11-26T12:00:00Z"),
		});

		globalThis.__mockAsyncStorage.set(
			"dailyFlower.lastSuccess.v1",
			JSON.stringify({
				imageSource: {
					uri: "https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/daily/CA/2026-11-18.png",
				},
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Test",
				state: "CA",
				date: "2026-11-18",
			}),
		);

		const normalized = await dailyFlower.getCachedFlower();
		assert.ok(normalized);
		assert.match(normalized.imageSource.uri, /\/CA\/2026-11-18\.jpg$/);

		// Recent (< 8 days) cached .png remains .png
		globalThis.__mockAsyncStorage.set(
			"dailyFlower.lastSuccess.v1",
			JSON.stringify({
				imageSource: {
					uri: "https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/daily/CA/2026-11-24.png",
				},
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Test",
				state: "CA",
				date: "2026-11-24",
			}),
		);

		const recent = await dailyFlower.getCachedFlower();
		assert.ok(recent);
		assert.match(recent.imageSource.uri, /\/CA\/2026-11-24\.png$/);
	});

	it("normalizes uppercase .PNG and query-string .png?v=1 URIs in getCachedFlower", async () => {
		mock.timers.enable({
			apis: ["Date"],
			now: new Date("2026-11-26T12:00:00Z"),
		});

		// Day 8 uppercase .PNG
		globalThis.__mockAsyncStorage.set(
			"dailyFlower.lastSuccess.v1",
			JSON.stringify({
				imageSource: {
					uri: "https://cdn.example/daily/CA/2026-11-18.PNG",
				},
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Test",
				state: "CA",
				date: "2026-11-18",
			}),
		);
		const upperOld = await dailyFlower.getCachedFlower();
		assert.ok(upperOld);
		assert.equal(
			upperOld.imageSource.uri,
			"https://cdn.example/daily/CA/2026-11-18.jpg",
		);

		// Day 8 .png?v=1 preserves query string and host
		globalThis.__mockAsyncStorage.set(
			"dailyFlower.lastSuccess.v1",
			JSON.stringify({
				imageSource: {
					uri: "https://cdn.example/daily/CA/2026-11-18.png?v=1",
				},
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Test",
				state: "CA",
				date: "2026-11-18",
			}),
		);
		const queryOld = await dailyFlower.getCachedFlower();
		assert.ok(queryOld);
		assert.equal(
			queryOld.imageSource.uri,
			"https://cdn.example/daily/CA/2026-11-18.jpg?v=1",
		);

		// Recent (< 8 days) .PNG?v=2 stays unchanged
		globalThis.__mockAsyncStorage.set(
			"dailyFlower.lastSuccess.v1",
			JSON.stringify({
				imageSource: {
					uri: "https://cdn.example/daily/CA/2026-11-24.PNG?v=2",
				},
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Test",
				state: "CA",
				date: "2026-11-24",
			}),
		);
		const recentUpperQuery = await dailyFlower.getCachedFlower();
		assert.ok(recentUpperQuery);
		assert.equal(
			recentUpperQuery.imageSource.uri,
			"https://cdn.example/daily/CA/2026-11-24.PNG?v=2",
		);
	});

	it("prevents cross-region cache bleed when expectedRegion is specified while staying backwards-compatible", async () => {
		globalThis.__mockAsyncStorage.set(
			"dailyFlower.lastSuccess.v1",
			JSON.stringify({
				imageSource: {
					uri: "https://cdn.example/daily/CA/2026-11-25.png",
				},
				common: "California Poppy",
				latin: "Eschscholzia californica",
				blurb: "Test",
				state: "CA",
				date: "2026-11-25",
			}),
		);

		assert.equal(await dailyFlower.getCachedFlower("MX-MEX"), null);
		assert.equal(await dailyFlower.getCachedFlower("default"), null);

		const matching = await dailyFlower.getCachedFlower("CA");
		assert.ok(matching);
		assert.equal(matching.state, "CA");

		const unguarded = await dailyFlower.getCachedFlower();
		assert.ok(unguarded);
		assert.equal(unguarded.state, "CA");
	});
});
