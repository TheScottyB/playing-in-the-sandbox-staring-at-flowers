import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";

export interface SpeciesRecord {
	id: number;
	region: string;
	common: string;
	latin: string;
	bloomMonths: number[];
	blurb: string;
	similarity?: number;
}

let dbInstance: SQLite.SQLiteDatabase | null = null;
let isSqliteVecAvailable = false;

// Ensure database is copied from assets and opened
export async function getDatabase(): Promise<SQLite.SQLiteDatabase> {
	if (dbInstance) return dbInstance;

	const dbName = "species.db";
	const dbDir = `${FileSystem.documentDirectory}SQLite`;
	const dbPath = `${dbDir}/${dbName}`;

	try {
		// Ensure Directory Exists
		const dirInfo = await FileSystem.getInfoAsync(dbDir);
		if (!dirInfo.exists) {
			await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });
		}

		// Always copy in development, or if missing in production
		const fileInfo = await FileSystem.getInfoAsync(dbPath);
		if (__DEV__ || !fileInfo.exists) {
			console.log(
				"[speciesDb] Copying species.db asset to local SQLite sandbox...",
			);
			const asset = Asset.fromModule(require("../assets/species.db"));
			await asset.downloadAsync();

			if (asset.localUri) {
				await FileSystem.copyAsync({
					from: asset.localUri,
					to: dbPath,
				});
			} else {
				throw new Error("Failed to resolve asset localUri");
			}
		}

		// Open Database Synchronously (Expo SQLite v14+)
		const db = SQLite.openDatabaseSync(dbName);
		dbInstance = db;

		// Check for native sqlite-vec extension
		try {
			const vecVer = db.getFirstSync<{ version: string }>(
				"SELECT vec_version() as version;",
			);
			if (vecVer?.version) {
				console.log(
					`[speciesDb] Native sqlite-vec detected (v${vecVer.version}). Enabling native vector search!`,
				);
				isSqliteVecAvailable = true;

				// Initialize and sync vec_species virtual table
				db.execSync(`
          CREATE VIRTUAL TABLE IF NOT EXISTS vec_species USING vec0(
            id INTEGER PRIMARY KEY,
            embedding float[768]
          );
        `);

				// Sync embeddings from base table to virtual table if empty
				const vecCount = db.getFirstSync<{ count: number }>(
					"SELECT count(*) as count FROM vec_species;",
				);
				const baseCount = db.getFirstSync<{ count: number }>(
					"SELECT count(*) as count FROM species;",
				);

				if (vecCount && baseCount && vecCount.count !== baseCount.count) {
					console.log(
						"[speciesDb] Syncing embeddings to vec_species virtual table...",
					);
					db.execSync("DELETE FROM vec_species;");
					db.execSync(
						"INSERT INTO vec_species (id, embedding) SELECT id, embedding FROM species;",
					);
				}
			}
		} catch {
			console.log(
				"[speciesDb] Native sqlite-vec not available. Defaulting to high-performance JS similarity fallback.",
			);
			isSqliteVecAvailable = false;
		}

		return db;
	} catch (error) {
		console.error("[speciesDb] Database initialization failed:", error);
		throw error;
	}
}

/** Deterministic indexing for offline daily flower selector */
function pickSpecies(
	list: SpeciesRecord[],
	state: string,
	date: string,
): SpeciesRecord {
	const month = Number(date.slice(5, 7));
	const inSeason = list.filter((s) => s.bloomMonths.includes(month));
	const pool = inSeason.length > 0 ? inSeason : list;

	// Custom hash index selection matching build script
	let hashVal = 0;
	const hashKey = `${state}:${date}`;
	for (let i = 0; i < hashKey.length; i++) {
		hashVal = (hashVal << 5) - hashVal + hashKey.charCodeAt(i);
		hashVal |= 0; // Convert to 32bit integer
	}
	const idx = Math.abs(hashVal) % pool.length;
	return pool[idx];
}

/** Resolves the offline daily flower for a given region and date */
export async function getDailyFlowerOffline(
	region: string,
	date: string,
): Promise<SpeciesRecord | null> {
	try {
		const db = await getDatabase();

		// Fetch all candidates for the region
		const rows = db.getAllSync<{
			id: number;
			region: string;
			common: string;
			latin: string;
			bloom_months: string;
			blurb: string;
		}>(
			"SELECT id, region, common, latin, bloom_months, blurb FROM species WHERE region = ?",
			[region],
		);

		if (rows.length === 0) return null;

		const list: SpeciesRecord[] = rows.map((r) => ({
			id: r.id,
			region: r.region,
			common: r.common,
			latin: r.latin,
			bloomMonths: JSON.parse(r.bloom_months),
			blurb: r.blurb,
		}));

		return pickSpecies(list, region, date);
	} catch (e) {
		console.error(
			`[speciesDb] Failed to query offline flower for region ${region}:`,
			e,
		);
		return null;
	}
}

