import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EAS_APP_STORE_KIT_SPECIFIER =
	"../../eas-app-store-kit/src/index.mjs";

export async function loadAppStoreKit(specifier = EAS_APP_STORE_KIT_SPECIFIER) {
	try {
		return await import(specifier);
	} catch (err) {
		throw new Error(
			`Failed to load eas-app-store-kit from "${specifier}". Ensure the sibling eas-app-store-kit repository is checked out next to this repository: ${err.message}`,
		);
	}
}

export function validateCredentials(config) {
	const missing = [];
	if (!config?.keyId) missing.push("keyId (or APP_STORE_CONNECT_KEY_ID)");
	if (!config?.issuerId) {
		missing.push("issuerId (or APP_STORE_CONNECT_ISSUER_ID)");
	}
	if (!config?.privateKey) {
		missing.push(
			"privateKey/privateKeyPath (or APP_STORE_CONNECT_PRIVATE_KEY[_PATH])",
		);
	}
	if (!config?.appId) missing.push("appId (or APP_STORE_CONNECT_APP_ID)");

	if (missing.length > 0) {
		throw new Error(
			`Missing required App Store Connect credentials:\n- ${missing.join("\n- ")}`,
		);
	}
}

export async function paginateSubmissions(client, appId) {
	const items = [];
	const seenUrls = new Set();
	let currentPath = `/apps/${appId}/reviewSubmissions`;
	let currentQuery = {
		"fields[reviewSubmissions]": "platform,submittedDate,state",
		"filter[platform]": "IOS",
		limit: 50,
	};

	while (true) {
		const response = await client.request("GET", currentPath, {
			query: currentQuery,
		});
		if (!Array.isArray(response?.data)) {
			break;
		}
		items.push(...response.data);

		const nextHref = response?.links?.next;
		if (!nextHref || seenUrls.has(nextHref)) {
			break;
		}
		seenUrls.add(nextHref);

		const nextUrl = new URL(nextHref, "https://api.appstoreconnect.apple.com");
		currentPath = nextUrl.pathname.startsWith("/v1/")
			? nextUrl.pathname.slice(3)
			: nextUrl.pathname;
		currentQuery = Object.fromEntries(nextUrl.searchParams.entries());
	}

	return items;
}

export async function main(options = {}) {
	let client = options.client;
	let config = options.config;

	if (!client || !config) {
		const kit = await loadAppStoreKit(options.kitSpecifier);
		config =
			config ??
			(await kit.loadConfig({
				projectRoot: process.cwd(),
				argv: process.argv,
				env: process.env,
			}));
		validateCredentials(config);

		const key = kit.parsePrivateKey(config.privateKey);
		client =
			client ??
			new kit.AppStoreConnectClient({
				keyId: config.keyId,
				issuerId: config.issuerId,
				privateKey: key,
				dryRun: config.dryRun,
				verbose: true,
			});
	}

	const appId = config.appId;

	console.log("Fetching active review submissions...");
	const submissions = await paginateSubmissions(client, appId);
	console.log(`Found ${submissions.length} submissions.`);

	for (const sub of submissions) {
		console.log(`- ID: ${sub.id}, State: ${sub.attributes?.state}`);
		if (sub.attributes?.state === "READY_FOR_REVIEW") {
			console.log(`Deleting draft review submission ${sub.id}...`);
			try {
				await client.request("DELETE", `/reviewSubmissions/${sub.id}`);
				console.log("Successfully deleted draft review submission!");
			} catch (err) {
				console.error("Failed to delete review submission:", err.message);
			}
		}
	}
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
	main().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
