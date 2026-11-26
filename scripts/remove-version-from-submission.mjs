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

	if (missing.length > 0) {
		throw new Error(
			`Missing required App Store Connect credentials:\n- ${missing.join("\n- ")}`,
		);
	}
}

export const KIT_VALUE_FLAGS = new Set([
	"--config",
	"--app-id",
	"--version",
	"--asc-build-id",
	"--build-id",
	"--release-type",
	"--wait-processing-minutes",
	"--poll-interval-seconds",
]);

function hasNodeScriptPrefix(argv) {
	if (!Array.isArray(argv) || argv.length < 2) return false;
	const first = String(argv[0] ?? "");
	return (
		first === "node" || first.endsWith("/node") || first.endsWith("node.exe")
	);
}

export function filterKitArgv(argv = process.argv) {
	if (!Array.isArray(argv)) return [];
	const prefix = hasNodeScriptPrefix(argv) ? argv.slice(0, 2) : [];
	const args = hasNodeScriptPrefix(argv) ? argv.slice(2) : argv;
	const filtered = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--submission-id") {
			if (i + 1 < args.length && !String(args[i + 1]).startsWith("-")) {
				i++;
			}
			continue;
		}
		if (String(arg).startsWith("--submission-id=")) {
			continue;
		}
		filtered.push(arg);
	}

	return [...prefix, ...filtered];
}

export function resolveSubmissionId(
	argv = process.argv.slice(2),
	env = process.env,
) {
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (KIT_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (arg === "--submission-id" && i + 1 < argv.length) {
			const val = argv[i + 1]?.trim();
			if (val && !val.startsWith("-")) return val;
		}
		if (arg.startsWith("--submission-id=")) {
			const val = arg.slice("--submission-id=".length).trim();
			if (val) return val;
		}
	}

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--") {
			const nextVal = argv[i + 1]?.trim();
			if (nextVal) return nextVal;
			break;
		}
		if (arg === "--submission-id") {
			if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
				i++;
			}
			continue;
		}
		if (arg.startsWith("--submission-id=")) {
			continue;
		}
		if (KIT_VALUE_FLAGS.has(arg)) {
			i++;
			continue;
		}
		if (!arg.startsWith("-")) {
			const trimmed = arg.trim();
			if (trimmed) return trimmed;
		}
	}

	const envId = env.ASC_SUBMISSION_ID?.trim();
	if (envId) {
		return envId;
	}

	throw new Error(
		"Missing review submission ID. Pass --submission-id <id>, provide a positional <submissionId> argument, or set ASC_SUBMISSION_ID.",
	);
}

export async function paginateSubmissionItems(client, submissionId) {
	const items = [];
	const seenUrls = new Set();
	let currentPath = `/reviewSubmissions/${submissionId}/items`;
	let currentQuery = { limit: 50 };

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
	const cliArgv =
		options.argv ??
		(hasNodeScriptPrefix(process.argv) ? process.argv.slice(2) : process.argv);
	const rawArgv = options.argv ?? process.argv;
	const submissionId =
		options.submissionId ??
		resolveSubmissionId(cliArgv, options.env ?? process.env);

	let client = options.client;
	let config = options.config;

	if (!client) {
		const kit = await loadAppStoreKit(options.kitSpecifier);
		config =
			config ??
			(await kit.loadConfig({
				projectRoot: process.cwd(),
				argv: filterKitArgv(rawArgv),
				env: options.env ?? process.env,
			}));
		validateCredentials(config);

		const key = kit.parsePrivateKey(config.privateKey);
		client = new kit.AppStoreConnectClient({
			keyId: config.keyId,
			issuerId: config.issuerId,
			privateKey: key,
			dryRun: config.dryRun,
			verbose: true,
		});
	}

	console.log(`Fetching items for review submission ${submissionId}...`);
	const items = await paginateSubmissionItems(client, submissionId);
	console.log(`Found ${items.length} items in submission.`);

	for (const item of items) {
		console.log(`- Item ID: ${item.id}, Type: ${item.type}`);
		console.log(`Deleting item ${item.id}...`);
		try {
			await client.request("DELETE", `/reviewSubmissionItems/${item.id}`);
			console.log("Successfully deleted review submission item!");
		} catch (err) {
			console.error("Failed to delete item:", err.message);
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
