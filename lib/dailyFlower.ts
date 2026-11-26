/**
 * The provider interface the app talks to. Today this resolves to a static
 * GitHub Pages URL; tomorrow it can be swapped for a Cloudflare Worker
 * (on-demand generation) or on-device generation without changing callers.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";
import { type ImageSourcePropType, Platform } from "react-native";

import { DEFAULT_FLOWER, pickVariant, type TimeOfDay } from "@/data/defaults";
import bundledArchive from "./data/dailyArchive";

const PAGES_BASE_URL = __DEV__
	? `http://${Platform.OS === "android" ? "10.0.2.2" : "localhost"}:8765/daily`
	: "https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/daily";

const CACHE_KEY = "dailyFlower.lastSuccess.v1";

export interface DailyFlower {
	/** Accepts both `{ uri }` and `require(...)` when a photo is available;
	 *  omitted/null for offline species records that have no cached photo. */
	imageSource?: ImageSourcePropType | null;
	common: string;
	latin: string;
	blurb: string;
	state: string;
	date: string;
	/** Set when this entry came from cache/offline/bundled fallback, not the CDN. */
	isDefault?: boolean;
	/** Set when no photograph exists for this species (renders specimen card). */
	isPlaceholder?: boolean;
	/** Optional bloom months (1-12) for offline/search specimen display. */
	bloomMonths?: number[];
	/** Only present for fallback entries. */
	timeOfDay?: TimeOfDay;
	/** Set when this photo was originally published on another day and is
	 *  being shown from the archive because today's image is unavailable. */
	archivedFrom?: string;
}

export interface DailyFlowerSidecar {
	common: string;
	latin: string;
	blurb: string;
	generatedAt: string;
	imageExt?: "png" | "jpg";
}

const MONTH_SHORT = [
	"JAN",
	"FEB",
	"MAR",
	"APR",
	"MAY",
	"JUN",
	"JUL",
	"AUG",
	"SEP",
	"OCT",
	"NOV",
	"DEC",
];

