import "./helpers/m1-rn-loader.mjs";
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

const dailyFlower = await import("../../lib/dailyFlower.ts");

const manifest = {
	generatedAt: "2026-11-26T00:00:00Z",
	regions: {
		IL: [
			["2026-08-24", "jpg", "Echinacea purpurea"],
			["2026-08-25", "jpg", "Monarda fistulosa"],
			["2026-11-02", "jpg", "Solidago canadensis"],
			["2026-11-03", "png", "Aster novae-angliae"],
		],
		default: [["2026-05-23", "jpg", "Eschscholzia californica"]],
	},
};

describe("archive fallback (App Review 2.1: always show a real photo)", () => {
	const realFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("returns the exact date when it is in the archive", () => {
		const pick = dailyFlower.pickArchiveEntry("IL", "2026-08-25", manifest);
		assert.deepEqual(pick, { region: "IL", entry: manifest.regions.IL[1] });
	});

	it("is deterministic per day, varies across days, prefers same month", () => {
		const a = dailyFlower.pickArchiveEntry("IL", "2026-11-26", manifest);
		const b = dailyFlower.pickArchiveEntry("IL", "2026-11-26", manifest);
		const c = dailyFlower.pickArchiveEntry("IL", "2026-11-27", manifest);
		assert.deepEqual(a, b);
		assert.notDeepEqual(a.entry, c.entry);
		assert.equal(a.entry[0].slice(5, 7), "11");
		assert.equal(c.entry[0].slice(5, 7), "11");
	});

	it("falls back to the default region for an uncovered region", () => {
		const pick = dailyFlower.pickArchiveEntry("ZZ", "2026-11-26", manifest);
		assert.equal(pick.region, "default");
	});

	it("returns null when nothing is archived at all", () => {
		assert.equal(
			dailyFlower.pickArchiveEntry("IL", "2026-11-26", { regions: {} }),
			null,
		);
	});

	it("bundled snapshot covers every region with a real photo", () => {
		for (const region of ["IL", "CA", "default"]) {
			const pick = dailyFlower.pickArchiveEntry(region, "2026-11-26");
			assert.ok(pick, `no archive for ${region}`);
			assert.match(pick.entry[1], /^(jpg|png)$/);
		}
	});

	it("fetchArchiveFlower keeps the requested date and records archivedFrom", async () => {
		globalThis.fetch = async (url) => {
			if (String(url).endsWith("/manifest.json")) {
				return { ok: false, status: 404, json: async () => ({}) };
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({
					common: "Wild Bergamot",
					latin: "Monarda fistulosa",
					blurb: "x",
					generatedAt: "2026-08-25T00:00:00Z",
				}),
			};
		};
		const flower = await dailyFlower.fetchArchiveFlower("IL", "2026-11-26");
		assert.ok(flower);
		assert.equal(flower.date, "2026-11-26");
		assert.equal(flower.state, "IL");
		assert.match(flower.archivedFrom, /^\d{4}-\d{2}-\d{2}$/);
		assert.match(flower.imageSource.uri, /\/IL\/\d{4}-\d{2}-\d{2}\.(jpg|png)$/);
		assert.equal(flower.isPlaceholder, undefined);
	});

	it("finds an archive photo for a searchable species", () => {
		const uri = dailyFlower.archivePhotoForLatin("Monarda fistulosa");
		assert.match(uri, /\.(jpg|png)$/);
		assert.equal(dailyFlower.archivePhotoForLatin("Nonexistent plantus"), null);
	});
});
