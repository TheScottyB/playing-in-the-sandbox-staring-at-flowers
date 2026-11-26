#!/usr/bin/env node
/**
 * Generates one flower image + sidecar JSON per region bucket for a target date
 * and writes them to docs/daily/{region}/{YYYY-MM-DD}.{png,json}.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/generate-daily.mjs [--date YYYY-MM-DD] [--states AL,TX] [--missing-only] [--us-only] [--warehouse-dir /path]
 *
 * Flags:
 *   --date YYYY-MM-DD     Target date (default: today UTC).
 *   --states AL,TX        Comma-separated region codes (default: every bucket in species.json).
 *   --missing-only        Skip regions that already have both files for the target date.
 *                         Lets backfill runs avoid re-paying for completed regions.
 *   --us-only             Limit generation to US states + DC (default: all 112 regions).
 *   --warehouse-dir PATH  Optional directory to back up retired PNGs (overrides DAILY_WAREHOUSE_DIR).
 *
 * Environment:
 *   GEMINI_API_KEY        Required unless DRY_RUN=1. Google AI Studio key with
 *                         Gemini image generation access (gemini-3.1-flash-image / gemini-3.1-flash-lite-image).
 *   DRY_RUN               Set to "1" to skip actual API calls (writes placeholder files).
 *   DAILY_WAREHOUSE_DIR   Optional directory for backing up retired PNGs on day 9+.
 *
 * Exit codes:
 *   0  Run completed (whether or not every region succeeded). The workflow's
 *      commit step still runs so partial progress is persisted.
 *   1  Hard precondition failure (no API key, missing species.json, etc.).
 */

import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp, JimpMime } from "jimp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS_DIR = join(ROOT, "docs", "daily");
const IMG_EXT = "png"; // Daily images are generated as high-res PNGs
const SPECIES_PATH = join(ROOT, "lib", "data", "species.json");

export const GEMINI_MODELS = [
	"gemini-3.1-flash-image",
	"gemini-3.1-flash-lite-image",
];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Generation scope & performance configuration
const CONCURRENCY = 5; // Number of parallel API requests (safe for billing-enabled keys)

const MONTH_NAMES = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

export const US_STATES = new Set([
	"AL",
	"AK",
	"AZ",
	"AR",
	"CA",
	"CO",
	"CT",
	"DE",
	"FL",
	"GA",
	"HI",
	"ID",
	"IL",
	"IN",
	"IA",
	"KS",
	"KY",
	"LA",
	"ME",
	"MD",
	"MA",
	"MI",
	"MN",
	"MS",
	"MO",
	"MT",
	"NE",
	"NV",
	"NH",
	"NJ",
	"NM",
	"NY",
	"NC",
	"ND",
	"OH",
	"OK",
	"OR",
	"PA",
	"RI",
	"SC",
	"SD",
	"TN",
	"TX",
	"UT",
	"VT",
	"VA",
	"WA",
	"WV",
	"WI",
	"WY",
	"DC",
]);

function defaultSleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function parseCliArgs(argv = process.argv.slice(2)) {
	function argVal(flag) {
		const i = argv.indexOf(flag);
		if (i === -1 || i + 1 >= argv.length) return null;
		const val = argv[i + 1];
		return val && !val.startsWith("--") ? val : null;
	}
	function argFlag(flag) {
		return argv.includes(flag);
	}

	const rawStates = argVal("--states");
	const targetStates = rawStates
		? rawStates
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean)
		: null;

	return {
		targetDate: argVal("--date") ?? todayIso(),
		targetStates: targetStates && targetStates.length > 0 ? targetStates : null,
		missingOnly: argFlag("--missing-only"),
		usOnly: argFlag("--us-only"),
		warehouseDir: argVal("--warehouse-dir"),
	};
}

export function todayIso(now = new Date()) {
	return now.toISOString().slice(0, 10);
}

export function isValidIsoDate(dateStr) {
	if (typeof dateStr !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
		return false;
	}
	const [yearStr, monthStr, dayStr] = dateStr.split("-");
	const year = Number(yearStr);
	const month = Number(monthStr);
	const day = Number(dayStr);
	const parsed = new Date(Date.UTC(year, month - 1, day));
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.getUTCFullYear() === year &&
		parsed.getUTCMonth() === month - 1 &&
		parsed.getUTCDate() === day
	);
}

