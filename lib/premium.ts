import AsyncStorage from "@react-native-async-storage/async-storage";
import { todayLocalIso } from "./dailyFlower";
import {
	checkPremiumStatus,
	checkPremiumStatusWithVerification,
	type PremiumStatusVerification,
} from "./purchases";

const SEARCH_COUNT_KEY = "specimen_sandbox_search_count";
const LAST_SEARCH_DATE_KEY = "specimen_sandbox_last_search_date";

export const FREE_SEARCH_LIMIT = 3;

let quotaQueue: Promise<unknown> = Promise.resolve();

function withQuotaLock<T>(operation: () => Promise<T>): Promise<T> {
	const next = quotaQueue.then(operation, operation);
	quotaQueue = next.then(
		() => undefined,
		() => undefined,
	);
	return next;
}

function parseCount(raw: string | null): number {
	if (!raw) return 0;
	const parsed = Number.parseInt(raw, 10);
	return Number.isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

export async function isPremiumUser(): Promise<boolean> {
	return checkPremiumStatus();
}

export async function isPremiumUserWithVerification(): Promise<PremiumStatusVerification> {
	return checkPremiumStatusWithVerification();
}

export async function getSearchQuotaRemaining(): Promise<number> {
	return withQuotaLock(async () => {
		try {
			const today = todayLocalIso();
			const lastSearchDate = await AsyncStorage.getItem(LAST_SEARCH_DATE_KEY);

			if (lastSearchDate !== today) {
				// New day, reset count
				await AsyncStorage.setItem(SEARCH_COUNT_KEY, "0");
				await AsyncStorage.setItem(LAST_SEARCH_DATE_KEY, today);
				return FREE_SEARCH_LIMIT;
			}

			const countStr = await AsyncStorage.getItem(SEARCH_COUNT_KEY);
			const count = parseCount(countStr);
			return Math.max(0, FREE_SEARCH_LIMIT - count);
		} catch (e) {
			console.error("Failed to get search quota:", e);
			return 0;
		}
	});
}

export async function incrementSearchQuotaUsed(): Promise<number> {
	return withQuotaLock(async () => {
		try {
			const today = todayLocalIso();
			const lastSearchDate = await AsyncStorage.getItem(LAST_SEARCH_DATE_KEY);
			const count =
				lastSearchDate === today
					? parseCount(await AsyncStorage.getItem(SEARCH_COUNT_KEY))
					: 0;
			const newCount = count + 1;

			await AsyncStorage.setItem(LAST_SEARCH_DATE_KEY, today);
			await AsyncStorage.setItem(SEARCH_COUNT_KEY, String(newCount));
			return Math.max(0, FREE_SEARCH_LIMIT - newCount);
		} catch (e) {
			console.error("Failed to increment search count:", e);
			return 0;
		}
	});
}
