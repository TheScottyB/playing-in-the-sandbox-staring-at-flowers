import AsyncStorage from "@react-native-async-storage/async-storage";
import { Asset } from "expo-asset";
import * as FileSystem from "expo-file-system/legacy";
import * as SQLite from "expo-sqlite";
import { Platform } from "react-native";
import speciesCatalog from "./data/species.json";

export interface SpeciesRecord {
	id: number;
	region: string;
	common: string;
	latin: string;
	bloomMonths: number[];
	blurb: string;
	similarity?: number;
}

export const EMBEDDING_DIM = 3072;
export const DB_VERSION = 2;
export const DB_VERSION_KEY = "species_db_version";
export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_TOKENS = 16;

interface SpeciesRow {
	id: number;
	region: string;
	common: string;
	latin: string;
	bloom_months: string;
	blurb: string;
}

interface RawCatalogEntry {
	common: string;
	latin: string;
	bloomMonths: number[];
	blurb?: string;
}

interface SearchableMetadata {
	regionText: string;
	traits: string;
	combinedText: string;
}

const MONTH_NAMES = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

const GRAMMAR_STOP_WORDS = new Set([
	"a",
	"an",
	"the",
	"in",
	"on",
	"at",
	"of",
	"with",
	"and",
	"or",
	"not",
	"near",
	"for",
	"to",
	"from",
	"by",
	"is",
	"are",
	"like",
	"that",
	"this",
]);

const STOP_WORDS = new Set([
	...GRAMMAR_STOP_WORDS,
	"bloom",
	"blooms",
	"blooming",
	"flower",
	"flowers",
	"flowering",
	"plant",
	"plants",
	"species",
]);

const QUERY_SYNONYMS: Record<string, string[]> = {
	fall: ["autumn"],
	autumn: ["fall"],
	purple: ["violet", "lavender", "lilac", "indigo", "mauve", "magenta"],
	violet: ["purple", "lavender"],
	lavender: ["purple", "lilac", "violet"],
	lilac: ["purple", "lavender"],
	yellow: ["gold", "golden", "amber"],
	gold: ["yellow", "golden"],
	golden: ["yellow", "gold"],
	red: ["scarlet", "crimson", "coral", "ruby"],
	scarlet: ["red", "crimson"],
	crimson: ["red", "scarlet"],
	pink: ["rose", "blush", "magenta"],
	rose: ["pink"],
	white: ["ivory", "snow", "cream"],
	blue: ["azure", "cobalt", "indigo"],
	orange: ["amber", "flame", "tangerine"],
	desert: ["arid", "cactus", "succulent", "sonoran", "mojave", "southwest"],
	cactus: ["desert", "succulent", "arid"],
	succulent: ["desert", "cactus", "arid"],
	tropical: ["island", "rainforest", "jungle", "subtropical"],
	alpine: ["mountain", "arctic", "tundra", "highland"],
	arctic: ["tundra", "alpine", "polar", "northern"],
	tundra: ["arctic", "alpine"],
	mountain: ["alpine", "highland", "rocky"],
	swamp: ["marsh", "wetland", "bog", "aquatic", "water"],
	marsh: ["swamp", "wetland", "bog"],
	wetland: ["swamp", "marsh", "bog", "aquatic"],
	prairie: ["meadow", "plains", "grassland", "wildflower"],
	meadow: ["prairie", "wildflower"],
	woodland: ["forest", "shade", "woods"],
	forest: ["woodland", "woods"],
};