export function parseRetryAfterMs(headers) {
	const raw = headers?.get?.("Retry-After") ?? headers?.get?.("retry-after");
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) {
		return seconds >= 0 ? Math.round(seconds * 1000) : null;
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		return Math.max(0, dateMs - Date.now());
	}
	return null;
}

export function monthNameForDate(date) {
	if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
		const monthIndex = Number(date.slice(5, 7)) - 1;
		if (monthIndex >= 0 && monthIndex < MONTH_NAMES.length) {
			return MONTH_NAMES[monthIndex];
		}
	}
	return MONTH_NAMES[new Date().getUTCMonth()];
}

/** Deterministic index — same state+date always picks the same species. */
export function pickSpecies(species, state, date) {
	if (!Array.isArray(species) || species.length === 0) {
		throw new Error(`Invalid or empty species list for ${state}`);
	}
	const month = Number(date.slice(5, 7));
	const inSeason = species.filter((s) => s.bloomMonths?.includes(month));
	const pool = inSeason.length > 0 ? inSeason : species;
	const hash = createHash("sha256").update(`${state}:${date}`).digest("hex");
	const idx = Number(BigInt(`0x${hash.slice(0, 8)}`) % BigInt(pool.length));
	return pool[idx];
}

export function getRegionPromptText(state) {
	const countryNames = {
		GTM: "Guatemala",
		BLZ: "Belize",
		SLV: "El Salvador",
		HND: "Honduras",
		NIC: "Nicaragua",
		CRI: "Costa Rica",
		PAN: "Panama",
		COL: "Colombia",
		VEN: "Venezuela",
		GUY: "Guyana",
		SUR: "Suriname",
		ECU: "Ecuador",
		PER: "Peru",
		BOL: "Bolivia",
		PRY: "Paraguay",
		CHL: "Chile",
		URY: "Uruguay",
		ARG: "Argentina",
		IS: "Iceland",
		"RU-MOW": "Moscow region, Russia",
		"RU-SPE": "St. Petersburg region, Russia",
		"RU-SIB": "Siberia region, Russia",
		"RU-URA": "Urals region, Russia",
		"RU-FE": "Far East region, Russia",
		"CN-GD": "Guangdong Province, China",
		"CN-SC": "Sichuan Province, China",
		"CN-BJ": "Beijing, China",
		"CN-ZJ": "Zhejiang Province, China",
		"CN-XZ": "Tibet, China",
		"MX-MEX": "Central Mexico",
		"MX-JAL": "Jalisco, Mexico",
		"MX-NLE": "Nuevo León, Mexico",
		"MX-OAX": "Oaxaca, Mexico",
		"MX-YUC": "Yucatán Peninsula, Mexico",
		"BR-SP": "São Paulo, Brazil",
		"BR-AM": "Amazonas, Brazil",
		"BR-BA": "Bahia, Brazil",
		"BR-RS": "Rio Grande do Sul, Brazil",
		"EU-NORTH": "Northern Europe",
		"EU-WEST": "Western Europe",
		"EU-EAST": "Eastern Europe",
		"EU-SOUTH": "Southern Europe",
		"AF-NORTH": "North Africa",
		"AF-SOUTH": "Southern Africa",
		"AF-EAST": "East Africa",
		"AF-WEST": "West Africa",
		"AF-CENTRAL": "Central Africa",
	};

	const caProvinces = {
		"CA-AB": "Alberta, Canada",
		"CA-BC": "British Columbia, Canada",
		"CA-MB": "Manitoba, Canada",
		"CA-NB": "New Brunswick, Canada",
		"CA-NL": "Newfoundland and Labrador, Canada",
		"CA-NS": "Nova Scotia, Canada",
		"CA-ON": "Ontario, Canada",
		"CA-PE": "Prince Edward Island, Canada",
		"CA-QC": "Quebec, Canada",
		"CA-SK": "Saskatchewan, Canada",
		"CA-NT": "Northwest Territories, Canada",
		"CA-NU": "Nunavut, Canada",
		"CA-YT": "Yukon, Canada",
	};

	if (state === "default") {
		return "North America";
	}
	if (countryNames[state]) {
		return countryNames[state];
	}
	if (caProvinces[state]) {
		return caProvinces[state];
	}
	return `the "${state}" region of the US`;
}