export async function getSpeciesCount(): Promise<number> {
	try {
		const db = await getDatabase();
		const result = db.getFirstSync<{ count: number }>(
			"SELECT count(*) as count FROM species;",
		);
		return result?.count || 0;
	} catch (e) {
		console.error("[speciesDb] Failed to get species count:", e);
		return 0;
	}
}

/** Call Gemini Embedding API to embed search query */
async function getQueryEmbedding(
	queryText: string,
): Promise<Float32Array | null> {
	const apiKey = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
	if (!apiKey) {
		console.warn("[speciesDb] EXPO_PUBLIC_GEMINI_API_KEY is not configured.");
		return null;
	}

	const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
	const url = `${GEMINI_BASE}/models/gemini-embedding-001:embedContent?key=${apiKey}`;

	try {
		const response = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "models/gemini-embedding-001",
				content: { parts: [{ text: queryText }] },
			}),
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const data = await response.json();
		return new Float32Array(data.embedding.values);
	} catch (error) {
		console.error(
			"[speciesDb] Failed to fetch query embedding from Gemini:",
			error,
		);
		return null;
	}
}

/** Vector Semantic Similarity Search (Hybrid sqlite-vec / JS) */
export async function searchSpeciesVector(
	queryText: string,
	limit: number = 6,
): Promise<SpeciesRecord[]> {
	try {
		const queryEmbedding = await getQueryEmbedding(queryText);
		if (!queryEmbedding) {
			console.warn(
				"[speciesDb] Could not get search query embedding. Falling back to textual SQL LIKE search.",
			);
			return searchTextFallback(queryText, limit);
		}

		const db = await getDatabase();

		if (isSqliteVecAvailable) {
			// 1. Native Vector Search Path (sqlite-vec JSI)
			const queryBuffer = new Uint8Array(
				queryEmbedding.buffer,
				queryEmbedding.byteOffset,
				queryEmbedding.byteLength,
			);
			const rows = db.getAllSync<{
				id: number;
				region: string;
				common: string;
				latin: string;
				bloom_months: string;
				blurb: string;
				distance: number;
			}>(
				`
        SELECT s.id, s.region, s.common, s.latin, s.bloom_months, s.blurb, v.distance 
        FROM vec_species v
        JOIN species s ON v.id = s.id
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
      `,
				[queryBuffer, limit],
			);

			return rows.map((r) => ({
				id: r.id,
				region: r.region,
				common: r.common,
				latin: r.latin,
				bloomMonths: JSON.parse(r.bloom_months),
				blurb: r.blurb,
				similarity: 1.0 - r.distance, // Cosine distance to cosine similarity
			}));
		} else {
			// 2. High-performance JS Fallback Path (Zero native overhead)
			const rows = db.getAllSync<{
				id: number;
				region: string;
				common: string;
				latin: string;
				bloom_months: string;
				blurb: string;
				embedding: Uint8Array;
			}>(
				"SELECT id, region, common, latin, bloom_months, blurb, embedding FROM species",
			);

			const matches: SpeciesRecord[] = [];
			const queryLen = queryEmbedding.length;

			for (const row of rows) {
				// Read raw Float32 data from the BLOB Uint8Array
				const speciesVec = new Float32Array(
					row.embedding.buffer,
					row.embedding.byteOffset,
					row.embedding.byteLength / 4,
				);

				// Dot product calculation (vectors are already normalized by Gemini)
				let similarity = 0;
				for (let i = 0; i < queryLen; i++) {
					similarity += queryEmbedding[i] * speciesVec[i];
				}

				matches.push({
					id: row.id,
					region: row.region,
					common: row.common,
					latin: row.latin,
					bloomMonths: JSON.parse(row.bloom_months),
					blurb: row.blurb,
					similarity,
				});
			}

			// Sort by similarity descending
			matches.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0));
			return matches.slice(0, limit);
		}
	} catch (error) {
		console.error("[speciesDb] Vector search failed:", error);
		return searchTextFallback(queryText, limit);
	}
}

/** Simple SQL LIKE text-search fallback if completely offline and query embedding fails */
async function searchTextFallback(
	queryText: string,
	limit: number,
): Promise<SpeciesRecord[]> {
	try {
		const db = await getDatabase();
		const cleanQuery = `%${queryText}%`;
		const rows = db.getAllSync<{
			id: number;
			region: string;
			common: string;
			latin: string;
			bloom_months: string;
			blurb: string;
		}>(
			`
      SELECT id, region, common, latin, bloom_months, blurb 
      FROM species 
      WHERE common LIKE ? OR latin LIKE ? OR blurb LIKE ? OR region LIKE ?
      LIMIT ?
    `,
			[cleanQuery, cleanQuery, cleanQuery, cleanQuery, limit],
		);

		return rows.map((r) => ({
			id: r.id,
			region: r.region,
			common: r.common,
			latin: r.latin,
			bloomMonths: JSON.parse(r.bloom_months),
			blurb: r.blurb,
			similarity: 0.5, // Default placeholder similarity
		}));
	} catch (e) {
		console.error("[speciesDb] Text fallback search failed:", e);
		return [];
	}
}
