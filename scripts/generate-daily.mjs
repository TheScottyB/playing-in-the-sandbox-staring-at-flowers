#!/usr/bin/env node
/**
 * Generates one flower image + sidecar JSON per state bucket for today's date
 * and writes them to docs/daily/{state}/{YYYY-MM-DD}.{png,json}.
 *
 * Usage:
 *   GEMINI_API_KEY=... node scripts/generate-daily.mjs [--date YYYY-MM-DD] [--states AL,TX] [--missing-only]
 *
 * Flags:
 *   --date YYYY-MM-DD  Target date (default: today UTC).
 *   --states AL,TX     Comma-separated state codes (default: every bucket in species.json).
 *   --missing-only     Skip states that already have both files for the target date.
 *                      Lets backfill runs avoid re-paying for completed states.
 *
 * Environment:
 *   GEMINI_API_KEY  Required. Google AI Studio key with Gemini 2.5 Flash access.
 *   DRY_RUN        Set to "1" to skip actual API calls (writes placeholder files).
 *
 * Exit codes:
 *   0  Run completed (whether or not every state succeeded). The workflow's
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
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp, JimpMime } from "jimp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DOCS_DIR = join(ROOT, "docs", "daily");
const IMG_EXT = "png"; // Daily images are generated as high-res PNGs
const SPECIES_PATH = join(ROOT, "lib", "data", "species.json");

const GEMINI_MODELS = [
	"gemini-3-pro-image",
	"gemini-3.1-flash-lite-image",
	"gemini-3.1-flash-image",
	"gemini-2.5-flash-image-preview",
];
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Generation scope & performance configuration
const US_ONLY = true; // Set to false to enable Rest of World (ROW) generation in the future
const CONCURRENCY = 5; // Number of parallel API requests (safe for billing-enabled keys)

const US_STATES = new Set([
	"AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
	"HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
	"MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
	"NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
	"SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
	"DC"
]);


// Parse CLI args
const args = process.argv.slice(2);
function argVal(flag) {
	const i = args.indexOf(flag);
	return i !== -1 ? args[i + 1] : null;
}
function argFlag(flag) {
	return args.includes(flag);
}

const targetDate = argVal("--date") ?? todayIso();
const targetStates = argVal("--states")?.split(",") ?? null;
const missingOnly = argFlag("--missing-only");

function todayIso() {
	const d = new Date();
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Deterministic index — same state+date always picks the same species. */
function pickSpecies(species, state, date) {
	const month = Number(date.slice(5, 7));
	const inSeason = species.filter((s) => s.bloomMonths.includes(month));
	const pool = inSeason.length > 0 ? inSeason : species;
	const hash = createHash("sha256").update(`${state}:${date}`).digest("hex");
	const idx = Number(BigInt(`0x${hash.slice(0, 8)}`) % BigInt(pool.length));
	return pool[idx];
}

function getRegionPromptText(state) {
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

async function generateImage(apiKey, species, state, modelName) {
	const month = new Date().toLocaleString("en-US", { month: "long" });
	const regionText = getRegionPromptText(state);
	const prompt =
		`Generate a beautiful, highly detailed photorealistic image of a ${species.common} ` +
		`(${species.latin}) in full bloom, native to ${regionText} and blooming in ${month}. ` +
		`Soft natural lighting, botanically accurate, white or softly blurred outdoor background. ` +
		`No text, no watermarks, portrait orientation.\n\n` +
		`After the image, write exactly one sentence (max 280 characters) describing this flower's ` +
		`appearance or ecological significance. Start directly with the description — no preamble.`;

	const body = {
		contents: [{ parts: [{ text: prompt }] }],
		generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
	};

	const url = `${GEMINI_BASE}/models/${modelName}:generateContent?key=${apiKey}`;

	// Retry on 429 (rate limit) and 5xx (transient) with exponential backoff.
	// Free-tier Gemini occasionally rate-limits even at 9 rpm, especially for
	// image generation, so a short retry is cheaper than waiting until tomorrow.
	const maxAttempts = 3;
	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

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
		} catch (e) {}

		const errorMessage = errorObj?.error?.message || text;
		const isBillingOrQuota =
			resp.status === 429 ||
			errorMessage.includes("prepayment credits") ||
			errorMessage.includes("RESOURCE_EXHAUSTED") ||
			errorObj?.error?.status === "RESOURCE_EXHAUSTED";

		if (isBillingOrQuota) {
			console.error(
				"\n======================================================================",
			);
			console.error("🔴 CRITICAL GEMINI API ERROR: BILLING OR QUOTA EXHAUSTED");
			console.error(errorMessage);
			console.error(
				"======================================================================\n",
			);
			throw new Error("Quota Exhausted for this model");
		}

		lastErr = new Error(`Gemini ${resp.status}: ${errorMessage.slice(0, 200)}`);

		const retryable = resp.status === 429 || resp.status >= 500;
		if (!retryable || attempt === maxAttempts) throw lastErr;

		const backoffMs = 5000 * attempt;
		console.warn(
			`    retry ${attempt}/${maxAttempts - 1} after ${backoffMs}ms (${resp.status})`,
		);
		await new Promise((r) => setTimeout(r, backoffMs));
	}
	throw lastErr;
}

/**
 * The model sometimes returns a chatty preamble like
 * "Here's your highly detailed photorealistic illustration of …:" before the
 * actual description. Strip common preamble patterns; keep the rest.
 */