export function buildImagePrompt(species, state, targetDate = todayIso()) {
	const month = monthNameForDate(targetDate);
	const regionText = getRegionPromptText(state);
	return (
		`Generate a beautiful, highly detailed photorealistic image of a ${species.common} ` +
		`(${species.latin}) in full bloom, native to ${regionText} and blooming in ${month}. ` +
		`Soft natural lighting, botanically accurate, white or softly blurred outdoor background. ` +
		`No text, no watermarks, portrait orientation.\n\n` +
		`After the image, write exactly one sentence (max 280 characters) describing this flower's ` +
		`appearance or ecological significance. Start directly with the description — no preamble.`
	);
}

export function selectTargetRegions(
	allSpecies,
	{ targetStates = null, usOnly = false } = {},
) {
	if (Array.isArray(targetStates) && targetStates.length > 0) {
		return targetStates.map((s) => s.trim()).filter(Boolean);
	}
	const allKeys = Object.keys(allSpecies);
	return usOnly ? allKeys.filter((s) => US_STATES.has(s)) : allKeys;
}

export async function generateImage(
	apiKey,
	species,
	state,
	modelName,
	targetDate = todayIso(),
	options = {},
) {
	const {
		fetchImpl = globalThis.fetch,
		sleepImpl = defaultSleep,
		backoffBaseMs = 5000,
		maxAttempts = 3,
	} = options;

	const month = monthNameForDate(targetDate);
	const prompt = buildImagePrompt(species, state, targetDate);

	const body = {
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
	};

	const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;

	// Retry on 429 (rate limit), 5xx (transient), and network errors with backoff.
	// Free-tier/burst Gemini occasionally returns 429 / RESOURCE_EXHAUSTED transiently,
	// so retry before concluding quota is exhausted.
	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let resp;
		try {
			resp = await fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
		} catch (networkErr) {
			lastErr = networkErr;
			if (attempt === maxAttempts) throw lastErr;
			const waitMs = backoffBaseMs * attempt;
			console.warn(
				`    retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms (network error: ${networkErr.message})`,
			);
			await sleepImpl(waitMs);
			continue;
		}

		if (resp.ok) {
			const json = await resp.json();
			const parts = json?.candidates?.[0]?.content?.parts ?? [];

			let imageData = null;
			let blurb = `A ${species.common} (${species.latin}) blooming in ${month}.`;

			for (const part of parts) {
				if (part.inlineData?.mimeType?.startsWith("image/")) {
					imageData = part.inlineData.data;
				}
				if (part.text) {
					blurb = stripPreamble(part.text).slice(0, 280);
				}
			}

			if (!imageData) throw new Error("No image in Gemini response");
			return { imageData, blurb };
		}

		const text = await resp.text();
		let errorObj;
		try {
			errorObj = JSON.parse(text);
		} catch (_e) {}

		const errorMessage = errorObj?.error?.message || text;
		const isQuotaExhaustedBody =
			errorMessage.includes("RESOURCE_EXHAUSTED") ||
			errorObj?.error?.status === "RESOURCE_EXHAUSTED";
		const isPermanentBillingOrAuth =
			resp.status === 402 ||
			resp.status === 403 ||
			errorMessage.includes("prepayment credits") ||
			(resp.status !== 429 &&
				!isQuotaExhaustedBody &&
				/\bbilling\b/i.test(errorMessage));

		if (isPermanentBillingOrAuth) {
			console.error(
				"\n======================================================================",
			);
			console.error(
				"🔴 CRITICAL GEMINI API ERROR: BILLING OR AUTHORIZATION FAILURE",
			);
			console.error(errorMessage);
			console.error(
				"======================================================================\n",
			);
			throw new Error(
				`Gemini billing/auth error (${resp.status}): ${errorMessage.slice(0, 200)}`,
			);
		}

		lastErr = new Error(`Gemini ${resp.status}: ${errorMessage.slice(0, 200)}`);

		const retryable = resp.status === 429 || resp.status >= 500;
		if (!retryable || attempt === maxAttempts) {
			if (resp.status === 429 || isQuotaExhaustedBody) {
				console.error(
					"\n======================================================================",
				);
				console.error(
					"🔴 CRITICAL GEMINI API ERROR: QUOTA EXHAUSTED AFTER RETRIES",
				);
				console.error(errorMessage);
				console.error(
					"======================================================================\n",
				);
				throw new Error("Quota Exhausted for this model");
			}
			throw lastErr;
		}

		const retryAfterMs = parseRetryAfterMs(resp.headers);
		const waitMs =
			retryAfterMs !== null ? retryAfterMs : backoffBaseMs * attempt;

		console.warn(
			`    retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms (${resp.status})`,
		);
		await sleepImpl(waitMs);
	}
	throw lastErr;
}

