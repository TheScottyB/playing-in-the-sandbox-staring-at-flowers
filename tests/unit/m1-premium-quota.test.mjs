import "./helpers/m1-rn-loader.mjs";
import assert from "node:assert/strict";
import { beforeEach, describe, it, mock } from "node:test";

const { default: AsyncStorage } = await import(
	"@react-native-async-storage/async-storage"
);
const premium = await import("../../lib/premium.ts");

function todayLocalIso() {
	const today = new Date();
	const yyyy = today.getFullYear();
	const mm = String(today.getMonth() + 1).padStart(2, "0");
	const dd = String(today.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

const SEARCH_COUNT_KEY = "specimen_sandbox_search_count";
const LAST_SEARCH_DATE_KEY = "specimen_sandbox_last_search_date";

describe("lib/premium.ts search quota & cleanup", () => {
	beforeEach(() => {
		globalThis.__mockAsyncStorage.clear();
		mock.timers.reset();
	});

	it("does not export setPremiumStatus", () => {
		assert.equal("setPremiumStatus" in premium, false);
		assert.equal(premium.FREE_SEARCH_LIMIT, 3);
	});

	it("starts with full quota and decrements down to 0", async () => {
		assert.equal(await premium.getSearchQuotaRemaining(), 3);
		assert.equal(await premium.incrementSearchQuotaUsed(), 2);
		assert.equal(await premium.incrementSearchQuotaUsed(), 1);
		assert.equal(await premium.incrementSearchQuotaUsed(), 0);
		assert.equal(await premium.incrementSearchQuotaUsed(), 0);
		assert.equal(await premium.getSearchQuotaRemaining(), 0);
	});

	it("recovers safely from corrupted or negative search counts", async () => {
		const today = new Date();
		const yyyy = today.getFullYear();
		const mm = String(today.getMonth() + 1).padStart(2, "0");
		const dd = String(today.getDate()).padStart(2, "0");
		const todayIso = `${yyyy}-${mm}-${dd}`;

		globalThis.__mockAsyncStorage.set(LAST_SEARCH_DATE_KEY, todayIso);
		globalThis.__mockAsyncStorage.set(SEARCH_COUNT_KEY, "not-a-number");
		assert.equal(await premium.getSearchQuotaRemaining(), 3);

		globalThis.__mockAsyncStorage.set(SEARCH_COUNT_KEY, "-5");
		assert.equal(await premium.getSearchQuotaRemaining(), 3);
		assert.equal(await premium.incrementSearchQuotaUsed(), 2);
	});

	it("resets quota across midnight when incrementSearchQuotaUsed runs before getSearchQuotaRemaining", async () => {
		mock.timers.enable({
			apis: ["Date"],
			now: new Date(2026, 10, 26, 23, 59, 55, 0),
		});

		assert.equal(await premium.incrementSearchQuotaUsed(), 2);
		assert.equal(await premium.incrementSearchQuotaUsed(), 1);
		assert.equal(await premium.incrementSearchQuotaUsed(), 0);
		assert.equal(await premium.getSearchQuotaRemaining(), 0);

		// Cross local midnight to 2026-11-27 00:00:05
		mock.timers.tick(10_000);

		// Calling incrementSearchQuotaUsed directly after midnight must start from 0 -> remaining 2
		assert.equal(await premium.incrementSearchQuotaUsed(), 2);
		assert.equal(await premium.getSearchQuotaRemaining(), 2);
	});

	it("resets quota across midnight when getSearchQuotaRemaining runs first", async () => {
		mock.timers.enable({
			apis: ["Date"],
			now: new Date(2026, 10, 26, 23, 59, 55, 0),
		});

		await premium.incrementSearchQuotaUsed();
		await premium.incrementSearchQuotaUsed();
		await premium.incrementSearchQuotaUsed();
		assert.equal(await premium.getSearchQuotaRemaining(), 0);

		mock.timers.tick(10_000);

		assert.equal(await premium.getSearchQuotaRemaining(), 3);
	});

	it("serializes concurrent incrementSearchQuotaUsed() calls from 0 without losing updates", async () => {
		globalThis.__mockAsyncStorage.set(LAST_SEARCH_DATE_KEY, todayLocalIso());
		globalThis.__mockAsyncStorage.set(SEARCH_COUNT_KEY, "0");

		const origGet = AsyncStorage.getItem;
		const origSet = AsyncStorage.setItem;
		AsyncStorage.getItem = async (key) => {
			await new Promise((r) => setTimeout(r, 10));
			return origGet(key);
		};
		AsyncStorage.setItem = async (key, value) => {
			await new Promise((r) => setTimeout(r, 10));
			return origSet(key, value);
		};

		try {
			const results = await Promise.all([
				premium.incrementSearchQuotaUsed(),
				premium.incrementSearchQuotaUsed(),
				premium.incrementSearchQuotaUsed(),
			]);
			assert.deepEqual(results, [2, 1, 0]);
			assert.equal(globalThis.__mockAsyncStorage.get(SEARCH_COUNT_KEY), "3");
		} finally {
			AsyncStorage.getItem = origGet;
			AsyncStorage.setItem = origSet;
		}
	});

	it("serializes concurrent cross-midnight getSearchQuotaRemaining() and incrementSearchQuotaUsed()", async () => {
		const origGet = AsyncStorage.getItem;
		const origSet = AsyncStorage.setItem;
		AsyncStorage.getItem = async (key) => {
			await new Promise((r) => setTimeout(r, 5));
			return origGet(key);
		};
		AsyncStorage.setItem = async (key, value) => {
			// Stagger writes so an unlocked reset ("0") would overwrite increment ("1")
			const delay = value === "0" ? 25 : 5;
			await new Promise((r) => setTimeout(r, delay));
			return origSet(key, value);
		};

		try {
			// Order 1: getSearchQuotaRemaining() then incrementSearchQuotaUsed() across midnight
			globalThis.__mockAsyncStorage.set(LAST_SEARCH_DATE_KEY, "1999-12-31");
			globalThis.__mockAsyncStorage.set(SEARCH_COUNT_KEY, "3");

			const [remBefore, remAfterInc] = await Promise.all([
				premium.getSearchQuotaRemaining(),
				premium.incrementSearchQuotaUsed(),
			]);
			assert.equal(remBefore, 3);
			assert.equal(remAfterInc, 2);
			assert.equal(globalThis.__mockAsyncStorage.get(SEARCH_COUNT_KEY), "1");
			assert.equal(
				globalThis.__mockAsyncStorage.get(LAST_SEARCH_DATE_KEY),
				todayLocalIso(),
			);

			// Order 2: incrementSearchQuotaUsed() then getSearchQuotaRemaining() across midnight
			globalThis.__mockAsyncStorage.set(LAST_SEARCH_DATE_KEY, "1999-12-31");
			globalThis.__mockAsyncStorage.set(SEARCH_COUNT_KEY, "3");

			const [incRem, remAfterGet] = await Promise.all([
				premium.incrementSearchQuotaUsed(),
				premium.getSearchQuotaRemaining(),
			]);
			assert.equal(incRem, 2);
			assert.equal(remAfterGet, 2);
			assert.equal(globalThis.__mockAsyncStorage.get(SEARCH_COUNT_KEY), "1");
		} finally {
			AsyncStorage.getItem = origGet;
			AsyncStorage.setItem = origSet;
		}
	});

	it("does not poison the quota lock if AsyncStorage throws on one call", async () => {
		const origGet = AsyncStorage.getItem;
		let failOnce = true;
		AsyncStorage.getItem = async (key) => {
			if (failOnce) {
				failOnce = false;
				throw new Error("Simulated AsyncStorage read failure");
			}
			return origGet(key);
		};

		try {
			assert.equal(await premium.incrementSearchQuotaUsed(), 0);
			assert.equal(await premium.getSearchQuotaRemaining(), 3);
			assert.equal(await premium.incrementSearchQuotaUsed(), 2);
		} finally {
			AsyncStorage.getItem = origGet;
		}
	});
});