function stripPreamble(text) {
	const t = text.trim();
	// Match openers up to the first colon-then-text or first sentence-final period.
	const preambleColon =
		/^(here(?:'s| is)|this is|below is|attached is)[^:.]*:\s*/i;
	return t.replace(preambleColon, "").trim();
}

async function run() {
	const apiKey = process.env.GEMINI_API_KEY;
	const dryRun = process.env.DRY_RUN === "1";

	if (!apiKey && !dryRun) {
		console.error("GEMINI_API_KEY is required (or set DRY_RUN=1)");
		process.exit(1);
	}

	const allSpecies = JSON.parse(readFileSync(SPECIES_PATH, "utf8"));
	
	let states = targetStates;
	if (!states) {
		const allKeys = Object.keys(allSpecies);
		states = US_ONLY ? allKeys.filter((s) => US_STATES.has(s)) : allKeys;
	}


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
			const state = states[index++];
			if (!state) continue;

			const stateDir = join(DOCS_DIR, state);
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

			const species = allSpecies[state];
			if (!species) {
				console.warn(`  ${state}: no species data, skipping`);
				skip++;
				continue;
			}

			const picked = pickSpecies(species, state, targetDate);
			console.log(`  ${state}: ${picked.common} (${picked.latin})`);

			try {
				mkdirSync(stateDir, { recursive: true });

				if (dryRun) {
					writeFileSync(imgPath, Buffer.alloc(0));
					writeFileSync(
						jsonPath,
						JSON.stringify({
							common: picked.common,
							latin: picked.latin,
							blurb: `${picked.common} blooming today.`,
							generatedAt: new Date().toISOString(),
						}),
					);
				} else {
					// Round-robin start index, falling back to other models on failure
					let success = false;
					for (let i = 0; i < GEMINI_MODELS.length; i++) {
						const modelName = GEMINI_MODELS[(index + i) % GEMINI_MODELS.length];
						console.log(`  ${state}: Trying model ${modelName}`);
						try {
							const { imageData, blurb } = await generateImage(apiKey, picked, state, modelName);
							writeFileSync(imgPath, Buffer.from(imageData, "base64"));
							writeFileSync(
								jsonPath,
								JSON.stringify({
									common: picked.common,
									latin: picked.latin,
									blurb,
									generatedAt: new Date().toISOString(),
								}),
							);
							success = true;
							break; // Success!
						} catch (err) {
							console.log(`  ${state}: Model ${modelName} failed (${err.message})`);
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
	const workers = Array.from({ length: Math.min(CONCURRENCY, states.length) }, () => worker());
	await Promise.all(workers);


	await archiveOldPngs();

	const costPerImage = 0.03;
	const totalCost = dryRun ? 0 : ok * costPerImage;
	console.log(`\n========================================`);
	console.log(`Daily Generation Summary (${targetDate}):`);
	console.log(`- Generated: ${ok} images`);
	console.log(`- Skipped:   ${skip} regions`);
	console.log(`- Failed:    ${fail} regions`);
	console.log(`- Est. Cost: $${totalCost.toFixed(2)} USD (at $${costPerImage}/image)`);
	console.log(`========================================`);

	if (failedStates.length) {
		console.log(`Failed states: ${failedStates.join(",")}`);
		console.log(
			`Re-run with: --states ${failedStates.join(",")} --missing-only`,
		);
	}
}


const WAREHOUSE_DIR = "/Users/scottybe/workspace/shared/design-assets/daily";

async function archiveOldPngs() {
	console.log(
		"\nRunning rolling buffer cleanup (archiving PNGs older than 7 days)...",
	);
	const todayStr = targetDate;
	const todayDate = new Date(todayStr + "T12:00:00");

	let archivedCount = 0;

	if (!existsSync(DOCS_DIR)) return;
	const states = readdirSync(DOCS_DIR);
	for (const state of states) {
		const statePath = join(DOCS_DIR, state);
		if (!statSync(statePath).isDirectory()) continue;

		const files = readdirSync(statePath);
		for (const file of files) {
			if (!file.endsWith(".png")) continue;

			const fileDateStr = file.replace(".png", "");
			const fileDate = new Date(fileDateStr + "T12:00:00");
			if (isNaN(fileDate.getTime())) continue;

			const diffTime = todayDate.getTime() - fileDate.getTime();
			const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

			if (diffDays >= 8) {
				const pngPath = join(statePath, file);
				const jpgPath = pngPath.replace(".png", ".jpg");

				try {
					// 1. Convert to JPEG and save in doc site
					const stat = statSync(pngPath);
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

					// 2. Backup high-res PNG to common warehouse (if accessible)
					if (existsSync("/Users/scottybe/workspace/shared/design-assets")) {
						const destPath = join(WAREHOUSE_DIR, state, file);
						mkdirSync(dirname(destPath), { recursive: true });
						copyFileSync(pngPath, destPath);
					}

					// 3. Delete the original PNG from active repository docs/daily/
					unlinkSync(pngPath);
					archivedCount++;
				} catch (err) {
					console.error(`  Failed to archive ${pngPath}: ${err.message}`);
				}
			}
		}
	}

	if (archivedCount > 0) {
		console.log(`Successfully archived ${archivedCount} PNGs to JPEG.`);
	} else {
		console.log("No older PNGs required archiving.");
	}
}

run();