/**
 * The model sometimes returns a chatty preamble like
 * "Here's your highly detailed photorealistic illustration of …:" before the
 * actual description. Strip common preamble patterns; keep the rest.
 */
export function stripPreamble(text) {
	const t = text.trim();
	// Match openers up to the first colon-then-text or first sentence-final period.
	const preambleColon =
		/^(here(?:'s| is)|this is|below is|attached is)[^:.]*:\s*/i;
	return t.replace(preambleColon, "").trim();
}

export async function run(options = {}) {
	const parsed = parseCliArgs(options.argv);
	const targetDate = options.targetDate ?? parsed.targetDate;
	const targetStates = options.targetStates ?? parsed.targetStates;
	const missingOnly = options.missingOnly ?? parsed.missingOnly;
	const usOnly = options.usOnly ?? parsed.usOnly;
	const warehouseDir =
		options.warehouseDir ??
		parsed.warehouseDir ??
		process.env.DAILY_WAREHOUSE_DIR ??
		"";
	const docsDir = options.docsDir ?? DOCS_DIR;
	const speciesPath = options.speciesPath ?? SPECIES_PATH;
	const apiKey = options.apiKey ?? process.env.GEMINI_API_KEY;
	const dryRun = options.dryRun ?? process.env.DRY_RUN === "1";

	if (!isValidIsoDate(targetDate)) {
		console.error(
			`Invalid targetDate "${targetDate}" (expected valid YYYY-MM-DD calendar date)`,
		);
		process.exitCode = 1;
		return { ok: 0, skip: 0, fail: 0, failedStates: [] };
	}

	if (!apiKey && !dryRun) {
		console.error("GEMINI_API_KEY is required (or set DRY_RUN=1)");
		process.exitCode = 1;
		return { ok: 0, skip: 0, fail: 0, failedStates: [] };
	}

	const allSpecies = JSON.parse(readFileSync(speciesPath, "utf8"));
	const states = selectTargetRegions(allSpecies, { targetStates, usOnly });
	const resolvedDocsDir = resolve(docsDir);

	console.log(
		`Generating ${states.length} flowers for ${targetDate}` +
			`${dryRun ? " [DRY RUN]" : ""}${missingOnly ? " [MISSING ONLY]" : ""}`,
	);

	let ok = 0;
	let skip = 0;
	let fail = 0;
	const failedStates = [];

	let index = 0;
	async function worker() {
		while (index < states.length) {
			const taskIdx = index++;
			const state = states[taskIdx];
			if (!state) continue;

			const stateDir = resolve(resolvedDocsDir, state);
			const relState = relative(resolvedDocsDir, stateDir);
			const isConfined =
				relState !== "" &&
				!relState.startsWith("..") &&
				!isAbsolute(relState) &&
				!state.includes("/") &&
				!state.includes("\\");

			if (!isConfined) {
				console.warn(
					`  ${state}: invalid region path outside docsDir, skipping`,
				);
				fail++;
				failedStates.push(state);
				continue;
			}

			if (!Object.hasOwn(allSpecies, state)) {
				console.warn(`  ${state}: unknown region, skipping`);
				skip++;
				continue;
			}

			const species = allSpecies[state];
			if (!Array.isArray(species) || species.length === 0) {
				console.warn(`  ${state}: no species data, skipping`);
				skip++;
				continue;
			}

			const imgPath = join(stateDir, `${targetDate}.${IMG_EXT}`);
			const jsonPath = join(stateDir, `${targetDate}.json`);

			// Two skip modes:
			//
			//   default ("heal"):     skip iff BOTH files exist AND image is non-zero.
			//                         Garbage from earlier failed runs gets regenerated.
			//   --missing-only:       skip if ANY trace exists. Safest for backfills —
			//                         never overwrites a partial that might be real data.
			const imgExists = existsSync(imgPath);
			const jsonExists = existsSync(jsonPath);
			const imgValid = imgExists && statSync(imgPath).size > 0;

			if (imgValid && jsonExists) {
				console.log(`  ${state}: already complete, skipping`);
				skip++;
				continue;
			}
			if (missingOnly && (imgExists || jsonExists)) {
				console.log(
					`  ${state}: partial output present, skipping (--missing-only)`,
				);
				skip++;
				continue;
			}

			try {
				const picked = pickSpecies(species, state, targetDate);
				console.log(`  ${state}: ${picked.common} (${picked.latin})`);

				mkdirSync(stateDir, { recursive: true });

				if (dryRun) {
					const month = monthNameForDate(targetDate);
					writeFileSync(imgPath, Buffer.alloc(0));
					writeFileSync(
						jsonPath,
						JSON.stringify({
							common: picked.common,
							latin: picked.latin,
							blurb: `A ${picked.common} (${picked.latin}) blooming in ${month}.`,
							generatedAt: new Date().toISOString(),
							imageExt: IMG_EXT,
						}),
					);
				} else {
					// Round-robin start index, falling back to other models on failure
					for (let i = 0; i < GEMINI_MODELS.length; i++) {
						const modelName =
							GEMINI_MODELS[(taskIdx + i) % GEMINI_MODELS.length];
						console.log(`  ${state}: Trying model ${modelName}`);
						try {
							const { imageData, blurb } = await generateImage(
								apiKey,
								picked,
								state,
								modelName,
								targetDate,
								{
									fetchImpl: options.fetchImpl,
									sleepImpl: options.sleepImpl,
									backoffBaseMs: options.backoffBaseMs,
									maxAttempts: options.maxAttempts,
								},
							);
							writeFileSync(imgPath, Buffer.from(imageData, "base64"));
							writeFileSync(
								jsonPath,
								JSON.stringify({
									common: picked.common,
									latin: picked.latin,
									blurb,
									generatedAt: new Date().toISOString(),
									imageExt: IMG_EXT,
								}),
							);
							break; // Success!
						} catch (err) {
							console.log(
								`  ${state}: Model ${modelName} failed (${err.message})`,
							);
							if (i === GEMINI_MODELS.length - 1) throw err; // All models failed
						}
					}
				}
				ok++;
			} catch (e) {
				console.error(`  ${state}: FAILED — ${e.message}`);
				fail++;
				failedStates.push(state);
			}
		}
	}

	// Start workers concurrently
	const workers = Array.from(
		{ length: Math.min(CONCURRENCY, states.length) },
		() => worker(),
	);
	await Promise.all(workers);

	await archiveOldPngs({ targetDate, docsDir, warehouseDir });

	const costPerImage = 0.03;
	const totalCost = dryRun ? 0 : ok * costPerImage;
	console.log(`\n========================================`);
	console.log(`Daily Generation Summary (${targetDate}):`);
	console.log(`- Generated: ${ok} images`);
	console.log(`- Skipped:   ${skip} regions`);
	console.log(`- Failed:    ${fail} regions`);
	console.log(
		`- Est. Cost: $${totalCost.toFixed(2)} USD (at $${costPerImage}/image)`,
	);
	console.log(`========================================`);

	if (failedStates.length) {
		console.log(`Failed states: ${failedStates.join(",")}`);
		console.log(
			`Re-run with: --states ${failedStates.join(",")} --missing-only`,
		);
	}

	if (!dryRun && fail > 0) {
		process.exitCode = 1;
	}

	return { ok, skip, fail, failedStates };
}

function updateSidecarToJpg(jsonPath) {
	if (!existsSync(jsonPath)) return;
	try {
		const raw = readFileSync(jsonPath, "utf8");
		const parsed = JSON.parse(raw);
		if (parsed.imageExt !== "jpg") {
			parsed.imageExt = "jpg";
			writeFileSync(jsonPath, JSON.stringify(parsed));
		}
	} catch (err) {
		console.error(`  Failed to update sidecar ${jsonPath}: ${err.message}`);
	}
}

export async function archiveOldPngs({
	targetDate = todayIso(),
	docsDir = DOCS_DIR,
	warehouseDir = process.env.DAILY_WAREHOUSE_DIR ?? "",
} = {}) {
	console.log(
		"\nRunning rolling buffer cleanup (JPEG conversion at day 7, PNG removal at day 9)...",
	);

	if (!isValidIsoDate(targetDate)) {
		console.warn(`Invalid targetDate "${targetDate}", skipping archiving.`);
		return { convertedCount: 0, archivedCount: 0 };
	}

	const todayMs = new Date(`${targetDate}T00:00:00Z`).getTime();
	if (Number.isNaN(todayMs)) {
		return { convertedCount: 0, archivedCount: 0 };
	}

	let convertedCount = 0;
	let archivedCount = 0;

	if (!existsSync(docsDir)) return { convertedCount, archivedCount };

	const stateEntries = readdirSync(docsDir, { withFileTypes: true });
	for (const stateEntry of stateEntries) {
		if (!stateEntry.isDirectory()) continue;
		const state = stateEntry.name;
		const statePath = join(docsDir, state);

		const fileEntries = readdirSync(statePath, { withFileTypes: true });
		for (const fileEntry of fileEntries) {
			if (!fileEntry.isFile()) continue;
			const file = fileEntry.name;
			if (!file.endsWith(".png")) continue;

			const fileDateStr = file.slice(0, -4);
			if (!isValidIsoDate(fileDateStr)) continue;

			const fileMs = new Date(`${fileDateStr}T00:00:00Z`).getTime();
			if (Number.isNaN(fileMs)) continue;

			const diffDays = Math.floor((todayMs - fileMs) / 86_400_000);
			const pngPath = join(statePath, file);
			const jpgPath = join(statePath, `${fileDateStr}.jpg`);
			const jsonPath = join(statePath, `${fileDateStr}.json`);

			if (diffDays >= 7) {
				try {
					const stat = statSync(pngPath);
					const needsJpg =
						!existsSync(jpgPath) ||
						(stat.size > 0 && statSync(jpgPath).size === 0);

					if (needsJpg) {
						if (stat.size > 0) {
							const buffer = readFileSync(pngPath);
							const image = await Jimp.read(buffer);
							const jpgBuffer = await image.getBuffer(JimpMime.jpeg, {
								quality: 85,
							});
							writeFileSync(jpgPath, jpgBuffer);
						} else {
							writeFileSync(jpgPath, Buffer.alloc(0));
						}
						convertedCount++;
					}

					// Update sidecar imageExt to "jpg" while preserving all other fields
					updateSidecarToJpg(jsonPath);

					// Keep PNG across days 7 and 8 (2-day overlap window); retire only at day 9+
					if (diffDays >= 9) {
						if (warehouseDir && warehouseDir.trim() !== "") {
							const destPath = join(warehouseDir, state, file);
							mkdirSync(dirname(destPath), { recursive: true });
							copyFileSync(pngPath, destPath);
						}
						unlinkSync(pngPath);
						archivedCount++;
					}
				} catch (err) {
					console.error(`  Failed to archive ${pngPath}: ${err.message}`);
				}
			}
		}
	}

	if (convertedCount > 0 || archivedCount > 0) {
		console.log(
			`Archive pass complete: ${convertedCount} JPEG(s) generated, ${archivedCount} PNG(s) retired.`,
		);
	} else {
		console.log("No older PNGs required archiving.");
	}

	return { convertedCount, archivedCount };
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		return (
			realpathSync(fileURLToPath(import.meta.url)) ===
			realpathSync(resolve(process.argv[1]))
		);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	run();
}
