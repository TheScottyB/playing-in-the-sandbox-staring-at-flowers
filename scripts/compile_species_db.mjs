#!/usr/bin/env node
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SPECIES_PATH = join(ROOT, "lib", "data", "species.json");
const OUT_DIR = join(ROOT, "assets");
const DB_PATH = join(OUT_DIR, "species.db");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_MODEL = "gemini-embedding-001"; // 3072-dimension embedding model
export const EMBEDDING_DIM = 3072;
export const DB_VERSION = 2;

export class PermanentApiError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "PermanentApiError";
		this.status = status;
	}
}

export const REGION_NAMES = {
	// Central/South America
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
	// Europe
	"EU-NORTH": "Northern Europe",
	"EU-WEST": "Western Europe",
	"EU-EAST": "Eastern Europe",
	"EU-SOUTH": "Southern Europe",
	IS: "Iceland",
	// Africa
	"AF-NORTH": "North Africa",
	"AF-SOUTH": "Southern Africa",
	"AF-EAST": "East Africa",
	"AF-WEST": "West Africa",
	"AF-CENTRAL": "Central Africa",
	// Russia
	"RU-MOW": "Moscow region, Russia",
	"RU-SPE": "St. Petersburg region, Russia",
	"RU-SIB": "Siberia region, Russia",
	"RU-URA": "Urals region, Russia",
	"RU-FE": "Far East region, Russia",
	// China
	"CN-GD": "Guangdong Province, China",
	"CN-SC": "Sichuan Province, China",
	"CN-BJ": "Beijing, China",
	"CN-ZJ": "Zhejiang Province, China",
	"CN-XZ": "Tibet, China",
	// Mexico
	"MX-MEX": "Central Mexico",
	"MX-JAL": "Jalisco, Mexico",
	"MX-NLE": "Nuevo León, Mexico",
	"MX-OAX": "Oaxaca, Mexico",
	"MX-YUC": "Yucatán Peninsula, Mexico",
	// Brazil
	"BR-SP": "São Paulo, Brazil",
	"BR-AM": "Amazonas, Brazil",
	"BR-BA": "Bahia, Brazil",
	"BR-RS": "Rio Grande do Sul, Brazil",
	// Canada
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
	// Defaults
	default: "Global Default fallback",
};

export function getRegionName(code) {
	if (REGION_NAMES[code]) return REGION_NAMES[code];
	return `${code} region, United States`;
}

function createDummyEmbedding() {
	// Return dummy vector of unit length (3072-dimension)
	const dummy = new Float32Array(EMBEDDING_DIM);
	dummy[0] = 1.0; // unit length
	return Array.from(dummy);
}

