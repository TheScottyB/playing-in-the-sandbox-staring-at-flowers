import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Location from "expo-location";

const STORAGE_KEY = "region.state.v1";
const OVERRIDE_KEY = "region.override.v1";
const FALLBACK = "default";

export type RegionResult = {
	region: string;
	permissionDenied: boolean;
};

const US_STATE_CODES = new Set([
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

const LOWERCASE_STATE_CODES = new Set(
	Array.from(US_STATE_CODES).map((code) => code.toLowerCase()),
);

const STATE_NAME_TO_CODE: Record<string, string> = {
	Alabama: "AL",
	Alaska: "AK",
	Arizona: "AZ",
	Arkansas: "AR",
	California: "CA",
	Colorado: "CO",
	Connecticut: "CT",
	Delaware: "DE",
	Florida: "FL",
	Georgia: "GA",
	Hawaii: "HI",
	Idaho: "ID",
	Illinois: "IL",
	Indiana: "IN",
	Iowa: "IA",
	Kansas: "KS",
	Kentucky: "KY",
	Louisiana: "LA",
	Maine: "ME",
	Maryland: "MD",
	Massachusetts: "MA",
	Michigan: "MI",
	Minnesota: "MN",
	Mississippi: "MS",
	Missouri: "MO",
	Montana: "MT",
	Nebraska: "NE",
	Nevada: "NV",
	"New Hampshire": "NH",
	"New Jersey": "NJ",
	"New Mexico": "NM",
	"New York": "NY",
	"North Carolina": "NC",
	"North Dakota": "ND",
	Ohio: "OH",
	Oklahoma: "OK",
	Oregon: "OR",
	Pennsylvania: "PA",
	"Rhode Island": "RI",
	"South Carolina": "SC",
	"South Dakota": "SD",
	Tennessee: "TN",
	Texas: "TX",
	Utah: "UT",
	Vermont: "VT",
	Virginia: "VA",
	Washington: "WA",
	"West Virginia": "WV",
	Wisconsin: "WI",
	Wyoming: "WY",
	"District of Columbia": "DC",
};

const LOWERCASE_STATE_NAME_TO_CODE = Object.keys(STATE_NAME_TO_CODE).reduce(
	(acc, name) => {
		acc[name.toLowerCase()] = STATE_NAME_TO_CODE[name];
		return acc;
	},
	{} as Record<string, string>,
);

const CA_PROVINCE_CODES = new Set([
	"AB",
	"BC",
	"MB",
	"NB",
	"NL",
	"NS",
	"ON",
	"PE",
	"QC",
	"SK",
	"NT",
	"NU",
	"YT",
]);

const LOWERCASE_PROVINCE_CODES = new Set(
	Array.from(CA_PROVINCE_CODES).map((code) => code.toLowerCase()),
);

const PROVINCE_NAME_TO_CODE: Record<string, string> = {
	Alberta: "AB",
	"British Columbia": "BC",
	Manitoba: "MB",
	"New Brunswick": "NB",
	"Newfoundland and Labrador": "NL",
	"Nova Scotia": "NS",
	Ontario: "ON",
	"Prince Edward Island": "PE",
	Quebec: "QC",
	Saskatchewan: "SK",
	"Northwest Territories": "NT",
	Nunavut: "NU",
	Yukon: "YT",
};

const LOWERCASE_PROVINCE_NAME_TO_CODE = Object.keys(
	PROVINCE_NAME_TO_CODE,
).reduce(
	(acc, name) => {
		acc[name.toLowerCase()] = PROVINCE_NAME_TO_CODE[name];
		return acc;
	},
	{} as Record<string, string>,
);

let regionEpoch = 0;

export async function getRegion(): Promise<string> {
	const { region } = await getRegionWithStatus();
	return region;
}

export async function getRegionWithStatus(): Promise<RegionResult> {
	const epochAtStart = regionEpoch;
	const override = await AsyncStorage.getItem(OVERRIDE_KEY);
	if (override) {
		return { region: override, permissionDenied: false };
	}

	const cached = await AsyncStorage.getItem(STORAGE_KEY);
	const denied = await isPermissionDenied();

	if (cached) {
		if (cached === FALLBACK && !denied) {
			const result = await resolveRegion();
			if (epochAtStart !== regionEpoch) {
				return {
					region: (await getCachedRegion()) ?? FALLBACK,
					permissionDenied: await isPermissionDenied(),
				};
			}
			await AsyncStorage.setItem(STORAGE_KEY, result.region);
			return result;
		}
		return { region: cached, permissionDenied: cached === FALLBACK && denied };
	}

	const result = await resolveRegion();
	if (epochAtStart !== regionEpoch) {
		return {
			region: (await getCachedRegion()) ?? FALLBACK,
			permissionDenied: await isPermissionDenied(),
		};
	}
	await AsyncStorage.setItem(STORAGE_KEY, result.region);
	return result;
}

export async function setRegionOverride(region: string | null): Promise<void> {
	if (region === null) {
		await AsyncStorage.removeItem(OVERRIDE_KEY);
	} else {
		await AsyncStorage.setItem(OVERRIDE_KEY, region);
	}
}

export async function getRegionOverride(): Promise<string | null> {
	return await AsyncStorage.getItem(OVERRIDE_KEY);
}

async function isPermissionDenied(): Promise<boolean> {
	try {
		const { status } = await Location.getForegroundPermissionsAsync();
		return status !== "granted";
	} catch (error) {
		console.warn("Failed to get location permissions:", error);
		return true;
	}
}

async function resolveRegion(): Promise<RegionResult> {
	try {
		const { status } = await Location.requestForegroundPermissionsAsync();
		if (status !== "granted")
			return { region: FALLBACK, permissionDenied: true };

		const position = await Location.getCurrentPositionAsync({
			accuracy: Location.Accuracy.Lowest,
		});
		const places = await Location.reverseGeocodeAsync({
			latitude: position.coords.latitude,
			longitude: position.coords.longitude,
		});

		const place = places[0];
		if (!place) {
			return { region: FALLBACK, permissionDenied: false };
		}

		const countryCode = place.isoCountryCode?.toUpperCase();

		if (countryCode === "US") {
			if (!place.region) return { region: FALLBACK, permissionDenied: false };
			const code = stateNameToCode(place.region);
			return { region: code ?? FALLBACK, permissionDenied: false };
		}

		if (countryCode === "CA") {
			if (!place.region) return { region: FALLBACK, permissionDenied: false };
			const code = provinceNameToCode(place.region);
			return {
				region: code ? `CA-${code}` : FALLBACK,
				permissionDenied: false,
			};
		}

		if (countryCode === "MX") {
			return { region: resolveMXRegion(place.region), permissionDenied: false };
		}

		if (countryCode === "RU") {
			return { region: resolveRURegion(place.region), permissionDenied: false };
		}

		if (countryCode === "CN") {
			return { region: resolveCNRegion(place.region), permissionDenied: false };
		}

		if (countryCode === "BR") {
			return { region: resolveBRRegion(place.region), permissionDenied: false };
		}

		if (countryCode === "IS") {
			return { region: "IS", permissionDenied: false };
		}

		if (countryCode && COUNTRY_TO_REGION[countryCode]) {
			return {
				region: COUNTRY_TO_REGION[countryCode],
				permissionDenied: false,
			};
		}

		return { region: FALLBACK, permissionDenied: false };
	} catch (error) {
		console.warn("Failed to resolve region from location services:", error);
		return { region: FALLBACK, permissionDenied: false };
	}
}

function stateNameToCode(region: string): string | null {
	if (!region) return null;
	const cleaned = region
		.trim()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
	if (LOWERCASE_STATE_CODES.has(cleaned)) {
		return cleaned.toUpperCase();
	}
	return LOWERCASE_STATE_NAME_TO_CODE[cleaned] ?? null;
}

function provinceNameToCode(region: string): string | null {
	if (!region) return null;
	const cleaned = region
		.trim()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
	if (LOWERCASE_PROVINCE_CODES.has(cleaned)) {
		return cleaned.toUpperCase();
	}
	return LOWERCASE_PROVINCE_NAME_TO_CODE[cleaned] ?? null;
}

export async function getCachedRegion(): Promise<string | null> {
	return await AsyncStorage.getItem(STORAGE_KEY);
}

/** Test/debug helper — clears the cached region so the next call re-prompts. */
export async function resetRegion(): Promise<void> {
	regionEpoch += 1;
	await AsyncStorage.removeItem(STORAGE_KEY);
}

const COUNTRY_TO_REGION: Record<string, string> = {
	// Central America
	GT: "GTM",
	BZ: "BLZ",
	SV: "SLV",
	HN: "HND",
	NI: "NIC",
	CR: "CRI",
	PA: "PAN",
	// South America
	CO: "COL",
	VE: "VEN",
	GY: "GUY",
	SR: "SUR",
	EC: "ECU",
	PE: "PER",
	BO: "BOL",
	PY: "PRY",
	UY: "URY",
	CL: "CHL",
	AR: "ARG",
	// Europe North
	SE: "EU-NORTH",
	NO: "EU-NORTH",
	FI: "EU-NORTH",
	DK: "EU-NORTH",
	EE: "EU-NORTH",
	LV: "EU-NORTH",
	LT: "EU-NORTH",
	// Europe West
	GB: "EU-WEST",
	FR: "EU-WEST",
	DE: "EU-WEST",
	NL: "EU-WEST",
	BE: "EU-WEST",
	IE: "EU-WEST",
	LU: "EU-WEST",
	CH: "EU-WEST",
	AT: "EU-WEST",
	// Europe East
	PL: "EU-EAST",
	UA: "EU-EAST",
	RO: "EU-EAST",
	HU: "EU-EAST",
	CZ: "EU-EAST",
	SK: "EU-EAST",
	BG: "EU-EAST",
	BY: "EU-EAST",
	MD: "EU-EAST",
	// Europe South
	ES: "EU-SOUTH",
	IT: "EU-SOUTH",
	GR: "EU-SOUTH",
	PT: "EU-SOUTH",
	HR: "EU-SOUTH",
	RS: "EU-SOUTH",
	SI: "EU-SOUTH",
	BA: "EU-SOUTH",
	AL: "EU-SOUTH",
	// Africa North
	EG: "AF-NORTH",
	MA: "AF-NORTH",
	DZ: "AF-NORTH",
	TN: "AF-NORTH",
	LY: "AF-NORTH",
	// Africa South
	ZA: "AF-SOUTH",
	NA: "AF-SOUTH",
	BW: "AF-SOUTH",
	LS: "AF-SOUTH",
	SZ: "AF-SOUTH",
	// Africa East
	KE: "AF-EAST",
	TZ: "AF-EAST",
	UG: "AF-EAST",
	ET: "AF-EAST",
	MG: "AF-EAST",
	SO: "AF-EAST",
	// Africa West
	NG: "AF-WEST",
	GH: "AF-WEST",
	SN: "AF-WEST",
	CI: "AF-WEST",
	CM: "AF-WEST",
	// Africa Central
	CD: "AF-CENTRAL",
	CG: "AF-CENTRAL",
	GA: "AF-CENTRAL",
	AO: "AF-CENTRAL",
	CF: "AF-CENTRAL",
	TD: "AF-CENTRAL",
};

function normalizeRegionName(region: string): string {
	return region
		.trim()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase();
}

function resolveMXRegion(region?: string | null): string {
	if (!region) return "MX-MEX";
	const r = normalizeRegionName(region);
	if (r.includes("jalisco")) return "MX-JAL";
	if (r.includes("oaxaca")) return "MX-OAX";
	if (r.includes("nuevo leon")) return "MX-NLE";
	if (r.includes("yucatan")) return "MX-YUC";
	return "MX-MEX";
}

function resolveCNRegion(region?: string | null): string {
	if (!region) return "CN-BJ";
	const r = normalizeRegionName(region);
	if (r.includes("guangdong")) return "CN-GD";
	if (r.includes("sichuan")) return "CN-SC";
	if (r.includes("zhejiang")) return "CN-ZJ";
	if (r.includes("tibet") || r.includes("xizang")) return "CN-XZ";
	return "CN-BJ";
}

function resolveRURegion(region?: string | null): string {
	if (!region) return "RU-MOW";
	const r = normalizeRegionName(region);
	if (
		r.includes("moscow") ||
		r.includes("moskva") ||
		r.includes("vladimir") ||
		r.includes("yaroslavl")
	)
		return "RU-MOW";
	if (r.includes("peter") || r.includes("leningrad")) return "RU-SPE";
	if (
		r.includes("siberia") ||
		r.includes("novosibirsk") ||
		r.includes("irkutsk") ||
		r.includes("krasnoyarsk") ||
		r.includes("tomsk") ||
		r.includes("omsk") ||
		r.includes("altai")
	)
		return "RU-SIB";
	if (
		r.includes("ural") ||
		r.includes("sverdlovsk") ||
		r.includes("chelyabinsk")
	)
		return "RU-URA";
	if (
		r.includes("east") ||
		r.includes("primorsky") ||
		r.includes("khabarovsk") ||
		r.includes("kamchatka") ||
		r.includes("sakhalin") ||
		r.includes("yakut")
	)
		return "RU-FE";
	return "RU-MOW";
}

function resolveBRRegion(region?: string | null): string {
	if (!region) return "BR-SP";
	const r = normalizeRegionName(region);
	if (
		r.includes("sao paulo") ||
		r.includes("rio de janeiro") ||
		r.includes("minas") ||
		r.includes("espirito")
	)
		return "BR-SP";
	if (
		r.includes("bahia") ||
		r.includes("pernambuco") ||
		r.includes("ceara") ||
		r.includes("rio grande do norte") ||
		r.includes("paraiba") ||
		r.includes("alagoas") ||
		r.includes("sergipe") ||
		r.includes("piau") ||
		r.includes("maranhao")
	)
		return "BR-BA";
	if (
		r.includes("rio grande do sul") ||
		r.includes("santa catarina") ||
		r.includes("parana")
	)
		return "BR-RS";
	if (
		r.includes("amazon") ||
		/\bpara\b/.test(r) ||
		r.includes("acre") ||
		r.includes("roraima") ||
		r.includes("rondonia") ||
		r.includes("amapa") ||
		r.includes("tocantin")
	)
		return "BR-AM";
	return "BR-SP";
}
