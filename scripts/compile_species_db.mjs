#!/usr/bin/env node
import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SPECIES_PATH = join(ROOT, "lib", "data", "species.json");
const OUT_DIR = join(ROOT, "assets");
const DB_PATH = join(OUT_DIR, "species.db");
const TEMP_SQL = join(ROOT, "scratch", "species_dump.sql");

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
const EMBEDDING_MODEL = "gemini-embedding-001"; // 768-dimension embedding model

const REGION_NAMES = {
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

function getRegionName(code) {
	if (REGION_NAMES[code]) return REGION_NAMES[code];
	return `${code} region, United States`;
}

function runCommand(cmd) {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: "pipe" }).trim();
	} catch (e) {
		console.error(`Command failed: ${cmd}\nError: ${e.message}`);
		return null;
	}
}

async function fetchEmbedding(apiKey, text) {
	if (!apiKey) {
		// Return dummy vector of unit length (768-dimension) if API key is missing
		const dummy = new Float32Array(768);
		dummy[0] = 1.0; // unit length
		return Array.from(dummy);
	}

	const url = `${GEMINI_BASE}/models/${EMBEDDING_MODEL}:embedContent?key=${apiKey}`;
	const body = {
		model: `models/${EMBEDDING_MODEL}`,
		content: { parts: [{ text }] },
	};

	const maxAttempts = 3;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});

			if (resp.ok) {
				const json = await resp.json();
				return json.embedding.values;
			}

			const textErr = await resp.text();
			let errorObj;
			try {
				errorObj = JSON.parse(textErr);
			} catch (_e) {}

			const errorMessage = errorObj?.error?.message || textErr;
			const isBillingOrQuota =
				resp.status === 429 ||
				errorMessage.includes("prepayment credits") ||
				errorMessage.includes("RESOURCE_EXHAUSTED") ||
				errorObj?.error?.status === "RESOURCE_EXHAUSTED";

			if (isBillingOrQuota) {
				console.error(
					"\n======================================================================",
				);
				console.error(
					"🔴 CRITICAL GEMINI API ERROR: BILLING OR QUOTA EXHAUSTED",
				);
				console.error(errorMessage);
				console.error(
					"======================================================================\n",
				);
				process.exit(1);
			}

			console.warn(
				`    Warning: Embedding API failed (HTTP ${resp.status}): ${errorMessage.slice(0, 150)}`,
			);
		} catch (e) {
			console.warn(
				`    Warning: Network failure on embedding fetch: ${e.message}`,
			);
		}

		if (attempt < maxAttempts) {
			const waitMs = 2000 * attempt;
			await new Promise((r) => setTimeout(r, waitMs));
		}
	}

	throw new Error(`Failed to fetch embedding for: "${text.slice(0, 50)}..."`);
}

function escapeSql(str) {
	if (!str) return "";
	return str.replace(/'/g, "''");
}

async function main() {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		console.warn(
			"⚠️ GEMINI_API_KEY is not set. Generating mock embeddings for offline testing.",
		);
	}

	console.log(`Reading species from ${SPECIES_PATH}...`);
	const speciesData = JSON.parse(readFileSync(SPECIES_PATH, "utf8"));

	// Ensure assets and scratch dirs exist
	mkdirSync(OUT_DIR, { recursive: true });
	mkdirSync(dirname(TEMP_SQL), { recursive: true });

	const sqlStatements = [];

	// Base Schema
	sqlStatements.push("PRAGMA foreign_keys = ON;");
	sqlStatements.push("DROP TABLE IF EXISTS species;");
	sqlStatements.push(`
    CREATE TABLE species (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      region TEXT NOT NULL,
      common TEXT NOT NULL,
      latin TEXT NOT NULL,
      bloom_months TEXT NOT NULL,
      blurb TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
  `);
	sqlStatements.push("CREATE INDEX idx_species_region ON species(region);");

	const regions = Object.keys(speciesData);
	let totalProcessed = 0;

	for (const region of regions) {
		const list = speciesData[region];
		const regionName = getRegionName(region);
		console.log(
			`Processing region: ${region} (${regionName}) - ${list.length} flowers...`,
		);

		for (const species of list) {
			const textToEmbed = `${species.common} (${species.latin}). Native to ${regionName}. ${species.blurb}`;

			let embedding;
			try {
				embedding = await fetchEmbedding(apiKey, textToEmbed);
			} catch (e) {
				console.error(
					`Failed to embed ${species.common} in ${region}: ${e.message}. Falling back to mock vector.`,
				);
				const dummy = new Float32Array(768);
				dummy[0] = 1.0;
				embedding = Array.from(dummy);
			}

			// Convert float array to Float32Array buffer, then to hex string
			const floatArr = new Float32Array(embedding);
			const hexString = Buffer.from(floatArr.buffer).toString("hex");
			const bloomMonthsJson = JSON.stringify(species.bloomMonths);

			sqlStatements.push(`
        INSERT INTO species (region, common, latin, bloom_months, blurb, embedding)
        VALUES (
          '${escapeSql(region)}',
          '${escapeSql(species.common)}',
          '${escapeSql(species.latin)}',
          '${escapeSql(bloomMonthsJson)}',
          '${escapeSql(species.blurb)}',
          x'${hexString}'
        );
      `);

			totalProcessed++;

			// Sleep briefly to avoid hammering rate limit if calling live API
			if (apiKey) {
				await new Promise((r) => setTimeout(r, 100)); // 100ms throttle
			}
		}
	}

	// Write SQL dump file
	console.log(`Writing SQL dump to ${TEMP_SQL}...`);
	writeFileSync(TEMP_SQL, sqlStatements.join("\n"), "utf8");

	// Compile database using sqlite3 CLI
	console.log(
		`Compiling SQLite database at ${DB_PATH} using system sqlite3 CLI...`,
	);
	if (existsSync(DB_PATH)) {
		unlinkSync(DB_PATH);
	}

	const buildResult = runCommand(`sqlite3 "${DB_PATH}" < "${TEMP_SQL}"`);
	if (buildResult !== null) {
		console.log(`✅ SQLite compilation successful!`);
		console.log(
			`Summary: Processed ${totalProcessed} species across ${regions.length} regions.`,
		);

		// Verify by reading row count
		const rows = runCommand(
			`sqlite3 "${DB_PATH}" "SELECT count(*) FROM species;"`,
		);
		console.log(`Verified database row count: ${rows}`);
	} else {
		console.error("❌ SQLite compilation failed.");
	}

	// Cleanup
	if (existsSync(TEMP_SQL)) {
		unlinkSync(TEMP_SQL);
	}
}

main().catch(console.error);