export function formatBloomMonths(months?: number[]): string {
	if (!Array.isArray(months) || months.length === 0) return "";
	return months
		.filter((m) => Number.isInteger(m) && m >= 1 && m <= 12)
		.map((m) => MONTH_SHORT[m - 1])
		.join(" · ");
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

export function todayUtcIso(): string {
	return new Date().toISOString().slice(0, 10);
}

export function imageUrlFor(
	state: string,
	date: string = todayLocalIso(),
	ext?: "png" | "jpg",
): string {
	if (ext === "png" || ext === "jpg") {
		return `${PAGES_BASE_URL}/${state}/${date}.${ext}`;
	}
	try {
		const today = new Date(`${todayUtcIso()}T12:00:00Z`);
		const target = new Date(`${date}T12:00:00Z`);
		if (Number.isNaN(today.getTime()) || Number.isNaN(target.getTime())) {
			return `${PAGES_BASE_URL}/${state}/${date}.jpg`;
		}
		const diffTime = today.getTime() - target.getTime();
		const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

		// Within 7 days buffer serve the PNG; 8th day and older serve the JPG
		const computedExt = diffDays < 8 ? "png" : "jpg";
		return `${PAGES_BASE_URL}/${state}/${date}.${computedExt}`;
	} catch {
		return `${PAGES_BASE_URL}/${state}/${date}.jpg`;
	}
}

export function alternateImageUrlFor(uri: string): string | null {
	const match = uri.match(/^(.*)\.(png|jpg)(\?.*)?$/i);
	if (!match) return null;
	const [, base, ext, query = ""] = match;
	const nextExt = ext.toLowerCase() === "png" ? "jpg" : "png";
	return `${base}.${nextExt}${query}`;
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
		imageSource: { uri: imageUrlFor(state, date, meta.imageExt) },
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
export async function getCachedFlower(
	expectedRegion?: string,
): Promise<DailyFlower | null> {
	try {
		const raw = await AsyncStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as DailyFlower;
		if (expectedRegion !== undefined && parsed.state !== expectedRegion) {
			return null;
		}
		if (
			parsed.imageSource != null &&
			typeof parsed.imageSource === "object" &&
			"uri" in parsed.imageSource &&
			typeof parsed.imageSource.uri === "string" &&
			parsed.state &&
			parsed.date
		) {
			const normalizedUri = imageUrlFor(parsed.state, parsed.date);
			if (
				/\.png(\?.*)?$/i.test(parsed.imageSource.uri) &&
				normalizedUri.endsWith(".jpg")
			) {
				const rewrittenUri =
					alternateImageUrlFor(parsed.imageSource.uri) ?? normalizedUri;
				return {
					...parsed,
					imageSource: { ...parsed.imageSource, uri: rewrittenUri },
				};
			}
		}
		return parsed;
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

// ---------------------------------------------------------------------------
// Archive fallback
//
// Every flower ever published stays on GitHub Pages. When today's image is
// missing (generation paused, region not yet covered, past days in the
// archive view), we show a real photograph from that archive instead of a
// text-only specimen card. A snapshot of the archive index ships in the
// bundle; the live `daily/manifest.json` replaces it when reachable.
// ---------------------------------------------------------------------------

/** [date, ext, latin] */
export type ArchiveEntry = [string, "jpg" | "png", string];
export interface ArchiveManifest {
	generatedAt: string;
	regions: Record<string, ArchiveEntry[]>;
}

const MANIFEST_URL = `${PAGES_BASE_URL}/manifest.json`;
let archiveManifest: ArchiveManifest = bundledArchive as ArchiveManifest;
let liveManifestPromise: Promise<ArchiveManifest> | null = null;

function isManifest(value: unknown): value is ArchiveManifest {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as ArchiveManifest).regions === "object" &&
		(value as ArchiveManifest).regions !== null
	);
}

/** Bundled snapshot, upgraded once per launch to the live manifest when it
 *  is reachable and at least as complete. Never throws. */
export function loadArchiveManifest(): Promise<ArchiveManifest> {
	if (liveManifestPromise) return liveManifestPromise;
	liveManifestPromise = (async () => {
		try {
			const res = await fetch(MANIFEST_URL);
			if (res.ok) {
				const live = (await res.json()) as unknown;
				if (
					isManifest(live) &&
					Object.keys(live.regions).length >=
						Object.keys(archiveManifest.regions).length
				) {
					archiveManifest = live;
				}
			}
		} catch {
			// Offline or not yet published: the bundled snapshot stands.
		}
		return archiveManifest;
	})();
	return liveManifestPromise;
}

function dayNumber(date: string): number {
	const t = Date.parse(`${date}T12:00:00Z`);
	return Number.isNaN(t) ? 0 : Math.floor(t / 86_400_000);
}

/**
 * Deterministically picks an archived flower for `region` on `date`: the
 * same day always shows the same flower, consecutive days show different
 * ones, and flowers photographed in the same calendar month are preferred
 * so the archive still feels seasonal. Falls back to the `default` region.
 */
export function pickArchiveEntry(
	region: string,
	date: string,
	manifest: ArchiveManifest = archiveManifest,
): { region: string; entry: ArchiveEntry } | null {
	const month = date.slice(5, 7);
	for (const r of region === "default" ? ["default"] : [region, "default"]) {
		const all = manifest.regions[r];
		if (!all || all.length === 0) continue;
		const exact = all.find((e) => e[0] === date);
		if (exact) return { region: r, entry: exact };
		const seasonal = all.filter((e) => e[0].slice(5, 7) === month);
		const pool = seasonal.length > 0 ? seasonal : all;
		const idx = ((dayNumber(date) % pool.length) + pool.length) % pool.length;
		return { region: r, entry: pool[idx] };
	}
	return null;
}

/**
 * Fetches a real archived photograph for `region` on `date`. The returned
 * flower keeps the requested `date` (so day navigation stays consistent)
 * and records the original publish date in `archivedFrom`.
 */
export async function fetchArchiveFlower(
	region: string,
	date: string,
): Promise<DailyFlower | null> {
	const manifest = await loadArchiveManifest();
	const pick = pickArchiveEntry(region, date, manifest);
	if (!pick) return null;
	const [archDate, ext] = pick.entry;
	try {
		const res = await fetch(sidecarUrlFor(pick.region, archDate));
		if (!res.ok) return null;
		const meta = (await res.json()) as DailyFlowerSidecar;
		return {
			imageSource: {
				uri: `${PAGES_BASE_URL}/${pick.region}/${archDate}.${ext}`,
			},
			common: meta.common,
			latin: meta.latin,
			blurb: meta.blurb,
			state: region,
			date,
			archivedFrom: archDate,
		};
	} catch {
		return null;
	}
}

/** Photo URL of the most recent archived image of a species, if any. */
export function archivePhotoForLatin(latin: string): string | null {
	const want = latin.trim().toLowerCase();
	if (!want) return null;
	let best: { region: string; entry: ArchiveEntry } | null = null;
	for (const [region, entries] of Object.entries(archiveManifest.regions)) {
		for (const entry of entries) {
			if (entry[2].trim().toLowerCase() !== want) continue;
			if (!best || entry[0] > best.entry[0]) best = { region, entry };
		}
	}
	return best
		? `${PAGES_BASE_URL}/${best.region}/${best.entry[0]}.${best.entry[1]}`
		: null;
}
