#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DB_PATH = join(ROOT, "assets", "species.db");

console.log("🔍 Running Database Smoke Test...");

if (!existsSync(DB_PATH)) {
	console.error(
		`❌ Database not found at ${DB_PATH}. Please run "pnpm db:compile" first.`,
	);
	process.exit(1);
}

function runQuery(sql) {
	try {
		return execSync(`sqlite3 "${DB_PATH}" "${sql}"`, {
			encoding: "utf-8",
			stdio: "pipe",
		}).trim();
	} catch (e) {
		console.error(
			`Command failed: sqlite3 "${DB_PATH}" "${sql}"\nError: ${e.message}`,
		);
		return null;
	}
}

// 1. Check species count
const rowCountStr = runQuery("SELECT count(*) FROM species;");
if (rowCountStr === null) {
	console.error("❌ Failed to execute count query.");
	process.exit(1);
}
const count = parseInt(rowCountStr, 10);
if (Number.isNaN(count) || count <= 0) {
	console.error(`❌ Invalid species count: "${rowCountStr}"`);
	process.exit(1);
}
console.log(`✅ Species count verified: ${count} species found.`);

// 2. Check structure of a sample species
const sampleJson = runQuery(
	"SELECT JSON_OBJECT('id', id, 'region', region, 'common', common, 'latin', latin, 'bloom_months', bloom_months) FROM species LIMIT 1;",
);
if (!sampleJson) {
	// If JSON_OBJECT is not supported in the system sqlite3 version, fall back to simple select
	const sampleText = runQuery(
		"SELECT id, region, common, latin, bloom_months FROM species LIMIT 1;",
	);
	if (!sampleText) {
		console.error("❌ Failed to select sample row.");
		process.exit(1);
	}
	console.log(`✅ Query check passed (fallback format): "${sampleText}"`);
} else {
	try {
		const sample = JSON.parse(sampleJson);
		console.log(`✅ Sample record parsed successfully:`, sample);
	} catch (err) {
		console.error(`❌ Failed to parse query result: ${err.message}`);
		process.exit(1);
	}
}

// 3. Verify embedding column contains non-empty blobs and is exactly 12288 bytes (3072 float32 dimensions)
const embeddingSizeStr = runQuery(
	"SELECT length(embedding) FROM species LIMIT 1;",
);
const embeddingSize = parseInt(embeddingSizeStr, 10);
if (Number.isNaN(embeddingSize) || embeddingSize !== 12288) {
	console.error(
		`❌ Embedding blob size mismatch. Expected 12288 bytes (3072 float32), got: ${embeddingSizeStr} bytes`,
	);
	process.exit(1);
}
console.log(`✅ Vector embeddings verified (3072 dimensions, 12288 bytes).`);

console.log("🎉 Database smoke test passed successfully!");
process.exit(0);