export function parseRetryAfterMs(headers) {
	const raw = headers?.get?.("retry-after") ?? headers?.get?.("Retry-After");
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

function isPermanentBillingOrAuthError(status, errorMessage, errorStatus) {
	const lower = errorMessage.toLowerCase();
	if (status === 401 || status === 403) return true;
	if (
		errorStatus === "PERMISSION_DENIED" ||
		errorStatus === "UNAUTHENTICATED"
	) {
		return true;
	}
	if (
		lower.includes("prepayment credits") ||
		lower.includes("api key not valid") ||
		lower.includes("invalid api key")
	) {
		return true;
	}
	if (
		status !== 429 &&
		errorStatus !== "RESOURCE_EXHAUSTED" &&
		lower.includes("billing")
	) {
		return true;
	}
	return false;
}

export async function fetchEmbedding(apiKey, text, options = {}) {
	if (!apiKey) {
		return createDummyEmbedding();
	}

	const maxAttempts = options.maxAttempts ?? 4;
	const baseDelayMs = options.baseDelayMs ?? 2000;
	const fetchImpl = options.fetchImpl ?? globalThis.fetch;
	const sleepImpl =
		options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

	const url = `${GEMINI_BASE}/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
	const body = {
		model: `models/${EMBEDDING_MODEL}`,
		content: { parts: [{ text }] },
	};

	let lastErrorMessage = "Unknown embedding error";

	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let retryAfterMs = null;
		let nonRetryable4xx = false;
		try {
			const resp = await fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (resp.ok) {
				const json = await resp.json();
				const values = json?.embedding?.values;
				if (!Array.isArray(values) || values.length !== EMBEDDING_DIM) {
					throw new Error(
						`Unexpected embedding dimensions: expected ${EMBEDDING_DIM}, got ${Array.isArray(values) ? values.length : "none"}`,
					);
				}
				return values;
			}

			const textErr = await resp.text();
			let errorObj;
			try {
				errorObj = JSON.parse(textErr);
			} catch (_e) {}

			const errorMessage = errorObj?.error?.message || textErr || "";
			const errorStatus = errorObj?.error?.status || "";
			lastErrorMessage = `HTTP ${resp.status}: ${errorMessage.slice(0, 150)}`;

			const isRateLimit =
				resp.status === 429 || errorStatus === "RESOURCE_EXHAUSTED";
			if (
				isPermanentBillingOrAuthError(resp.status, errorMessage, errorStatus)
			) {
				throw new PermanentApiError(
					errorMessage || `HTTP ${resp.status}`,
					resp.status,
				);
			}

			if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
				nonRetryable4xx = true;
			} else if (isRateLimit) {
				retryAfterMs = parseRetryAfterMs(resp.headers);
			}

			console.warn(
				`    Warning: Embedding API failed (${isRateLimit ? "rate limit " : ""}HTTP ${resp.status}, attempt ${attempt}/${maxAttempts}): ${errorMessage.slice(0, 150)}`,
			);
		} catch (e) {
			if (e instanceof PermanentApiError) {
				throw e;
			}
			lastErrorMessage = e.message;
			console.warn(
				`    Warning: Network/embedding failure (attempt ${attempt}/${maxAttempts}): ${e.message}`,
			);
		}

		if (nonRetryable4xx) {
			break;
		}

		if (attempt < maxAttempts) {
			const waitMs =
				retryAfterMs !== null ? retryAfterMs : baseDelayMs * 2 ** (attempt - 1);
			if (waitMs > 0) {
				await sleepImpl(waitMs);
			}
		}
	}

	throw new Error(
		`Failed to fetch embedding for "${text.slice(0, 50)}..." (${lastErrorMessage})`,
	);
}

export async function main() {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.warn(
			"⚠️ GEMINI_API_KEY is not set. Generating 3072-dim mock embeddings for offline testing.",
		);
	}

	console.log(`Reading species from ${SPECIES_PATH}...`);
	const speciesData = JSON.parse(readFileSync(SPECIES_PATH, "utf8"));

	mkdirSync(OUT_DIR, { recursive: true });

	const regions = Object.keys(speciesData);
	const rowsToInsert = [];

	for (const region of regions) {
		const list = speciesData[region];
		const regionName = getRegionName(region);
		console.log(
			`Processing region: ${region} (${regionName}) - ${list.length} flowers...`,
		);

		for (const species of list) {
			const blurb = species.blurb ?? "";
			const textToEmbed = `${species.common} (${species.latin}). Native to ${regionName}. ${blurb}`;

			let embedding;
			try {
				embedding = await fetchEmbedding(apiKey, textToEmbed);
			} catch (e) {
				if (e instanceof PermanentApiError) {
					console.error(
						"\n======================================================================",
					);
					console.error(
						"🔴 CRITICAL GEMINI API ERROR: BILLING OR AUTHENTICATION FAILED",
					);
					console.error(e.message);
					console.error(
						"======================================================================\n",
					);
					process.exit(1);
				}
				console.error(
					`Failed to embed ${species.common} in ${region}: ${e.message}. Falling back to mock vector.`,
				);
				embedding = createDummyEmbedding();
			}

			const floatArr = new Float32Array(embedding);
			const embeddingBlob = Buffer.from(
				floatArr.buffer,
				floatArr.byteOffset,
				floatArr.byteLength,
			);
			rowsToInsert.push({
				region,
				common: species.common,
				latin: species.latin,
				bloomMonthsJson: JSON.stringify(species.bloomMonths),
				blurb,
				embeddingBlob,
			});

			if (apiKey) {
				await new Promise((r) => setTimeout(r, 100)); // 100ms throttle
			}
		}
	}

	console.log(`Compiling SQLite database at ${DB_PATH} using node:sqlite...`);
	for (const candidate of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) {
		if (existsSync(candidate)) {
			unlinkSync(candidate);
		}
	}

	const db = new DatabaseSync(DB_PATH);
	try {
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec(`
			CREATE TABLE species (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				region TEXT NOT NULL,
				common TEXT NOT NULL,
				latin TEXT NOT NULL,
				bloom_months TEXT NOT NULL,
				blurb TEXT NOT NULL,
				embedding BLOB NOT NULL
			);
			CREATE INDEX idx_species_region ON species(region);
		`);

		const insertStmt = db.prepare(
			"INSERT INTO species (region, common, latin, bloom_months, blurb, embedding) VALUES (?, ?, ?, ?, ?, ?);",
		);

		db.exec("BEGIN;");
		try {
			for (const row of rowsToInsert) {
				insertStmt.run(
					row.region,
					row.common,
					row.latin,
					row.bloomMonthsJson,
					row.blurb,
					row.embeddingBlob,
				);
			}
			db.exec("COMMIT;");
		} catch (txErr) {
			db.exec("ROLLBACK;");
			throw txErr;
		}

		db.exec(`
			CREATE VIRTUAL TABLE IF NOT EXISTS species_fts USING fts5(
				region,
				common,
				latin,
				blurb,
				content='species',
				content_rowid='id',
				tokenize='porter unicode61'
			);
			INSERT INTO species_fts(species_fts) VALUES('rebuild');
			PRAGMA user_version = ${DB_VERSION};
		`);

		const countRow = db.prepare("SELECT count(*) AS count FROM species;").get();
		console.log("✅ SQLite compilation successful!");
		console.log(
			`Summary: Processed ${rowsToInsert.length} species across ${regions.length} regions.`,
		);
		console.log(`Verified database row count: ${countRow.count}`);
	} finally {
		db.close();
	}
}

const isEntrypoint = process.argv[1]
	? import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
	: false;

if (isEntrypoint) {
	main().catch((err) => {
		console.error("❌ SQLite compilation failed:", err);
		process.exit(1);
	});
}
