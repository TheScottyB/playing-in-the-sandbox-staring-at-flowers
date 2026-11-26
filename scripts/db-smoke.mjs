#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { DB_VERSION, EMBEDDING_DIM } from "./compile_species_db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DB_PATH = join(ROOT, "assets", "species.db");
const SPECIES_JSON_PATH = join(ROOT, "lib", "data", "species.json");
const EXPECTED_EMBEDDING_BYTES = EMBEDDING_DIM * 4;

console.log("🔍 Running Database Smoke Test...");

if (!existsSync(DB_PATH)) {
	console.error(
		`❌ Database not found at ${DB_PATH}. Please run "pnpm db:compile" first.`,
	);
	process.exit(1);
}

const speciesJson = JSON.parse(readFileSync(SPECIES_JSON_PATH, "utf8"));
const expectedRegions = Object.keys(speciesJson);
const expectedRowCount = expectedRegions.reduce(
	(sum, r) => sum + speciesJson[r].length,
	0,
);
const expectedDefaultCount = Array.isArray(speciesJson.default)
	? speciesJson.default.length
	: 0;

let db;
try {
	db = new DatabaseSync(DB_PATH, { readOnly: true });

	// 1. Verify PRAGMA user_version
	const versionRow = db.prepare("PRAGMA user_version;").get();
	const userVersion = versionRow?.user_version ?? 0;
	if (userVersion !== DB_VERSION) {
		console.error(
			`❌ PRAGMA user_version mismatch. Expected ${DB_VERSION}, got ${userVersion}.`,
		);
		process.exit(1);
	}
	console.log(`✅ PRAGMA user_version verified: ${userVersion}.`);

	// 2. Verify schema objects (idx_species_region & species_fts)
	const objects = db
		.prepare(
			"SELECT type, name FROM sqlite_master WHERE name IN ('species', 'idx_species_region', 'species_fts');",
		)
		.all();
	const names = new Set(objects.map((o) => o.name));
	for (const required of ["species", "idx_species_region", "species_fts"]) {
		if (!names.has(required)) {
			console.error(`❌ Missing required SQLite object: ${required}`);
			process.exit(1);
		}
	}
	console.log("✅ Schema verified (species, idx_species_region, species_fts).");

	// 3. Verify exact row count, region count, and "default" region count
	const countsRow = db
		.prepare(
			"SELECT count(*) AS totalRows, count(DISTINCT region) AS distinctRegions, sum(CASE WHEN region = 'default' THEN 1 ELSE 0 END) AS defaultRows FROM species;",
		)
		.get();
	if (countsRow.totalRows !== 396 || countsRow.totalRows !== expectedRowCount) {
		console.error(
			`❌ Species row count mismatch. Expected 396 (and ${expectedRowCount} from species.json), got ${countsRow.totalRows}.`,
		);
		process.exit(1);
	}
	if (
		countsRow.distinctRegions !== 112 ||
		countsRow.distinctRegions !== expectedRegions.length
	) {
		console.error(
			`❌ Distinct region count mismatch. Expected 112 (and ${expectedRegions.length} from species.json), got ${countsRow.distinctRegions}.`,
		);
		process.exit(1);
	}
	if (
		countsRow.defaultRows !== 18 ||
		countsRow.defaultRows !== expectedDefaultCount
	) {
		console.error(
			`❌ 'default' region count mismatch. Expected 18 (and ${expectedDefaultCount} from species.json), got ${countsRow.defaultRows}.`,
		);
		process.exit(1);
	}
	console.log(
		`✅ Species counts verified: ${countsRow.totalRows} species across ${countsRow.distinctRegions} regions (default: ${countsRow.defaultRows}).`,
	);

	// 4. Verify EVERY row has valid fields, bloom_months (1..12), and 12288-byte (3072-dim) embedding
	const allRows = db
		.prepare(
			"SELECT id, region, common, latin, bloom_months, length(embedding) AS embeddingBytes FROM species ORDER BY id;",
		)
		.all();
	for (const row of allRows) {
		if (!row.region?.trim() || !row.common?.trim() || !row.latin?.trim()) {
			console.error(`❌ Row ${row.id} has empty region/common/latin.`);
			process.exit(1);
		}
		if (row.embeddingBytes !== EXPECTED_EMBEDDING_BYTES) {
			console.error(
				`❌ Row ${row.id} (${row.common}) embedding size mismatch. Expected ${EXPECTED_EMBEDDING_BYTES} bytes (${EMBEDDING_DIM} float32), got ${row.embeddingBytes} bytes.`,
			);
			process.exit(1);
		}
		let months;
		try {
			months = JSON.parse(row.bloom_months);
		} catch (e) {
			console.error(
				`❌ Row ${row.id} (${row.common}) has invalid bloom_months JSON: ${e.message}`,
			);
			process.exit(1);
		}
		if (
			!Array.isArray(months) ||
			months.length === 0 ||
			months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)
		) {
			console.error(
				`❌ Row ${row.id} (${row.common}) has invalid bloom_months values: ${row.bloom_months}`,
			);
			process.exit(1);
		}
	}
	console.log(
		`✅ All ${allRows.length} rows verified: non-empty metadata, valid bloom_months, and ${EMBEDDING_DIM}-dim (${EXPECTED_EMBEDDING_BYTES}-byte) embeddings.`,
	);

	// 5. Execute real FTS5 bm25(species_fts) query
	const ftsMatches = db
		.prepare(
			`
			SELECT s.id, s.region, s.common, bm25(species_fts) AS rank
			FROM species_fts
			JOIN species s ON s.id = species_fts.rowid
			WHERE species_fts MATCH 'poppy*'
			ORDER BY rank;
		`,
		)
		.all();
	if (
		ftsMatches.length === 0 ||
		!ftsMatches.some((r) => r.common === "California Poppy")
	) {
		console.error(
			`❌ FTS5 bm25(species_fts) query for 'poppy*' did not return California Poppy.`,
		);
		process.exit(1);
	}
	console.log(
		`✅ FTS5 bm25(species_fts) verified ('poppy*' -> ${ftsMatches.length} matches, including California Poppy).`,
	);

	console.log("🎉 Database smoke test passed successfully!");
} finally {
	db?.close();
}
process.exit(0);
