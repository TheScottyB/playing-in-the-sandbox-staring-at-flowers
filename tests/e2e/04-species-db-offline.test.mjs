import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
	listFilesRecursive,
	readRepoFile,
	readRepoJson,
	repoPath,
	runCli,
} from "./helpers/repo.mjs";
import { createE2EContext } from "./helpers/rn-loader.mjs";
import { runScriptInSandbox } from "./helpers/sandbox.mjs";

function normRecord(rec) {
	if (!rec) return null;
	return {
		...rec,
		bloom_months: rec.bloom_months ?? rec.bloomMonths,
		score: rec.score ?? rec.similarity,
	};
}

describe("04 — Offline Species DB, 3072-Dim Vectors & Search (Items 10, 11, 12, 13)", () => {
	// =========================================================================
	// Item 10: SQLite 3072-Dim Standardization
	// =========================================================================

	test("T1-I10-01: assets/species.db has 396 rows across 112 regions with 12288-byte (3072-dim) blobs", () => {
		const db = new DatabaseSync(repoPath("assets/species.db"), {
			readOnly: true,
		});
		try {
			const stats = db
				.prepare(
					"SELECT count(*) as total, count(DISTINCT region) as regions, min(length(embedding)) as minLen, max(length(embedding)) as maxLen FROM species;",
				)
				.get();
			assert.equal(stats.total, 396);
			assert.equal(stats.regions, 112);
			assert.equal(stats.minLen, 12288);
			assert.equal(stats.maxLen, 12288);
		} finally {
			db.close();
		}
	});

	test("T1-I10-02: lib/speciesDb.ts defines vec_species with float[3072] (never float[768])", () => {
		const src = readRepoFile("lib/speciesDb.ts");
		assert.equal(src.includes("float[768]"), false);
		assert.ok(
			/float\[3072\]/.test(src) ||
				(/EMBEDDING_DIM\s*=\s*3072/.test(src) &&
					/float\[\$\{EMBEDDING_DIM\}\]/.test(src)),
			"lib/speciesDb.ts must configure vec_species with 3072-dim float vectors",
		);
	});

	test("T1-I10-03: scripts/compile_species_db.mjs uses 3072 dimensions (never 768)", () => {
		const src = readRepoFile("scripts/compile_species_db.mjs");
		assert.equal(src.includes("Float32Array(768)"), false);
		assert.ok(
			/Float32Array\(3072\)/.test(src) ||
				(/EMBEDDING_DIM\s*=\s*3072/.test(src) &&
					/Float32Array\(EMBEDDING_DIM\)/.test(src)),
			"compile_species_db.mjs must use 3072-dim Float32Array vectors",
		);
	});

	test("T1-I10-04: scripts/db-smoke.mjs passes on assets/species.db verifying 12288 bytes", () => {
		const res = runCli("node", ["scripts/db-smoke.mjs"]);
		assert.equal(res.status, 0, res.stderr || res.stdout);
		assert.match(res.stdout, /396 species/);
		assert.match(
			res.stdout,
			/3072-dim \(12288-byte\)|3072 dimensions, 12288 bytes/,
		);
	});

	test("T1-I10-05: assets/species.db row count and regions match lib/data/species.json", () => {
		const json = readRepoJson("lib/data/species.json");
		const jsonRegions = Object.keys(json).length;
		const jsonCount = Object.values(json).reduce(
			(sum, arr) => sum + arr.length,
			0,
		);
		const db = new DatabaseSync(repoPath("assets/species.db"), {
			readOnly: true,
		});
		try {
			const row = db
				.prepare(
					"SELECT count(*) as c, count(DISTINCT region) as r FROM species;",
				)
				.get();
			assert.equal(row.c, jsonCount);
			assert.equal(row.r, jsonRegions);
		} finally {
			db.close();
		}
	});

	test("T2-I10-06: every single row in assets/species.db has valid JSON bloom_months and non-null embedding", () => {
		const db = new DatabaseSync(repoPath("assets/species.db"), {
			readOnly: true,
		});
		try {
			const rows = db
				.prepare(
					"SELECT id, bloom_months, length(embedding) as len FROM species;",
				)
				.all();
			assert.equal(rows.length, 396);
			for (const r of rows) {
				assert.equal(r.len, 12288, `Row ${r.id} embedding != 12288 bytes`);
				const months = JSON.parse(r.bloom_months);
				assert.ok(Array.isArray(months) && months.length > 0);
			}
		} finally {
			db.close();
		}
	});

	test("T2-I10-07: scripts/db-smoke.mjs checks min/max embedding length or all-row consistency", () => {
		const src = readRepoFile("scripts/db-smoke.mjs");
		assert.match(src, /12288/);
		assert.match(src, /length\(embedding\)/);
	});

	test("T2-I10-08: lib/speciesDb.ts handles native sqlite-vec v0.1 mock returning 3072-dim DDL", async () => {
		const ctx = createE2EContext({ sqliteVecVersion: "0.1.6" });
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const initFn = dbMod.initSpeciesDb ?? dbMod.getDatabase;
			const db = await initFn();
			assert.ok(db);
			const src = readRepoFile("lib/speciesDb.ts");
			assert.ok(
				/float\[3072\]/.test(src) ||
					(/EMBEDDING_DIM\s*=\s*3072/.test(src) &&
						/float\[\$\{EMBEDDING_DIM\}\]/.test(src)),
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I10-09: lib/speciesDb.ts exports standardized SpeciesRecord and initSpeciesDb/searchSpecies contracts", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			assert.equal(
				typeof dbMod.initSpeciesDb,
				"function",
				"lib/speciesDb.ts must export initSpeciesDb per PROJECT.md",
			);
			assert.equal(
				typeof dbMod.searchSpecies,
				"function",
				"lib/speciesDb.ts must export searchSpecies per PROJECT.md",
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I10-10: assets/species.db idx_species_region index exists for fast regional lookup", () => {
		const db = new DatabaseSync(repoPath("assets/species.db"), {
			readOnly: true,
		});
		try {
			const idx = db
				.prepare(
					"SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='species';",
				)
				.all();
			assert.ok(idx.some((r) => r.name === "idx_species_region"));
		} finally {
			db.close();
		}
	});

	// =========================================================================
	// Item 11: 100% Offline Species Search (Zero Client Gemini Key)
	// =========================================================================

	test("T1-I11-01: lib/speciesDb.ts contains zero EXPO_PUBLIC_GEMINI_API_KEY or Gemini API calls", () => {
		const src = readRepoFile("lib/speciesDb.ts");
		assert.equal(src.includes("EXPO_PUBLIC_GEMINI_API_KEY"), false);
		assert.equal(src.includes("generativelanguage.googleapis.com"), false);
		assert.equal(src.includes("embedContent"), false);
	});

	test("T1-I11-02: zero files under app/, lib/, shared/ reference EXPO_PUBLIC_GEMINI_API_KEY", () => {
		const files = [
			...listFilesRecursive("app", (r) => /\.(ts|tsx)$/.test(r)),
			...listFilesRecursive("lib", (r) => /\.(ts|tsx)$/.test(r)),
			...listFilesRecursive("shared", (r) => /\.(ts|tsx)$/.test(r)),
		];
		for (const rel of files) {
			assert.equal(
				readRepoFile(rel).includes("EXPO_PUBLIC_GEMINI_API_KEY"),
				false,
				`${rel} must not reference EXPO_PUBLIC_GEMINI_API_KEY`,
			);
		}
	});

	test("T1-I11-03: searchSpecies('poppy') executes 100% offline with 0 fetch calls and returns poppy matches", async () => {
		const ctx = createE2EContext({
			env: { EXPO_PUBLIC_GEMINI_API_KEY: "should_never_be_used" },
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const results = (await searchFn("poppy")).map(normRecord);
			assert.equal(
				ctx.fetchCalls.length,
				0,
				"Offline species search must make 0 outbound fetch calls",
			);
			assert.ok(results.length >= 1, "Should find poppy matches");
			assert.ok(
				results.some(
					(r) => /poppy/i.test(r.common) || /papaver/i.test(r.latin),
				),
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I11-04: multi-word botanical query ('desert cactus') returns ranked matches offline", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const results = (await searchFn("desert cactus")).map(normRecord);
			assert.equal(ctx.fetchCalls.length, 0);
			assert.ok(
				results.length >= 1,
				"Tokenized/FTS5 search for 'desert cactus' must match cactus/desert species even when exact substring fails",
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I11-05: getDailyFlowerOffline selects seasonal regional flower and falls back to 'default'", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const ca = await dbMod.getDailyFlowerOffline("CA", "2026-05-23");
			assert.ok(ca);
			assert.equal(ca.region, "CA");
			const fallback = await dbMod.getDailyFlowerOffline(
				"ZZ-NONEXISTENT",
				"2026-08-15",
			);
			assert.ok(
				fallback,
				"getDailyFlowerOffline must fall back to 'default' when requested region has 0 rows",
			);
			assert.equal(fallback.region, "default");
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I11-06: searchSpecies uses SQLite FTS5/BM25 virtual table or tokenized scoring", () => {
		const src = readRepoFile("lib/speciesDb.ts");
		assert.match(
			src,
			/fts5|bm25|species_fts/i,
			"lib/speciesDb.ts must use SQLite FTS5/BM25 for offline search",
		);
	});

	test("T2-I11-07: adversarial FTS5/SQL syntax inputs never throw errors", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const tricky = [
				'"unclosed quote',
				"poppy*",
				"AND OR NOT NEAR",
				"cactus (desert)!",
				"red-poppy",
				"'; DROP TABLE species; --",
			];
			for (const q of tricky) {
				const res = await searchFn(q);
				assert.ok(
					Array.isArray(res),
					`Query ${JSON.stringify(q)} must return an array cleanly`,
				);
			}
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I11-08: empty, whitespace, and 1-char queries return empty array safely", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			assert.deepEqual(await searchFn(""), []);
			assert.deepEqual(await searchFn("   "), []);
			const oneChar = await searchFn("a");
			assert.deepEqual(oneChar, []);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I11-09: overly long query (2000 chars) is clamped/guarded safely without throwing", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const longQuery = `${"poppy ".repeat(350)}end`;
			const res = await searchFn(longQuery);
			assert.ok(Array.isArray(res));
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I11-10: searchSpecies respects explicit limit parameter", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const res = await searchFn("flower", 2);
			assert.ok(res.length <= 2);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I11-11: Latin name and prefix queries match species offline", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const res = await searchFn("Eschscholzia");
			assert.ok(res.some((r) => r.common === "California Poppy"));
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I11-12: empty blurb across all 396 DB rows never crashes search or offline daily", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const res = await searchFn("rose");
			for (const r of res) {
				assert.equal(typeof r.blurb, "string");
			}
			const daily = await dbMod.getDailyFlowerOffline("NY", "2026-06-10");
			assert.ok(daily);
			assert.equal(typeof daily.blurb, "string");
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Item 12: DB Upgrade Versioning, Init Lock & Web Fallback
	// =========================================================================

	test("T1-I12-01: concurrent initSpeciesDb/query calls execute asset copy & open only once", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const initFn = dbMod.initSpeciesDb ?? dbMod.getDatabase;
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const [db1, db2, count, res] = await Promise.all([
				initFn(),
				initFn(),
				dbMod.getSpeciesCount(),
				searchFn("poppy"),
			]);
			assert.ok(db1);
			assert.equal(db1, db2);
			assert.equal(count, 396);
			assert.ok(res.length >= 1);
			assert.equal(
				ctx.fs.counters.copyCalls,
				1,
				"Concurrent cold-start callers must copy species.db only once via dbInitPromise lock",
			);
			assert.equal(ctx.assetCounters.downloadCalls, 1);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I12-02: production DB_VERSION upgrade refreshes pre-existing stale species.db", async () => {
		const ctx = createE2EContext({
			dev: false,
			initialStorage: { species_db_version: "1" },
		});
		try {
			// Pre-populate stale empty species.db with PRAGMA user_version = 2
			// so AsyncStorage species_db_version mismatch triggers upgrade independently
			const stalePath = `${ctx.fs.documentDirectory}SQLite/species.db`;
			mkdirSync(dirname(stalePath), { recursive: true });
			const staleDb = new DatabaseSync(stalePath);
			staleDb.exec(
				"CREATE TABLE species (id INTEGER PRIMARY KEY, region TEXT, common TEXT, latin TEXT, bloom_months TEXT, blurb TEXT, embedding BLOB); PRAGMA user_version = 2;",
			);
			staleDb.close();

			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const count = await dbMod.getSpeciesCount();
			assert.equal(
				ctx.fs.counters.copyCalls,
				1,
				"Production AsyncStorage species_db_version mismatch must trigger re-copying bundled species.db",
			);
			assert.equal(count, 396);
			assert.equal(ctx.asyncStorage.get("species_db_version"), "2");
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I12-03: production steady-state skips redundant re-copy once DB_VERSION matches", async () => {
		const sharedDocDir = `${mkdtempSync(join(tmpdir(), "flowers-doc-"))}/`;
		try {
			let savedStorage;
			const ctx1 = createE2EContext({
				dev: false,
				documentDirectory: sharedDocDir,
			});
			try {
				const dbMod1 = await ctx1.importFresh("lib/speciesDb.ts");
				assert.equal(await dbMod1.getSpeciesCount(), 396);
				assert.equal(ctx1.fs.counters.copyCalls, 1);
				savedStorage = Object.fromEntries(ctx1.asyncStorage.entries());
				assert.equal(savedStorage.species_db_version, "2");
			} finally {
				ctx1.cleanup();
			}

			// Simulate second app launch in same docDir with existing DB & matching version
			const ctx2 = createE2EContext({
				dev: false,
				documentDirectory: sharedDocDir,
				initialStorage: savedStorage,
			});
			try {
				const dbMod2 = await ctx2.importFresh("lib/speciesDb.ts");
				assert.equal(await dbMod2.getSpeciesCount(), 396);
				assert.equal(ctx2.fs.counters.copyCalls, 0);
			} finally {
				ctx2.cleanup();
			}
		} finally {
			rmSync(sharedDocDir, { recursive: true, force: true });
		}
	});

	test("T1-I12-04: Web platform (documentDirectory === null) returns null from initSpeciesDb without throwing", async () => {
		const ctx = createE2EContext({
			platform: "web",
			documentDirectory: null,
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const initFn = dbMod.initSpeciesDb ?? dbMod.getDatabase;
			const db = await initFn();
			assert.equal(db, null);
			assert.equal(ctx.fs.counters.makeDirCalls, 0);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I12-05: Web fallback resolves getSpeciesCount, searchSpecies, and getDailyFlowerOffline from species.json", async () => {
		const ctx = createE2EContext({
			platform: "web",
			documentDirectory: null,
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			assert.equal(await dbMod.getSpeciesCount(), 396);
			const results = await searchFn("camellia");
			assert.ok(results.length >= 1);
			assert.ok(results.some((r) => /camellia/i.test(r.common)));
			const daily = await dbMod.getDailyFlowerOffline("AL", "2026-02-15");
			assert.ok(daily);
			assert.equal(daily.region, "AL");
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I12-06: failed init resets dbInitPromise lock so a subsequent retry succeeds", async () => {
		const ctx = createE2EContext({
			assetDownloadError: new Error("Transient asset error"),
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const initFn = dbMod.initSpeciesDb ?? dbMod.getDatabase;
			await assert.rejects(() => initFn());
			// Clear error and retry — must not stay wedged on rejected promise
			ctx.assetCounters.downloadCalls = 0;
			const origAsset = globalThis.__E2E_MOCKS__.assetFromModule;
			globalThis.__E2E_MOCKS__.assetFromModule = (m) => ({
				...origAsset(m),
				async downloadAsync() {
					ctx.assetCounters.downloadCalls += 1;
				},
			});
			const db = await initFn();
			assert.ok(db);
			assert.equal(await dbMod.getSpeciesCount(), 396);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I12-07: Web fallback getDailyFlowerOffline with unknown region falls back to 'default'", async () => {
		const ctx = createE2EContext({
			platform: "web",
			documentDirectory: null,
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const daily = await dbMod.getDailyFlowerOffline(
				"ZZ-MISSING",
				"2026-07-01",
			);
			assert.ok(daily);
			assert.equal(daily.region, "default");
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I12-08: Web fallback searchSpecies handles empty and adversarial queries safely", async () => {
		const ctx = createE2EContext({
			platform: "web",
			documentDirectory: null,
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			assert.deepEqual(await searchFn(""), []);
			assert.deepEqual(await searchFn("   "), []);
			const res = await searchFn('("poppy")*');
			assert.ok(Array.isArray(res));
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I12-09: native platform with null documentDirectory falls back safely to in-memory catalog", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			documentDirectory: null,
		});
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			assert.equal(await dbMod.getSpeciesCount(), 396);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I12-10: lib/speciesDb.ts defines DB_VERSION and dbInitPromise lock", () => {
		const src = readRepoFile("lib/speciesDb.ts");
		assert.match(src, /DB_VERSION/);
		assert.match(src, /dbInitPromise/);
	});

	// =========================================================================
	// Item 13: compile_species_db.mjs HTTP 429 Retry Fix
	// =========================================================================

	test("T1-I13-01: compile_species_db.mjs compiles 396-row 3072-dim DB offline without GEMINI_API_KEY", () => {
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			copyFiles: ["lib/data/species.json"],
			unsetEnv: ["GEMINI_API_KEY"],
			inspect: (projectRoot) => {
				const dbPath = join(projectRoot, "assets", "species.db");
				assert.equal(existsSync(dbPath), true, "species.db must be created");
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					const row = db
						.prepare(
							"SELECT count(*) as c, min(length(embedding)) as minL, max(length(embedding)) as maxL FROM species;",
						)
						.get();
					return row;
				} finally {
					db.close();
				}
			},
		});
		assert.equal(res.status, 0, res.stderr || res.stdout);
		assert.equal(res.inspectResult.c, 396);
		assert.equal(res.inspectResult.minL, 12288);
		assert.equal(res.inspectResult.maxL, 12288);
	});

	test("T1-I13-02: compile_species_db.mjs retries HTTP 429 with backoff before succeeding on attempt 3", () => {
		const miniSpecies = JSON.stringify({
			CA: [
				{
					common: "California Poppy",
					latin: "Eschscholzia californica",
					bloomMonths: [3, 4, 5],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			env: { GEMINI_API_KEY: "test_key_429" },
			fastTimers: true,
			preloadCode: `
				let calls = 0;
				const vec = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
				globalThis.fetch = async () => {
					calls += 1;
					if (calls <= 2) {
						return new Response(JSON.stringify({ error: { message: "Rate limit 429" } }), { status: 429 });
					}
					return new Response(JSON.stringify({ embedding: { values: vec } }), { status: 200 });
				};
				process.on("exit", () => console.log("E2E_FETCH_CALLS=" + calls));
			`,
			inspect: (projectRoot) => {
				const dbPath = join(projectRoot, "assets", "species.db");
				const db = new DatabaseSync(dbPath, { readOnly: true });
				try {
					return db
						.prepare(
							"SELECT count(*) as c, min(length(embedding)) as len FROM species;",
						)
						.get();
				} finally {
					db.close();
				}
			},
		});
		assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
		assert.match(res.stdout, /E2E_FETCH_CALLS=3/);
		assert.equal(res.inspectResult.c, 1);
		assert.equal(res.inspectResult.len, 12288);
	});

	test("T1-I13-03: compile_species_db.mjs cleans up scratch/species_dump.sql after compilation", () => {
		const miniSpecies = JSON.stringify({
			CA: [
				{
					common: "California Poppy",
					latin: "Eschscholzia californica",
					bloomMonths: [3, 4, 5],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			unsetEnv: ["GEMINI_API_KEY"],
			inspect: (projectRoot) => ({
				dumpExists: existsSync(
					join(projectRoot, "scratch", "species_dump.sql"),
				),
			}),
		});
		assert.equal(res.status, 0);
		assert.equal(res.inspectResult.dumpExists, false);
	});

	test("T1-I13-04: compile_species_db.mjs encodes bloom_months JSON and escapes SQL single quotes", () => {
		const miniSpecies = JSON.stringify({
			CA: [
				{
					common: "Miner's Lettuce",
					latin: "Claytonia perfoliata",
					bloomMonths: [2, 3, 4],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			unsetEnv: ["GEMINI_API_KEY"],
			inspect: (projectRoot) => {
				const db = new DatabaseSync(join(projectRoot, "assets", "species.db"), {
					readOnly: true,
				});
				try {
					return db.prepare("SELECT common, bloom_months FROM species;").get();
				} finally {
					db.close();
				}
			},
		});
		assert.equal(res.status, 0);
		assert.equal(res.inspectResult.common, "Miner's Lettuce");
		assert.deepEqual(JSON.parse(res.inspectResult.bloom_months), [2, 3, 4]);
	});

	test("T1-I13-05: compile_species_db.mjs passes Biome lint and formatting check", () => {
		const res = runCli("pnpm", [
			"exec",
			"biome",
			"check",
			"scripts/compile_species_db.mjs",
		]);
		assert.equal(res.status, 0, res.stderr || res.stdout);
	});

	test("T2-I13-06: compile_species_db.mjs persistent HTTP 429 retries maxAttempts before fallback/abort", () => {
		const miniSpecies = JSON.stringify({
			CA: [
				{
					common: "California Poppy",
					latin: "Eschscholzia californica",
					bloomMonths: [4, 5],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			env: { GEMINI_API_KEY: "test_key_429_all" },
			fastTimers: true,
			preloadCode: `
				let calls = 0;
				globalThis.fetch = async () => {
					calls += 1;
					return new Response(JSON.stringify({ error: { message: "Too Many Requests" } }), { status: 429 });
				};
				process.on("exit", () => console.log("E2E_FETCH_CALLS=" + calls));
			`,
		});
		const match = res.stdout.match(/E2E_FETCH_CALLS=(\d+)/);
		assert.ok(match, `Expected E2E_FETCH_CALLS in stdout, got:\n${res.stdout}`);
		assert.ok(
			Number(match[1]) >= 3,
			`HTTP 429 must retry before failing/falling back, only saw ${match[1]} attempt(s)`,
		);
	});

	test("T2-I13-07: compile_species_db.mjs retries transient HTTP 503 and succeeds on retry", () => {
		const miniSpecies = JSON.stringify({
			TX: [
				{
					common: "Bluebonnet",
					latin: "Lupinus texensis",
					bloomMonths: [3, 4],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			env: { GEMINI_API_KEY: "test_key_503" },
			fastTimers: true,
			preloadCode: `
				let calls = 0;
				const vec = Array.from({ length: 3072 }, (_, i) => (i === 0 ? 1 : 0));
				globalThis.fetch = async () => {
					calls += 1;
					if (calls === 1) return new Response("Service Unavailable", { status: 503 });
					return new Response(JSON.stringify({ embedding: { values: vec } }), { status: 200 });
				};
				process.on("exit", () => console.log("E2E_FETCH_CALLS=" + calls));
			`,
		});
		assert.equal(res.status, 0);
		assert.match(res.stdout, /E2E_FETCH_CALLS=2/);
	});

	test("T2-I13-08: compile_species_db.mjs terminal billing error ('prepayment credits') aborts promptly", () => {
		const miniSpecies = JSON.stringify({
			CA: [
				{
					common: "California Poppy",
					latin: "Eschscholzia californica",
					bloomMonths: [4, 5],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			env: { GEMINI_API_KEY: "test_key_billing" },
			fastTimers: true,
			preloadCode: `
				globalThis.fetch = async () => new Response(
					JSON.stringify({ error: { message: "Please add prepayment credits", status: "FAILED_PRECONDITION" } }),
					{ status: 400 },
				);
			`,
		});
		assert.equal(res.status, 1);
	});

	test("T2-I13-09: compile_species_db.mjs writes unit-norm 3072-dim fallback vector on network error", () => {
		const miniSpecies = JSON.stringify({
			CA: [
				{
					common: "California Poppy",
					latin: "Eschscholzia californica",
					bloomMonths: [4, 5],
				},
			],
		});
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: { "lib/data/species.json": miniSpecies },
			env: { GEMINI_API_KEY: "test_key_net_err" },
			fastTimers: true,
			preloadCode: `
				globalThis.fetch = async () => { throw new TypeError("socket hang up"); };
			`,
			inspect: (projectRoot) => {
				const db = new DatabaseSync(join(projectRoot, "assets", "species.db"), {
					readOnly: true,
				});
				try {
					const row = db.prepare("SELECT embedding FROM species;").get();
					const f = new Float32Array(
						row.embedding.buffer,
						row.embedding.byteOffset,
						row.embedding.byteLength / 4,
					);
					return { dims: f.length, first: f[0] };
				} finally {
					db.close();
				}
			},
		});
		assert.equal(res.status, 0);
		assert.equal(res.inspectResult.dims, 3072);
		assert.equal(res.inspectResult.first, 1);
	});

	test("T2-I13-10: compile_species_db.mjs handles undefined species blurb cleanly", () => {
		const src = readRepoFile("lib/data/species.json");
		const parsed = JSON.parse(src);
		const first = Object.values(parsed)[0][0];
		assert.equal(first.blurb, undefined);
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			seedFiles: {
				"lib/data/species.json": JSON.stringify({ CA: [first] }),
			},
			unsetEnv: ["GEMINI_API_KEY"],
		});
		assert.equal(res.status, 0);
	});

	// =========================================================================
	// Tier 3: Pairwise Cross-Feature Integration
	// =========================================================================

	test("T3-04-01: compile_species_db.mjs -> db-smoke.mjs pipeline produces valid 3072-dim DB", () => {
		const res = runScriptInSandbox("scripts/compile_species_db.mjs", {
			copyFiles: ["lib/data/species.json", "scripts/db-smoke.mjs"],
			unsetEnv: ["GEMINI_API_KEY"],
			inspect: (projectRoot) => {
				const smoke = runCli("node", ["scripts/db-smoke.mjs"], {
					cwd: projectRoot,
				});
				return smoke;
			},
		});
		assert.equal(res.status, 0);
		assert.equal(
			res.inspectResult.status,
			0,
			res.inspectResult.stderr || res.inspectResult.stdout,
		);
		assert.match(
			res.inspectResult.stdout,
			/3072-dim \(12288-byte\)|3072 dimensions, 12288 bytes/,
		);
	});

	test("T3-04-02: Native SQLite DB vs Web in-memory fallback return consistent species count and matches", async () => {
		let nativeCount;
		let nPoppy;
		const ctxNative = createE2EContext({ platform: "ios" });
		try {
			const nativeDb = await ctxNative.importFresh("lib/speciesDb.ts");
			nativeCount = await nativeDb.getSpeciesCount();
			const nSearch = nativeDb.searchSpecies ?? nativeDb.searchSpeciesVector;
			nPoppy = await nSearch("poppy", 20);
		} finally {
			ctxNative.cleanup();
		}

		let webCount;
		let wPoppy;
		const ctxWeb = createE2EContext({
			platform: "web",
			documentDirectory: null,
		});
		try {
			const webDb = await ctxWeb.importFresh("lib/speciesDb.ts");
			webCount = await webDb.getSpeciesCount();
			const wSearch = webDb.searchSpecies ?? webDb.searchSpeciesVector;
			wPoppy = await wSearch("poppy", 20);
		} finally {
			ctxWeb.cleanup();
		}

		assert.equal(nativeCount, webCount);
		assert.ok(nPoppy.length >= 1 && wPoppy.length >= 1);
		assert.equal(
			nPoppy.some((r) => r.common === "California Poppy"),
			true,
		);
		assert.equal(
			wPoppy.some((r) => r.common === "California Poppy"),
			true,
		);
	});

	test("T3-04-03: getDailyFlowerOffline('MX-MEX', date) + searchSpecies('cactus') work together 100% offline", async () => {
		const ctx = createE2EContext();
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const daily = await dbMod.getDailyFlowerOffline("MX-MEX", "2026-06-15");
			assert.ok(daily);
			assert.equal(daily.region, "MX-MEX");
			const results = await searchFn("cactus");
			assert.ok(results.length >= 1);
			assert.equal(ctx.fetchCalls.length, 0);
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-04-04: Production DB upgrade + concurrent searchSpecies calls resolve cleanly without lock deadlock", async () => {
		const ctx = createE2EContext({
			dev: false,
			initialStorage: { species_db_version: "0" },
		});
		try {
			const stalePath = `${ctx.fs.documentDirectory}SQLite/species.db`;
			mkdirSync(dirname(stalePath), { recursive: true });
			const stale = new DatabaseSync(stalePath);
			stale.exec(
				"CREATE TABLE species (id INTEGER PRIMARY KEY, region TEXT, common TEXT, latin TEXT, bloom_months TEXT, blurb TEXT, embedding BLOB);",
			);
			stale.close();

			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const [r1, r2, count] = await Promise.all([
				searchFn("poppy"),
				searchFn("rose"),
				dbMod.getSpeciesCount(),
			]);
			assert.equal(count, 396);
			assert.ok(r1.length >= 1 && r2.length >= 1);
			assert.equal(ctx.fs.counters.copyCalls, 1);
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-04-05: Quota enforcement + offline searchSpecies never touches Gemini API key", async () => {
		const ctx = createE2EContext({
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "true",
				EXPO_PUBLIC_GEMINI_API_KEY: "do_not_call",
			},
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			assert.equal(await prem.getSearchQuotaRemaining(), 3);
			const res = await searchFn("poppy");
			assert.ok(res.length >= 1);
			assert.equal(await prem.incrementSearchQuotaUsed(), 2);
			assert.equal(ctx.fetchCalls.length, 0);
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Tier 4: Real-World E2E Scenarios
	// =========================================================================

	test("T4-04-01: Full real assets/species.db cold-start -> offline FTS5/BM25 search -> daily offline fallback E2E", async () => {
		const ctx = createE2EContext({ platform: "ios", dev: false });
		try {
			const dbMod = await ctx.importFresh("lib/speciesDb.ts");
			assert.equal(typeof dbMod.initSpeciesDb, "function");
			assert.equal(typeof dbMod.searchSpecies, "function");

			await dbMod.initSpeciesDb();
			assert.equal(await dbMod.getSpeciesCount(), 396);

			const poppyHits = await dbMod.searchSpecies("California Poppy");
			assert.ok(poppyHits.length >= 1);
			assert.equal(poppyHits[0].common, "California Poppy");
			assert.ok(
				Array.isArray(poppyHits[0].bloom_months ?? poppyHits[0].bloomMonths),
			);

			const vibeHits = await dbMod.searchSpecies("desert cactus");
			assert.ok(vibeHits.length >= 1);

			const fallbackDaily = await dbMod.getDailyFlowerOffline(
				"UNKNOWN-REGION",
				"2026-08-25",
			);
			assert.ok(fallbackDaily);
			assert.equal(fallbackDaily.region, "default");
			assert.equal(ctx.fetchCalls.length, 0);
		} finally {
			ctx.cleanup();
		}
	});

	test("T4-04-02: Full concurrency + DB_VERSION upgrade + Web documentDirectory null fallback E2E", async () => {
		// Phase 1: Concurrent prod upgrade over pre-existing DB
		const ctxProd = createE2EContext({
			platform: "ios",
			dev: false,
			initialStorage: { species_db_version: "1" },
		});
		try {
			const stalePath = `${ctxProd.fs.documentDirectory}SQLite/species.db`;
			mkdirSync(dirname(stalePath), { recursive: true });
			const stale = new DatabaseSync(stalePath);
			stale.exec(
				"CREATE TABLE species (id INTEGER PRIMARY KEY, region TEXT, common TEXT, latin TEXT, bloom_months TEXT, blurb TEXT, embedding BLOB); PRAGMA user_version = 2;",
			);
			stale.close();

			const dbMod = await ctxProd.importFresh("lib/speciesDb.ts");
			const initFn = dbMod.initSpeciesDb ?? dbMod.getDatabase;
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			const [a, b, hits] = await Promise.all([
				initFn(),
				initFn(),
				searchFn("lavender"),
			]);
			assert.ok(a && a === b);
			assert.ok(Array.isArray(hits));
			assert.equal(ctxProd.fs.counters.copyCalls, 1);
		} finally {
			ctxProd.cleanup();
		}

		// Phase 2: Web fallback
		const ctxWeb = createE2EContext({
			platform: "web",
			documentDirectory: null,
		});
		try {
			const dbMod = await ctxWeb.importFresh("lib/speciesDb.ts");
			const initFn = dbMod.initSpeciesDb ?? dbMod.getDatabase;
			const searchFn = dbMod.searchSpecies ?? dbMod.searchSpeciesVector;
			assert.equal(await initFn(), null);
			assert.equal(await dbMod.getSpeciesCount(), 396);
			const cam = await searchFn("camellia");
			assert.ok(cam.length >= 1);
		} finally {
			ctxWeb.cleanup();
		}
	});
});