const REGION_METADATA: Record<string, string> = {
	// US States + DC
	AL: "Alabama southeast south woodland",
	AK: "Alaska arctic tundra subarctic alpine northern",
	AZ: "Arizona desert southwest sonoran arid cactus",
	AR: "Arkansas south ozark woodland",
	CA: "California west coast pacific coastal chaparral",
	CO: "Colorado rocky mountain alpine highland",
	CT: "Connecticut new england northeast woodland",
	DE: "Delaware mid atlantic coastal",
	FL: "Florida subtropical tropical coastal swamp wetland",
	GA: "Georgia southeast south woodland",
	HI: "Hawaii tropical island pacific volcanic",
	ID: "Idaho northwest mountain rocky alpine",
	IL: "Illinois midwest prairie plains",
	IN: "Indiana midwest woodland",
	IA: "Iowa midwest prairie plains",
	KS: "Kansas great plains prairie meadow",
	KY: "Kentucky south appalachian meadow",
	LA: "Louisiana gulf south bayou swamp wetland",
	ME: "Maine new england northeast northern coast",
	MD: "Maryland mid atlantic chesapeake",
	MA: "Massachusetts new england northeast coast",
	MI: "Michigan great lakes midwest woodland",
	MN: "Minnesota northwoods midwest lakes prairie",
	MS: "Mississippi gulf south wetland",
	MO: "Missouri ozark midwest prairie",
	MT: "Montana rocky mountain big sky alpine",
	NE: "Nebraska great plains prairie",
	NV: "Nevada desert great basin mojave arid",
	NH: "New Hampshire new england white mountains",
	NJ: "New Jersey mid atlantic pine barrens",
	NM: "New Mexico desert southwest high desert arid",
	NY: "New York northeast appalachian woodland",
	NC: "North Carolina appalachian southeast coastal",
	ND: "North Dakota great plains prairie",
	OH: "Ohio midwest woodland",
	OK: "Oklahoma plains prairie",
	OR: "Oregon pacific northwest cascade coastal",
	PA: "Pennsylvania northeast appalachian woodland",
	RI: "Rhode Island new england coastal",
	SC: "South Carolina southeast lowcountry coastal",
	SD: "South Dakota great plains prairie black hills",
	TN: "Tennessee appalachian south woodland",
	TX: "Texas south prairie desert hill country",
	UT: "Utah desert canyon mountain arid",
	VT: "Vermont new england green mountains",
	VA: "Virginia appalachian blue ridge woodland",
	WA: "Washington pacific northwest cascade",
	WV: "West Virginia appalachian mountain woodland",
	WI: "Wisconsin midwest great lakes woodland",
	WY: "Wyoming rocky mountain yellowstone alpine",
	DC: "District of Columbia Washington DC capital",
	// Canada
	"CA-AB": "Alberta Canada rocky mountain prairie",
	"CA-BC": "British Columbia Canada pacific northwest mountain",
	"CA-MB": "Manitoba Canada prairie boreal",
	"CA-NB": "New Brunswick Canada maritime atlantic",
	"CA-NL": "Newfoundland Labrador Canada atlantic boreal",
	"CA-NS": "Nova Scotia Canada maritime atlantic",
	"CA-ON": "Ontario Canada great lakes woodland",
	"CA-PE": "Prince Edward Island Canada maritime",
	"CA-QC": "Quebec Canada boreal laurentian",
	"CA-SK": "Saskatchewan Canada prairie plains",
	"CA-NT": "Northwest Territories Canada arctic subarctic tundra",
	"CA-NU": "Nunavut Canada arctic tundra polar",
	"CA-YT": "Yukon Canada subarctic mountain alpine",
	// Iceland
	IS: "Iceland nordic arctic subarctic volcanic island",
	// Russia
	"RU-MOW": "Moscow Russia eastern europe temperate",
	"RU-SPE": "Saint Petersburg Russia northern europe boreal",
	"RU-SIB": "Siberia Russia boreal taiga arctic alpine",
	"RU-URA": "Urals Russia mountain temperate",
	"RU-FE": "Russian Far East Kamchatka pacific",
	// China
	"CN-GD": "Guangdong China subtropical southern",
	"CN-SC": "Sichuan China mountain highland",
	"CN-BJ": "Beijing China northern temperate",
	"CN-ZJ": "Zhejiang China eastern temperate",
	"CN-XZ": "Tibet Xizang China himalaya alpine highland",
	// Mexico
	"MX-MEX": "Central Mexico highland plateau",
	"MX-JAL": "Jalisco Mexico western tropical",
	"MX-NLE": "Nuevo Leon Mexico northern desert arid",
	"MX-OAX": "Oaxaca Mexico southern mountain tropical",
	"MX-YUC": "Yucatan Peninsula Mexico tropical coastal",
	// Brazil
	"BR-SP": "Sao Paulo Brazil atlantic forest subtropical",
	"BR-AM": "Amazonas Brazil amazon rainforest tropical",
	"BR-BA": "Bahia Brazil caatinga tropical coastal",
	"BR-RS": "Rio Grande do Sul Brazil pampas grassland",
	// Central & South America
	GTM: "Guatemala central america tropical cloud forest",
	BLZ: "Belize central america tropical rainforest",
	SLV: "El Salvador central america tropical",
	HND: "Honduras central america tropical",
	NIC: "Nicaragua central america tropical",
	CRI: "Costa Rica central america tropical rainforest",
	PAN: "Panama central america tropical rainforest",
	COL: "Colombia south america andes tropical",
	VEN: "Venezuela south america tropical",
	GUY: "Guyana south america amazon tropical",
	SUR: "Suriname south america amazon tropical",
	ECU: "Ecuador south america andes tropical",
	PER: "Peru south america andes mountain",
	BOL: "Bolivia south america andes highland",
	PRY: "Paraguay south america subtropical",
	CHL: "Chile south america andes patagonia",
	URY: "Uruguay south america pampas temperate",
	ARG: "Argentina south america patagonia pampas",
	// Europe
	"EU-NORTH": "Northern Europe scandinavia nordic",
	"EU-WEST": "Western Europe temperate meadow",
	"EU-EAST": "Eastern Europe temperate meadow",
	"EU-SOUTH": "Southern Europe mediterranean",
	// Africa
	"AF-NORTH": "North Africa mediterranean arid",
	"AF-SOUTH": "Southern Africa fynbos savanna",
	"AF-EAST": "East Africa savanna tropical",
	"AF-WEST": "West Africa tropical savanna",
	"AF-CENTRAL": "Central Africa rainforest tropical",
	// Global default
	default: "global wildflower fallback",
};

interface TaxonRule {
	match: RegExp;
	traits: string;
}

