/**
 * The provider interface the app talks to. Today this resolves to a static
 * GitHub Pages URL; tomorrow it can be swapped for a Cloudflare Worker
 * (on-demand generation) or on-device generation without changing callers.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { type ImageSourcePropType, Platform } from "react-native";

import { DEFAULT_FLOWER, pickVariant, type TimeOfDay } from "@/data/defaults";

const PAGES_BASE_URL = __DEV__
	? `http://${Platform.OS === "android" ? "10.0.2.2" : "localhost"}:8765/daily`
	: "https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/daily";

const CACHE_KEY = "dailyFlower.lastSuccess.v1";

export interface DailyFlower {
	/** Accepts both `{ uri }` and `require(...)` so a single field covers
	 *  remote and bundled images. */
	imageSource: ImageSourcePropType;
	common: string;
	latin: string;
	blurb: string;
	state: string;
	date: string;
	/** Set when this entry came from the bundled fallback, not the CDN. */
	isDefault?: boolean;
	/** Only present for fallback entries. */
	timeOfDay?: TimeOfDay;
}

export interface DailyFlowerSidecar {
	common: string;
	latin: string;
	blurb: string;
	generatedAt: string;
}

/** Tagged error so callers can distinguish 404 ("coming soon") from 5xx
 *  ("service trouble") without parsing strings. Network failures (offline,
 *  DNS, etc.) surface as the original TypeError from fetch and don't reach
 *  this class. */
export class FlowerFetchError extends Error {
	readonly status: number;
	constructor(state: string, date: string, status: number) {
		super(`No flower for ${state} on ${date} (HTTP ${status})`);
		this.name = "FlowerFetchError";
		this.status = status;
	}
}

export function todayLocalIso(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, "0");
	const dd = String(now.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

export function imageUrlFor(
	state: string,
	date: string = todayLocalIso(),
): string {
	try {
		const today = new Date(`${todayLocalIso()}T12:00:00`);
		const target = new Date(`${date}T12:00:00`);
		const diffTime = today.getTime() - target.getTime();
		const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

		// Within 7 days buffer serve the PNG; 8th day and older serve the JPG
		const ext = diffDays < 8 ? "png" : "jpg";
		return `${PAGES_BASE_URL}/${state}/${date}.${ext}`;
	} catch {
		return `${PAGES_BASE_URL}/${state}/${date}.jpg`;
	}
}

function sidecarUrlFor(state: string, date: string = todayLocalIso()): string {
	return `${PAGES_BASE_URL}/${state}/${date}.json`;
}

export async function fetchDailyFlower(
	state: string,
	date: string = todayLocalIso(),
): Promise<DailyFlower> {
	const sidecar = await fetch(sidecarUrlFor(state, date));
	if (!sidecar.ok) {
		throw new FlowerFetchError(state, date, sidecar.status);
	}
	const meta = (await sidecar.json()) as DailyFlowerSidecar;
	const flower: DailyFlower = {
		imageSource: { uri: imageUrlFor(state, date) },
		common: meta.common,
		latin: meta.latin,
		blurb: meta.blurb,
		state,
		date,
	};
	// Best-effort cache for offline fallback — storage failures must not break the success path.
	AsyncStorage.setItem(CACHE_KEY, JSON.stringify(flower)).catch((e) => {
		console.warn("Failed to cache flower for offline use:", e);
	});
	return flower;
}

/**
 * Returns the last successfully fetched CDN flower, or null if none cached.
 * Used as a graceful step between a CDN failure and `getDefaultFlower()`.
 */
export async function getCachedFlower(): Promise<DailyFlower | null> {
	try {
		const raw = await AsyncStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as DailyFlower;
	} catch (e) {
		console.warn("Failed to read cached flower:", e);
		return null;
	}
}

/**
 * Returns a bundled fallback flower whose variant matches the local hour.
 * Used when the CDN is unreachable or hasn't published yet.
 */
export function getDefaultFlower(date: string = todayLocalIso()): DailyFlower {
	const variant = pickVariant();
	return {
		imageSource: variant.image,
		common: DEFAULT_FLOWER.common,
		latin: DEFAULT_FLOWER.latin,
		blurb: DEFAULT_FLOWER.blurb,
		state: "default",
		date,
		isDefault: true,
		timeOfDay: variant.time,
	};
}