const TAXON_RULES: TaxonRule[] = [
	// Poppies
	{
		match: /eschscholzia|california poppy/i,
		traits: "poppy orange gold yellow wildflower coastal",
	},
	{
		match: /papaver radicatum|arctic poppy/i,
		traits: "poppy yellow white arctic tundra alpine",
	},
	{
		match: /papaver rhoeas|corn poppy/i,
		traits: "poppy red scarlet wildflower meadow",
	},
	{
		match: /romneya|matilija poppy/i,
		traits: "poppy white yellow chaparral wildflower",
	},
	{
		match: /kallstroemia|arizona poppy/i,
		traits: "poppy orange yellow desert arid wildflower",
	},
	{
		match: /meconopsis|blue poppy|tibetan poppy/i,
		traits: "poppy blue purple alpine mountain himalayan",
	},
	// Yellow / Gold / Desert / Autumn stars
	{
		match: /baileya|desert marigold/i,
		traits: "yellow gold desert arid wildflower cactus zone",
	},
	{
		match: /tagetes|marigold/i,
		traits: "yellow gold orange autumn fall",
	},
	{
		match: /solidago|goldenrod/i,
		traits: "yellow gold autumn fall prairie meadow wildflower",
	},
	{
		match: /rudbeckia|black-eyed susan|coneflower/i,
		traits: "yellow gold prairie meadow wildflower",
	},
	{
		match: /echinacea/i,
		traits: "purple pink prairie meadow wildflower",
	},
	{
		match: /helianthus|tithonia|sunflower/i,
		traits: "yellow gold orange autumn prairie wildflower",
	},
	{
		match: /tecoma stans|yellow elder|yellow trumpet/i,
		traits: "yellow gold autumn winter tropical",
	},
	{
		match:
			/handroanthus albus|handroanthus chrysanthus|ipê-amarelo|yellow poui/i,
		traits: "yellow gold tree blossom tropical",
	},
	{
		match: /acacia|golden wattle/i,
		traits: "yellow gold autumn fragrant tree",
	},
	{
		match: /hibiscus brackenridgei/i,
		traits: "yellow gold tropical island hibiscus",
	},
	{
		match: /hibiscus rosa-sinensis|hibiscus/i,
		traits: "tropical island red pink yellow hibiscus",
	},
	{
		match: /hibiscus moscheutos|swamp rose mallow|rose mallow/i,
		traits: "pink white swamp marsh wetland",
	},
	{
		match: /gelsemium|yellow jessamine/i,
		traits: "yellow fragrant vine woodland",
	},
	{
		match: /sarracenia flava|yellow pitcher/i,
		traits: "yellow wetland bog swamp",
	},
	{
		match: /coreopsis|tickseed/i,
		traits: "yellow gold wildflower meadow",
	},
	{
		match: /caltha|marsh marigold/i,
		traits: "yellow gold wetland marsh",
	},
	{
		match: /erythronium|glacier lily|trout lily/i,
		traits: "yellow alpine woodland",
	},
	{
		match: /trollius|globe flower/i,
		traits: "yellow orange meadow alpine",
	},
	{
		match: /adonis amurensis|amur adonis/i,
		traits: "yellow gold early woodland",
	},
	{
		match: /mahonia|oregon grape/i,
		traits: "yellow woodland evergreen",
	},
	{
		match: /allamanda|golden trumpet/i,
		traits: "yellow gold tropical vine",
	},
	{
		match: /osmanthus/i,
		traits: "yellow white fragrant autumn",
	},
	{
		match: /chrysanthemum/i,
		traits: "yellow white pink autumn fall",
	},
	{
		match: /alstroemeria aurea|peruvian lily/i,
		traits: "yellow orange mountain",
	},
	{
		match: /calceolaria/i,
		traits: "yellow gold mountain",
	},
	{
		match: /strelitzia|bird of paradise/i,
		traits: "orange blue yellow tropical",
	},
	// Purple / Violet / Blue species
	{
		match: /pulsatilla|pasqueflower|prairie crocus/i,
		traits: "purple violet lavender prairie wildflower",
	},
	{
		match: /syringa|lilac/i,
		traits: "purple lavender lilac fragrant shrub",
	},
	{
		match: /viola|violet|pansy/i,
		traits: "purple violet blue woodland wildflower",
	},
	{
		match: /streptocarpus|african violet/i,
		traits: "purple violet blue tropical",
	},
	{
		match: /lavandula|lavender/i,
		traits: "purple violet fragrant mediterranean herb",
	},
	{
		match: /iris/i,
		traits: "purple blue violet wetland meadow",
	},
	{
		match: /lupinus|lupine|bluebonnet/i,
		traits: "blue purple indigo prairie meadow wildflower",
	},
	{
		match: /baptisia|wild indigo/i,
		traits: "blue purple indigo prairie wildflower",
	},
	{
		match: /trillium erectum|purple trillium/i,
		traits: "purple burgundy woodland",
	},
	{
		match: /trillium grandiflorum|trillium/i,
		traits: "white pink woodland",
	},
	{
		match: /mertensia|bluebells/i,
		traits: "blue purple pink woodland",
	},
	{
		match: /myosotis|forget-me-not/i,
		traits: "blue alpine wildflower",
	},
	{
		match: /centaurea|cornflower/i,
		traits: "blue purple meadow wildflower",
	},
	{
		match: /gentiana|gentian/i,
		traits: "blue purple alpine mountain",
	},
	{
		match: /jacaranda/i,
		traits: "purple violet blue tree tropical",
	},
	{
		match: /guarianthe|guaria morada/i,
		traits: "purple violet magenta orchid tropical",
	},
	{
		match: /cattleya violacea|violet orchid/i,
		traits: "purple violet orchid tropical",
	},
	{
		match: /saxifraga oppositifolia|purple saxifrage/i,
		traits: "purple pink arctic alpine tundra",
	},
	{
		match: /salvia patens|blue sage/i,
		traits: "blue purple sage",
	},
	{
		match: /monarda|bergamot/i,
		traits: "purple lavender pink prairie wildflower",
	},
	{
		match: /liatris|blazing star/i,
		traits: "purple violet prairie wildflower",
	},
	{
		match: /tradescantia|spiderwort/i,
		traits: "blue purple violet prairie",
	},
	{
		match: /phlox/i,
		traits: "purple blue pink woodland prairie",
	},
	{
		match: /passiflora|passionflower|passion flower|mburucuy/i,
		traits: "purple blue white tropical vine",
	},
	{
		match: /tibouchina/i,
		traits: "purple violet tropical",
	},
	{
		match: /heliotropium|heliotrope/i,
		traits: "purple violet fragrant",
	},
	{
		match: /calluna|heather/i,
		traits: "purple pink moorland highland",
	},
	{
		match: /nymphaea|blue lotus/i,
		traits: "blue water lily aquatic",
	},
	{
		match: /petunia/i,
		traits: "purple pink wildflower",
	},
	{
		match: /glandularia|verbena/i,
		traits: "purple pink red prairie wildflower",
	},
	{
		match: /aquilegia coerulea|columbine/i,
		traits: "blue purple white alpine mountain",
	},
	{
		match: /aquilegia canadensis/i,
		traits: "red yellow woodland",
	},
	// Desert & Cacti
	{
		match: /carnegiea|saguaro/i,
		traits: "desert cactus succulent white night-blooming arid",
	},
	{
		match: /opuntia|prickly pear/i,
		traits: "desert cactus succulent yellow arid",
	},
	{
		match: /echinocereus|claret cup/i,
		traits: "desert cactus succulent red scarlet arid",
	},
	{
		match: /cereus|mandacaru/i,
		traits: "desert cactus succulent white arid",
	},
	{
		match: /yucca/i,
		traits: "desert arid white cream succulent",
	},
	{
		match: /agave/i,
		traits: "desert arid succulent",
	},
	{
		match: /artemisia|sagebrush/i,
		traits: "desert arid shrub silver",
	},
	{
		match: /chilopsis|desert willow/i,
		traits: "desert arid pink purple",
	},
	{
		match: /leucophyllum|texas sage/i,
		traits: "desert arid purple pink",
	},
	{
		match: /adenium|desert rose/i,
		traits: "desert arid pink red succulent",
	},
	{
		match: /castilleja|indian paintbrush|desert paintbrush/i,
		traits: "red orange scarlet prairie desert wildflower",
	},
	// Reds, Pinks, Whites & Tropicals
	{
		match: /lobelia cardinalis|cardinal flower/i,
		traits: "red scarlet wetland",
	},
	{
		match: /gaillardia|indian blanket/i,
		traits: "red orange yellow prairie wildflower",
	},
	{
		match: /rosa|rose/i,
		traits: "pink red white fragrant wildflower",
	},
	{
		match: /camellia/i,
		traits: "pink red white winter evergreen",
	},
	{
		match: /magnolia/i,
		traits: "white cream fragrant tree",
	},
	{
		match: /cornus|dogwood|bunchberry/i,
		traits: "white pink woodland tree",
	},
	{
		match: /prunus|cherry|peach|apple|plum/i,
		traits: "pink white blossom tree",
	},
	{
		match: /rhododendron|azalea|rhodora/i,
		traits: "pink purple orange woodland mountain",
	},
	{
		match: /lilium|lily/i,
		traits: "orange yellow white pink meadow wetland",
	},
	{
		match: /leontopodium|edelweiss/i,
		traits: "white alpine mountain",
	},
	{
		match: /galanthus|snowdrop/i,
		traits: "white winter early woodland",
	},
	{
		match: /nelumbo|victoria|water lily|lotus/i,
		traits: "pink white aquatic water wetland",
	},
	{
		match: /plumeria|frangipani|sacuanjoche/i,
		traits: "white yellow pink fragrant tropical",
	},
	{
		match: /heliconia|lobster claw/i,
		traits: "red orange yellow tropical rainforest",
	},
	{
		match: /bougainvillea/i,
		traits: "magenta pink purple tropical",
	},
	{
		match: /anthurium|ixora|alpinia|delonix|poinciana|spathodea/i,
		traits: "red orange tropical rainforest",
	},
	{
		match:
			/orchid|cattleya|lycaste|peristeria|rhyncholaelia|laelia|masdevallia|eulophia|prosthechea|chloraea|platanthera|cypriped/i,
		traits: "orchid tropical woodland",
	},
];

let dbInstance: SQLite.SQLiteDatabase | null = null;
let dbInitPromise: Promise<SQLite.SQLiteDatabase | null> | null = null;
let isSqliteVecAvailable = false;

/** Safe 4-byte aligned Float32Array decoder for raw SQLite BLOB Uint8Arrays */
export function decodeEmbeddingBlob(blob: Uint8Array): Float32Array {
	if (!blob || blob.byteLength === 0 || blob.byteLength % 4 !== 0) {
		return new Float32Array(0);
	}
	if (blob.byteOffset % 4 === 0) {
		return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
	}
	const aligned = new Uint8Array(blob.byteLength);
	aligned.set(blob);
	return new Float32Array(aligned.buffer);
}

/** Cosine similarity with defensive length, zero-norm, and non-finite guards */
export function cosineSimilarity(
	a: ArrayLike<number>,
	b: ArrayLike<number>,
): number {
	if (!a || !b || a.length === 0 || a.length !== b.length) {
		return 0;
	}
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const va = a[i];
		const vb = b[i];
		if (!Number.isFinite(va) || !Number.isFinite(vb)) {
			return 0;
		}
		dot += va * vb;
		normA += va * va;
		normB += vb * vb;
	}
	if (normA === 0 || normB === 0) {
		return 0;
	}
	const result = dot / (Math.sqrt(normA) * Math.sqrt(normB));
	return Number.isFinite(result) ? result : 0;
}

function getSeasonAndMonthKeywords(bloomMonths: number[]): string {
	const tokens = new Set<string>();
	for (const month of bloomMonths) {
		if (month >= 1 && month <= 12) {
			tokens.add(MONTH_NAMES[month - 1]);
			if (month === 12 || month <= 2) {
				tokens.add("winter");
			} else if (month <= 5) {
				tokens.add("spring");
			} else if (month <= 8) {
				tokens.add("summer");
			} else {
				tokens.add("autumn");
				tokens.add("fall");
			}
		}
	}
	if (bloomMonths.length >= 12) {
		tokens.add("year-round");
		tokens.add("evergreen");
		tokens.add("perennial");
	}
	return Array.from(tokens).join(" ");
}

/** Build deterministic botanical, geographic, and seasonal search metadata */
export function buildSearchableMetadata(
	record: Pick<
		SpeciesRecord,
		"region" | "common" | "latin" | "bloomMonths" | "blurb"
	>,
): SearchableMetadata {
	const regionText = [record.region, REGION_METADATA[record.region] ?? ""]
		.filter(Boolean)
		.join(" ");

	const traitParts: string[] = [getSeasonAndMonthKeywords(record.bloomMonths)];
	const nameSignature = `${record.common} ${record.latin}`;

	for (const rule of TAXON_RULES) {
		if (rule.match.test(nameSignature)) {
			traitParts.push(rule.traits);
		}
	}

	if (record.blurb?.trim()) {
		traitParts.push(record.blurb.trim());
	}

	const traits = traitParts.filter(Boolean).join(" ");
	const combinedText = `${record.common} ${record.latin} ${regionText} ${traits}`;
	return { regionText, traits, combinedText };
}

function rowToSpeciesRecord(row: SpeciesRow): SpeciesRecord {
	let bloomMonths: number[] = [];
	try {
		const parsed = JSON.parse(row.bloom_months);
		if (Array.isArray(parsed)) {
			bloomMonths = parsed;
		}
	} catch {
		bloomMonths = [];
	}
	return {
		id: row.id,
		region: row.region,
		common: row.common,
		latin: row.latin,
		bloomMonths,
		blurb: row.blurb ?? "",
	};
}

let inMemoryCatalogCache: SpeciesRecord[] | null = null;

function getInMemoryCatalog(): SpeciesRecord[] {
	if (inMemoryCatalogCache) {
		return inMemoryCatalogCache;
	}
	const catalogData = speciesCatalog as Record<string, RawCatalogEntry[]>;
	const records: SpeciesRecord[] = [];
	let nextId = 1;
	for (const region of Object.keys(catalogData)) {
		const entries = catalogData[region] ?? [];
		for (const entry of entries) {
			records.push({
				id: nextId++,
				region,
				common: entry.common,
				latin: entry.latin,
				bloomMonths: Array.isArray(entry.bloomMonths) ? entry.bloomMonths : [],
				blurb: entry.blurb ?? "",
			});
		}
	}
	inMemoryCatalogCache = records;
	return records;
}

function normalizeSearchText(text: string): string {
	return text
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/['\u2018\u2019]/g, "")
		.toLowerCase();
}

/** Extract sanitized alphanumeric lowercase tokens safe for FTS5 & in-memory search */
export function sanitizeFtsTokens(queryText: string): string[] {
	const bounded = queryText.trim().slice(0, MAX_QUERY_CHARS);
	const rawTokens = normalizeSearchText(bounded).match(/[a-z0-9]+/g) ?? [];
	if (rawTokens.length === 0) return [];

	const contentTokens = rawTokens.filter((t) => !STOP_WORDS.has(t));
	const selected = contentTokens.length > 0 ? contentTokens : rawTokens;
	return Array.from(new Set(selected)).slice(0, MAX_QUERY_TOKENS);
}

/** Validate whether a user search query has searchable terms (>= 2 chars, non-punctuation, non-grammar-only) */
export function isSearchQueryEligible(queryText: string): boolean {
	const trimmed = queryText.trim();
	if (trimmed.length < 2) return false;
	const tokens = sanitizeFtsTokens(trimmed);
	if (tokens.length === 0) return false;
	return tokens.some((t) => !GRAMMAR_STOP_WORDS.has(t));
}

function expandFtsSearchTokens(tokens: string[]): string[] {
	const expanded = new Set<string>(tokens);
	for (const token of tokens) {
		const syns = QUERY_SYNONYMS[token];
		if (syns) {
			for (const syn of syns) {
				expanded.add(syn);
			}
		}
	}
	return Array.from(expanded);
}

function tokenizeField(text: string): string[] {
	return normalizeSearchText(text).match(/[a-z0-9]+/g) ?? [];
}

function scoreFieldForToken(fieldTokens: string[], token: string): number {
	let best = 0;
	for (const ft of fieldTokens) {
		if (ft === token) {
			return 1.0;
		}
		if (token.length >= 3 && ft.startsWith(token)) {
			best = Math.max(best, 0.75);
		} else if (token.length >= 4 && ft.includes(token)) {
			best = Math.max(best, 0.5);
		}
	}
	return best;
}

function scoreSpeciesRecord(
	record: SpeciesRecord,
	queryTokens: string[],
	rawLowerQuery: string,
	ftsRankBoost = 0,
): number {
	const meta = buildSearchableMetadata(record);
	const commonTokens = tokenizeField(record.common);
	const latinTokens = tokenizeField(record.latin);
	const regionTokens = tokenizeField(meta.regionText);
	const traitTokens = tokenizeField(meta.traits);
	const blurbTokens = tokenizeField(record.blurb);

	let totalWeightedScore = 0;
	let matchedConcepts = 0;
	let perConceptStrengthSum = 0;

	for (const token of queryTokens) {
		const candidates = [token, ...(QUERY_SYNONYMS[token] ?? [])];
		let bestForConcept = 0;

		for (let i = 0; i < candidates.length; i++) {
			const term = candidates[i];
			const synFactor = i === 0 ? 1.0 : 0.78;

			const commonHit =
				scoreFieldForToken(commonTokens, term) * 4.0 * synFactor;
			const latinHit = scoreFieldForToken(latinTokens, term) * 2.8 * synFactor;
			const regionHit =
				scoreFieldForToken(regionTokens, term) * 2.2 * synFactor;
			const traitHit = scoreFieldForToken(traitTokens, term) * 2.0 * synFactor;
			const blurbHit = scoreFieldForToken(blurbTokens, term) * 1.5 * synFactor;

			const candidateMax = Math.max(
				commonHit,
				latinHit,
				regionHit,
				traitHit,
				blurbHit,
			);
			const candidateCombined =
				candidateMax +
				(commonHit > 0 && traitHit > 0 ? 0.35 * synFactor : 0) +
				(regionHit > 0 && traitHit > 0 ? 0.25 * synFactor : 0);

			if (candidateCombined > bestForConcept) {
				bestForConcept = candidateCombined;
			}
		}

		if (bestForConcept > 0) {
			matchedConcepts++;
			totalWeightedScore += bestForConcept;
			perConceptStrengthSum += Math.min(1, bestForConcept / 3.5);
		}
	}

	if (matchedConcepts === 0) {
		return 0;
	}

	// Exact phrase bonus in common or latin name
	const commonLower = normalizeSearchText(record.common);
	const latinLower = normalizeSearchText(record.latin);
	let phraseBonus = 0;
	if (rawLowerQuery.length >= 3) {
		if (commonLower === rawLowerQuery) {
			phraseBonus = 2.0;
		} else if (commonLower.includes(rawLowerQuery)) {
			phraseBonus = 1.2;
		} else if (latinLower.includes(rawLowerQuery)) {
			phraseBonus = 0.8;
		}
	}

	const coverageRatio = matchedConcepts / queryTokens.length;
	const avgStrength = perConceptStrengthSum / queryTokens.length;
	const extraScoreBoost = Math.min(
		0.1,
		(totalWeightedScore + phraseBonus + ftsRankBoost) * 0.008,
	);

	// Normalized into (0.18, 0.99] so UI % match badges reflect multi-concept coverage
	const similarity =
		0.18 + 0.56 * coverageRatio + 0.16 * avgStrength + extraScoreBoost;

	return Math.min(0.99, Math.max(0.18, Number(similarity.toFixed(4))));
}

function rankRecords(
	records: SpeciesRecord[],
	queryText: string,
	limit: number,
	ftsBoostById?: Map<number, number>,
): SpeciesRecord[] {
	const queryTokens = sanitizeFtsTokens(queryText);
	if (queryTokens.length === 0 || limit <= 0) {
		return [];
	}
	const rawLowerQuery = normalizeSearchText(queryText.trim());

	const scored: SpeciesRecord[] = [];
	for (const record of records) {
		const boost = ftsBoostById?.get(record.id) ?? 0;
		const similarity = scoreSpeciesRecord(
			record,
			queryTokens,
			rawLowerQuery,
			boost,
		);
		if (similarity > 0) {
			scored.push({
				...record,
				similarity,
			});
		}
	}

	scored.sort((a, b) => {
		const diff = (b.similarity ?? 0) - (a.similarity ?? 0);
		if (Math.abs(diff) > 1e-6) return diff;
		return a.common.localeCompare(b.common) || a.id - b.id;
	});

	return scored.slice(0, limit);
}

/**
 * Concurrency-safe database initializer.
 * Returns null on Web or when FileSystem.documentDirectory is unavailable.
 */
export async function initSpeciesDb(): Promise<SQLite.SQLiteDatabase | null> {
	if (Platform.OS === "web") {
		return null;
	}
	const documentDirectory = FileSystem.documentDirectory;
	if (!documentDirectory) {
		return null;
	}
	if (dbInstance) {
		return dbInstance;
	}
	if (dbInitPromise) {
		return dbInitPromise;
	}

	let currentPromise: Promise<SQLite.SQLiteDatabase | null> | null = null;
	currentPromise = (async () => {
		// Defer past the synchronous `dbInitPromise = currentPromise` assignment so
		// a synchronous throw before the first real I/O await cannot run `finally`
		// before `dbInitPromise` is assigned.
		await Promise.resolve();

		try {
			if (dbInstance) {
				return dbInstance;
			}

			const dbName = "species.db";
			const dbDir = `${documentDirectory}SQLite`;
			const dbPath = `${dbDir}/${dbName}`;

			const dirInfo = await FileSystem.getInfoAsync(dbDir);
			if (!dirInfo.exists) {
				await FileSystem.makeDirectoryAsync(dbDir, { intermediates: true });
			}

			const fileInfo = await FileSystem.getInfoAsync(dbPath);
			const storedVersion = await AsyncStorage.getItem(DB_VERSION_KEY);
			let needsCopy =
				__DEV__ || !fileInfo.exists || storedVersion !== String(DB_VERSION);

			let db: SQLite.SQLiteDatabase | null = null;
			let currentUserVersion = 0;

			if (!needsCopy) {
				let checkDb: SQLite.SQLiteDatabase | null = null;
				try {
					checkDb = await SQLite.openDatabaseAsync(dbName);
					const verRow = await checkDb.getFirstAsync<{ user_version: number }>(
						"PRAGMA user_version;",
					);
					currentUserVersion = verRow?.user_version ?? 0;
					if (currentUserVersion < DB_VERSION) {
						await checkDb.closeAsync().catch(() => {});
						checkDb = null;
						needsCopy = true;
					} else {
						db = checkDb;
					}
				} catch (openErr) {
					console.warn(
						"[speciesDb] Existing database unreadable; re-copying bundled asset:",
						openErr,
					);
					await checkDb?.closeAsync().catch(() => {});
					db = null;
					needsCopy = true;
				}
			}

			if (needsCopy) {
				console.log(
					"[speciesDb] Copying species.db asset to local SQLite sandbox...",
				);
				for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
					await FileSystem.deleteAsync(path, { idempotent: true });
				}

				const asset = Asset.fromModule(require("../assets/species.db"));
				await asset.downloadAsync();

				if (!asset.localUri) {
					throw new Error("Failed to resolve asset localUri");
				}

				await FileSystem.copyAsync({
					from: asset.localUri,
					to: dbPath,
				});

				db = await SQLite.openDatabaseAsync(dbName);
			}

			if (!db) {
				throw new Error("Failed to open SQLite database");
			}
			const activeDb = db;

			try {
				// Initialize enriched FTS5 virtual table when FTS5 is available
				try {
					if (needsCopy) {
						await activeDb.execAsync(
							"DROP TABLE IF EXISTS species_search_fts;",
						);
					}
					await activeDb.execAsync(`
						CREATE VIRTUAL TABLE IF NOT EXISTS species_search_fts USING fts5(
							id UNINDEXED,
							common,
							latin,
							region_text,
							traits,
							tokenize='porter unicode61'
						);
					`);
					const baseCountRow = await activeDb.getFirstAsync<{ count: number }>(
						"SELECT count(*) as count FROM species;",
					);
					const ftsCountRow = await activeDb.getFirstAsync<{ count: number }>(
						"SELECT count(*) as count FROM species_search_fts;",
					);
					const baseCount = baseCountRow?.count ?? 0;
					const ftsCount = ftsCountRow?.count ?? 0;

					let needsFtsRebuild = baseCount > 0 && ftsCount !== baseCount;
					if (!needsFtsRebuild && baseCount > 0) {
						const staleAccentedRow = await activeDb.getFirstAsync<{
							id: number;
						}>(
							"SELECT id FROM species_search_fts WHERE common LIKE '%ê%' OR region_text LIKE '%ã%' LIMIT 1;",
						);
						if (staleAccentedRow) {
							needsFtsRebuild = true;
						}
					}

					if (needsFtsRebuild) {
						const allRows = await activeDb.getAllAsync<SpeciesRow>(
							"SELECT id, region, common, latin, bloom_months, blurb FROM species;",
						);
						await activeDb.withTransactionAsync(async () => {
							await activeDb.execAsync("DELETE FROM species_search_fts;");
							for (const row of allRows) {
								const record = rowToSpeciesRecord(row);
								const meta = buildSearchableMetadata(record);
								await activeDb.runAsync(
									"INSERT INTO species_search_fts (id, common, latin, region_text, traits) VALUES (?, ?, ?, ?, ?);",
									[
										record.id,
										normalizeSearchText(record.common),
										normalizeSearchText(record.latin),
										normalizeSearchText(meta.regionText),
										normalizeSearchText(meta.traits),
									],
								);
							}
						});
					}
				} catch (ftsErr) {
					console.warn(
						"[speciesDb] FTS5 unavailable; runtime search will use deterministic scoring fallback:",
						ftsErr,
					);
				}

				// Check for optional native sqlite-vec extension and enforce 3072-dim schema
				try {
					const vecVer = await activeDb.getFirstAsync<{ version: string }>(
						"SELECT vec_version() as version;",
					);
					if (vecVer?.version) {
						console.log(
							`[speciesDb] Native sqlite-vec detected (v${vecVer.version}).`,
						);
						isSqliteVecAvailable = true;

						const existingVecSql = await activeDb.getFirstAsync<{
							sql: string;
						}>(
							"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'vec_species';",
						);
						if (
							existingVecSql?.sql &&
							!existingVecSql.sql.includes(`float[${EMBEDDING_DIM}]`)
						) {
							await activeDb.execAsync("DROP TABLE IF EXISTS vec_species;");
						}

						await activeDb.execAsync(`
							CREATE VIRTUAL TABLE IF NOT EXISTS vec_species USING vec0(
								id INTEGER PRIMARY KEY,
								embedding float[${EMBEDDING_DIM}]
							);
						`);

						const vecCount = await activeDb.getFirstAsync<{ count: number }>(
							"SELECT count(*) as count FROM vec_species;",
						);
						const baseCount = await activeDb.getFirstAsync<{ count: number }>(
							"SELECT count(*) as count FROM species;",
						);
						if (vecCount && baseCount && vecCount.count !== baseCount.count) {
							await activeDb.execAsync("DELETE FROM vec_species;");
							await activeDb.execAsync(
								"INSERT INTO vec_species (id, embedding) SELECT id, embedding FROM species;",
							);
						}
					} else {
						isSqliteVecAvailable = false;
					}
				} catch {
					isSqliteVecAvailable = false;
				}

				if (needsCopy || currentUserVersion !== DB_VERSION) {
					await activeDb.execAsync(`PRAGMA user_version = ${DB_VERSION};`);
				}
				if (needsCopy || storedVersion !== String(DB_VERSION)) {
					await AsyncStorage.setItem(DB_VERSION_KEY, String(DB_VERSION));
				}

				dbInstance = activeDb;
				return activeDb;
			} catch (setupError) {
				await activeDb.closeAsync().catch(() => {});
				throw setupError;
			}
		} catch (error) {
			console.error("[speciesDb] Database initialization failed:", error);
			throw error;
		} finally {
			if (dbInitPromise === currentPromise) {
				dbInitPromise = null;
			}
		}
	})();

	dbInitPromise = currentPromise;
	return currentPromise;
}

/** Backwards-compatible alias for initSpeciesDb */
export async function getDatabase(): Promise<SQLite.SQLiteDatabase | null> {
	return initSpeciesDb();
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

	let hashVal = 0;
	const hashKey = `${state}:${date}`;
	for (let i = 0; i < hashKey.length; i++) {
		hashVal = (hashVal << 5) - hashVal + hashKey.charCodeAt(i);
		hashVal |= 0;
	}
	const idx = Math.abs(hashVal) % pool.length;
	return pool[idx];
}

/** Resolves the offline daily flower for a given region and date, falling back to "default" */
export async function getDailyFlowerOffline(
	region: string,
	date: string,
): Promise<SpeciesRecord | null> {
	try {
		const db = await initSpeciesDb();
		if (!db) {
			const catalog = getInMemoryCatalog();
			const regional = catalog.filter((s) => s.region === region);
			const resolvedRegion = regional.length > 0 ? region : "default";
			const list =
				regional.length > 0
					? regional
					: catalog.filter((s) => s.region === "default");
			if (list.length === 0) return null;
			return pickSpecies(list, resolvedRegion, date);
		}

		let resolvedRegion = region;
		let rows = await db.getAllAsync<SpeciesRow>(
			"SELECT id, region, common, latin, bloom_months, blurb FROM species WHERE region = ?;",
			[region],
		);

		if (rows.length === 0 && region !== "default") {
			resolvedRegion = "default";
			rows = await db.getAllAsync<SpeciesRow>(
				"SELECT id, region, common, latin, bloom_months, blurb FROM species WHERE region = 'default';",
			);
		}

		if (rows.length === 0) return null;

		const list = rows.map(rowToSpeciesRecord);
		return pickSpecies(list, resolvedRegion, date);
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
		const db = await initSpeciesDb();
		if (!db) {
			return getInMemoryCatalog().length;
		}
		const result = await db.getFirstAsync<{ count: number }>(
			"SELECT count(*) as count FROM species;",
		);
		return result?.count || 0;
	} catch (e) {
		console.error("[speciesDb] Failed to get species count:", e);
		return 0;
	}
}

/**
 * 100% offline botanical & FTS5 search.
 * Never reads client API keys or makes outbound network calls.
 */
export async function searchSpecies(
	queryText: string,
	limit = 6,
): Promise<SpeciesRecord[]> {
	const trimmed = queryText.trim();
	if (trimmed.length < 2 || limit <= 0) {
		return [];
	}

	const boundedQuery = trimmed.slice(0, MAX_QUERY_CHARS);
	const queryTokens = sanitizeFtsTokens(boundedQuery);
	if (queryTokens.length === 0) {
		return [];
	}

	try {
		const db = await initSpeciesDb();
		if (!db) {
			return rankRecords(getInMemoryCatalog(), boundedQuery, limit);
		}

		// Retrieve FTS5 BM25 scores without LIMIT 60 truncation, capped at 24 tokens
		let boostById: Map<number, number> | undefined;
		try {
			const expandedTokens = expandFtsSearchTokens(queryTokens).slice(0, 24);
			if (expandedTokens.length > 0) {
				const ftsMatchQuery = expandedTokens.map((t) => `"${t}"*`).join(" OR ");

				const ftsRows = await db.getAllAsync<{ id: number; ftsRank: number }>(
					`
					SELECT id,
						bm25(species_search_fts, 10.0, 6.0, 3.0, 2.0) AS ftsRank
					FROM species_search_fts
					WHERE species_search_fts MATCH ?;
				`,
					[ftsMatchQuery],
				);

				if (ftsRows.length > 0) {
					boostById = new Map<number, number>();
					for (const row of ftsRows) {
						boostById.set(
							row.id,
							Math.min(0.5, Math.max(0, -row.ftsRank) * 0.025),
						);
					}
				}
			}
		} catch (ftsErr) {
			console.warn(
				"[speciesDb] FTS5 query fallback to full-table deterministic scoring:",
				ftsErr,
			);
		}

		// Score full catalog so multi-concept substring matches are never dropped
		// by FTS5 prefix-only matching or candidate truncation.
		const allRows = await db.getAllAsync<SpeciesRow>(
			"SELECT id, region, common, latin, bloom_months, blurb FROM species;",
		);
		return rankRecords(
			allRows.map(rowToSpeciesRecord),
			boundedQuery,
			limit,
			boostById,
		);
	} catch (error) {
		console.error(
			"[speciesDb] Offline search failed; falling back to memory:",
			error,
		);
		return rankRecords(getInMemoryCatalog(), boundedQuery, limit);
	}
}

/** Backwards-compatible alias delegating to 100% offline searchSpecies */
export async function searchSpeciesVector(
	queryText: string,
	limit = 6,
): Promise<SpeciesRecord[]> {
	return searchSpecies(queryText, limit);
}

/** Expose whether optional sqlite-vec extension was detected (for diagnostics) */
export function getIsSqliteVecAvailable(): boolean {
	return isSqliteVecAvailable;
}
