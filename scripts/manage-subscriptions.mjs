import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const EAS_APP_STORE_KIT_SPECIFIER =
	"../../eas-app-store-kit/src/index.mjs";

export const SUBSCRIPTION_GROUP_NAME = "Premium Subscription Group";

export function getSubscriptionPlans(env = process.env) {
	return [
		{
			key: "monthly",
			name: "Premium Monthly",
			productId:
				"com.djscottyb.playinginthesandoxlookingatflowers.premium_monthly",
			subscriptionPeriod: "ONE_MONTH",
			usdPrice: "4.99",
			description:
				"Unlimited searches, 7-day archive, and Travel Mode monthly.",
		},
		{
			key: "annual",
			name: "Premium Annual",
			productId:
				env.ASC_ANNUAL_PRODUCT_ID ||
				"com.djscottyb.playinginthesandoxlookingatflowers.premium_annual",
			subscriptionPeriod: "ONE_YEAR",
			usdPrice: "29.99",
			description: "Best value! Save over 50% compared to the monthly plan.",
		},
	];
}

export const SUBSCRIPTION_PLANS = getSubscriptionPlans();

export const NON_CONSUMABLE_IAPS = [
	{
		key: "founders",
		name: "Founders Edition (Lifetime VIP)",
		productId:
			"com.djscottyb.playinginthesandoxlookingatflowers.premium_founders",
		inAppPurchaseType: "NON_CONSUMABLE",
		usdPrice: "99.99",
		description:
			"Support development and get permanent premium access forever.",
	},
];

function defaultSleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function parseRetryAfterMs(headers) {
	const raw = headers?.get?.("Retry-After") ?? headers?.get?.("retry-after");
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

export async function ascRequest(
	client,
	method,
	apiPath,
	{
		query,
		body,
		sleepImpl = client?.sleep ?? defaultSleep,
		backoffBaseMs = client?.backoffBaseMs ?? 500,
		maxAttempts = client?.maxAttempts ?? 4,
	} = {},
) {
	if (apiPath.startsWith("/v2/")) {
		const url = new URL(`https://api.appstoreconnect.apple.com${apiPath}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined || value === null || value === "") continue;
			url.searchParams.set(key, String(value));
		}

		if (client.dryRun) {
			if (typeof client.log === "function") {
				client.log(`[dry-run] ${method} ${url.toString()}`);
			}
			if (method !== "GET") {
				return {
					data: {
						id: `dry-run-${body?.data?.type ?? "resource"}`,
						type: body?.data?.type ?? "dryRunResources",
						attributes: body?.data?.attributes ?? {},
					},
				};
			}
			if (
				apiPath.endsWith("/inAppPurchaseAvailability") ||
				apiPath.endsWith("/iapPriceSchedule")
			) {
				return { data: null };
			}
			return { data: [] };
		}

		if (client.verbose && typeof client.log === "function") {
			client.log(`[ASC Request] ${method} ${url.toString()}`);
		}

		const fetchImpl = client.fetch ?? globalThis.fetch;
		let lastErr;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let resp;
			try {
				resp = await fetchImpl(url, {
					method,
					headers: {
						Authorization: `Bearer ${client.token()}`,
						"Content-Type": "application/json",
					},
					body: body ? JSON.stringify(body) : undefined,
				});
			} catch (networkErr) {
				lastErr = networkErr;
				if (attempt === maxAttempts) {
					throw lastErr;
				}
				const waitMs = backoffBaseMs * attempt;
				if (typeof client.log === "function") {
					client.log(
						`[retry ${attempt}/${maxAttempts - 1}] ${method} ${apiPath}: ${networkErr.message}`,
					);
				}
				await sleepImpl(waitMs);
				continue;
			}

			const text = await resp.text();
			let payload = {};
			if (text) {
				try {
					payload = JSON.parse(text);
				} catch {
					payload = { raw: text };
				}
			}

			if (resp.ok) {
				return payload;
			}

			const err = new Error(
				`${method} ${apiPath} failed with ${resp.status}: ${JSON.stringify(payload)}`,
			);
			err.status = resp.status;
			err.payload = payload;
			lastErr = err;

			const retryable = resp.status === 429 || resp.status >= 500;
			if (!retryable || attempt === maxAttempts) {
				throw err;
			}

			const retryAfterMs = parseRetryAfterMs(resp.headers);
			const waitMs =
				retryAfterMs !== null ? retryAfterMs : backoffBaseMs * attempt;

			if (typeof client.log === "function") {
				client.log(
					`[retry ${attempt}/${maxAttempts - 1}] ${method} ${apiPath} -> ${resp.status} (waiting ${waitMs}ms)`,
				);
			}
			await sleepImpl(waitMs);
		}

		throw lastErr;
	}

	const normalizedPath = apiPath.startsWith("/v1/")
		? apiPath.slice(3)
		: apiPath;
	return client.request(method, normalizedPath, { query, body });
}

export async function paginateAll(
	client,
	apiPath,
	{ query = {}, matchFn } = {},
) {
	const items = [];
	const seenUrls = new Set();
	let currentPath = apiPath;
	let currentQuery = { ...query };

	while (true) {
		const res = await ascRequest(client, "GET", currentPath, {
			query: currentQuery,
		});

		if (!Array.isArray(res?.data)) {
			break;
		}

		items.push(...res.data);

		if (typeof matchFn === "function" && res.data.some(matchFn)) {
			break;
		}

		const nextHref = res?.links?.next;
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

async function fetchAllTerritoryRelationships(client) {
	try {
		console.log("Fetching all available territories from App Store Connect...");
		const territories = await paginateAll(client, "/territories", {
			query: { limit: 200 },
		});
		if (territories.length === 0) {
			return [{ type: "territories", id: "USA" }];
		}
		const rels = territories.map((t) => ({ type: "territories", id: t.id }));
		console.log(`Fetched ${rels.length} territories.`);
		return rels;
	} catch (e) {
		console.log(
			"Failed to fetch territories, falling back to USA only:",
			e.message,
		);
		return [{ type: "territories", id: "USA" }];
	}
}

export async function ensureSubscriptionPlan(
	client,
	_appId,
	group,
	plan,
	{ delayMs = 150, sleepImpl = defaultSleep } = {},
) {
	console.log(
		`\n--- Checking Subscription "${plan.name}" (${plan.productId}) in "${group.attributes?.referenceName || SUBSCRIPTION_GROUP_NAME}" ---`,
	);
	const subs = await paginateAll(
		client,
		`/subscriptionGroups/${group.id}/subscriptions`,
		{ query: { limit: 200 } },
	);

	let subscription = subs.find(
		(s) => s.attributes?.productId === plan.productId,
	);

	if (!subscription) {
		console.log(
			`Subscription with productId "${plan.productId}" not found. Creating it...`,
		);
		const createSubRes = await ascRequest(client, "POST", "/subscriptions", {
			body: {
				data: {
					type: "subscriptions",
					attributes: {
						name: plan.name,
						productId: plan.productId,
						familySharable: false,
						subscriptionPeriod: plan.subscriptionPeriod,
					},
					relationships: {
						group: {
							data: {
								type: "subscriptionGroups",
								id: group.id,
							},
						},
					},
				},
			},
		});
		subscription = createSubRes.data;
		console.log(
			`Successfully created subscription: "${subscription.attributes?.name ?? plan.name}" (${subscription.id})`,
		);
	} else {
		console.log(
			`Found existing subscription: "${subscription.attributes?.name ?? plan.name}" (${subscription.id})`,
		);
	}

	console.log(
		`\n--- Checking localizations for subscription "${plan.name}" ---`,
	);
	const locs = await paginateAll(
		client,
		`/subscriptions/${subscription.id}/subscriptionLocalizations`,
		{ query: { limit: 50 } },
	);

	let localization = locs.find((l) => l.attributes?.locale === "en-US");

	if (!localization) {
		console.log('No "en-US" localization found. Creating it...');
		const createLocRes = await ascRequest(
			client,
			"POST",
			"/subscriptionLocalizations",
			{
				body: {
					data: {
						type: "subscriptionLocalizations",
						attributes: {
							locale: "en-US",
							name: plan.name,
							description: plan.description,
						},
						relationships: {
							subscription: {
								data: {
									type: "subscriptions",
									id: subscription.id,
								},
							},
						},
					},
				},
			},
		);
		localization = createLocRes.data;
		console.log(
			`Successfully created localization: "${localization.attributes?.name ?? plan.name}" (${localization.id})`,
		);
	} else {
		console.log(
			`Found existing localization: "${localization.attributes?.name ?? plan.name}" (${localization.id})`,
		);
	}

	console.log(
		`\n--- Checking availability for subscription "${plan.name}" ---`,
	);
	let availability = null;
	try {
		const availRes = await ascRequest(
			client,
			"GET",
			`/subscriptions/${subscription.id}/subscriptionAvailability`,
		);
		availability =
			availRes.data && availRes.data.id !== "dry-run-resource"
				? availRes.data
				: null;
		if (availability) {
			console.log(
				`Found existing subscription availability: ${availability.id}`,
			);
		}
	} catch (e) {
		console.log(
			"No existing availability found or failed to fetch (might not be created yet):",
			e.message,
		);
	}

	if (!availability) {
		const territoryRelationships = await fetchAllTerritoryRelationships(client);
		console.log("Creating subscription availability...");
		const createAvailRes = await ascRequest(
			client,
			"POST",
			"/subscriptionAvailabilities",
			{
				body: {
					data: {
						type: "subscriptionAvailabilities",
						attributes: {
							availableInNewTerritories: true,
						},
						relationships: {
							subscription: {
								data: {
									type: "subscriptions",
									id: subscription.id,
								},
							},
							availableTerritories: {
								data: territoryRelationships,
							},
						},
					},
				},
			},
		);
		availability = createAvailRes.data;
		console.log(`Successfully created availability: ${availability.id}`);
	}

	console.log(
		`\n--- Fetching price points for "${plan.name}" to find $${plan.usdPrice} USD ---`,
	);
	const pricePoints = await paginateAll(
		client,
		`/subscriptions/${subscription.id}/pricePoints`,
		{
			query: {
				"filter[territory]": "USA",
				limit: 200,
			},
			matchFn: (p) => p.attributes?.customerPrice === plan.usdPrice,
		},
	);

	const targetPricePoint = pricePoints.find(
		(p) => p.attributes?.customerPrice === plan.usdPrice,
	);

	if (!targetPricePoint) {
		if (client.dryRun) {
			console.log(
				`[DRY RUN] Skipping price-point lookup & price updates for "${plan.name}" ($${plan.usdPrice} USD) because no price points were returned.`,
			);
			return subscription;
		}
		throw new Error(
			`Could not find a $${plan.usdPrice} USD price point for "${plan.name}" in the USA territory list.`,
		);
	}

	console.log(
		`Found USD $${plan.usdPrice} Price Point: ID = ${targetPricePoint.id}`,
	);

	console.log(`\n--- Checking current prices for "${plan.name}" ---`);
	const existingByTerritory = new Map();
	try {
		const currentPrices = await paginateAll(
			client,
			`/subscriptions/${subscription.id}/prices`,
			{
				query: { limit: 200, include: "territory,subscriptionPricePoint" },
			},
		);
		console.log("Current prices count:", currentPrices.length);

		for (const price of currentPrices) {
			const terrId = price.relationships?.territory?.data?.id;
			const pointId = price.relationships?.subscriptionPricePoint?.data?.id;
			if (terrId) {
				existingByTerritory.set(terrId, {
					priceId: price.id,
					pricePointId: pointId,
				});
			}
		}
	} catch (e) {
		console.log("Failed to fetch current prices:", e.message);
	}

	async function setTerritoryPrice(territoryId, pricePointId, existing) {
		if (existing?.priceId) {
			try {
				await ascRequest(
					client,
					"DELETE",
					`/subscriptionPrices/${existing.priceId}`,
				);
			} catch (delErr) {
				console.warn(
					`  Note: could not delete previous price ${existing.priceId} for ${territoryId}: ${delErr.message}`,
				);
			}
		}
		return ascRequest(client, "POST", "/subscriptionPrices", {
			body: {
				data: {
					type: "subscriptionPrices",
					relationships: {
						subscription: {
							data: {
								type: "subscriptions",
								id: subscription.id,
							},
						},
						subscriptionPricePoint: {
							data: {
								type: "subscriptionPricePoints",
								id: pricePointId,
							},
						},
						territory: {
							data: {
								type: "territories",
								id: territoryId,
							},
						},
					},
				},
			},
		});
	}

	const existingUsa = existingByTerritory.get("USA");
	if (!existingUsa || existingUsa.pricePointId !== targetPricePoint.id) {
		console.log(
			`\n--- ${existingUsa ? "Updating" : "Creating"} Subscription Price for USA ($${plan.usdPrice}) ---`,
		);
		const priceRes = await setTerritoryPrice(
			"USA",
			targetPricePoint.id,
			existingUsa,
		);
		console.log(
			`Successfully set USD $${plan.usdPrice} price for USA:`,
			priceRes.data.id,
		);
		existingByTerritory.set("USA", {
			priceId: priceRes.data.id,
			pricePointId: targetPricePoint.id,
		});
		if (delayMs > 0) await sleepImpl(delayMs);
	} else {
		console.log(
			`USA subscription price is already configured at $${plan.usdPrice}.`,
		);
	}

	console.log(
		"\n--- Fetching equalizations for this price point to configure global pricing ---",
	);
	let equalizations = [];
	try {
		equalizations = await paginateAll(
			client,
			`/subscriptionPricePoints/${targetPricePoint.id}/equalizations`,
			{ query: { limit: 200, include: "territory" } },
		);
		console.log(`Total equalizations available: ${equalizations.length}`);
	} catch (e) {
		console.log("Failed to fetch equalizations:", e.message);
	}

	if (equalizations.length > 0) {
		console.log("\n--- Configuring equalized prices for other territories ---");
		let createdCount = 0;
		let updatedCount = 0;
		let skippedCount = 0;

		for (const eq of equalizations) {
			const territoryId = eq.relationships?.territory?.data?.id;
			if (!territoryId) {
				console.log(
					`Skipping equalization ${eq.id} with missing territory relationship.`,
				);
				continue;
			}
			if (territoryId === "USA") continue;

			const existing = existingByTerritory.get(territoryId);
			if (existing && existing.pricePointId === eq.id) {
				skippedCount++;
				continue;
			}

			console.log(
				`[${createdCount + updatedCount + skippedCount + 1}/${equalizations.length}] ${existing ? "Updating" : "Setting"} price for territory ${territoryId} (${eq.attributes?.customerPrice})...`,
			);
			try {
				const res = await setTerritoryPrice(territoryId, eq.id, existing);
				if (existing) {
					updatedCount++;
				} else {
					createdCount++;
				}
				existingByTerritory.set(territoryId, {
					priceId: res.data.id,
					pricePointId: eq.id,
				});
				if (delayMs > 0) await sleepImpl(delayMs);
			} catch (err) {
				console.error(
					`Failed to set price for territory ${territoryId}:`,
					err.message,
				);
				if (err.payload) {
					console.error("Error Details:", JSON.stringify(err.payload, null, 2));
				}
			}
		}
		console.log(
			`Global pricing configuration complete for ${plan.name}: ${createdCount} created, ${updatedCount} updated, ${skippedCount} unchanged.`,
		);
	}

	return subscription;
}

export async function ensureNonConsumableIap(client, appId, iapConfig) {
	console.log(
		`\n--- Checking Non-Consumable IAP "${iapConfig.name}" (${iapConfig.productId}) ---`,
	);

	const iaps = await paginateAll(client, `/apps/${appId}/inAppPurchasesV2`, {
		query: { limit: 200 },
	});

	let iap = iaps.find(
		(item) => item.attributes?.productId === iapConfig.productId,
	);

	if (!iap) {
		console.log(
			`Non-consumable IAP "${iapConfig.productId}" not found. Creating it...`,
		);
		const createRes = await ascRequest(client, "POST", "/v2/inAppPurchases", {
			body: {
				data: {
					type: "inAppPurchases",
					attributes: {
						name: iapConfig.name,
						productId: iapConfig.productId,
						inAppPurchaseType: iapConfig.inAppPurchaseType,
						familySharable: false,
					},
					relationships: {
						app: {
							data: {
								type: "apps",
								id: appId,
							},
						},
					},
				},
			},
		});
		iap = createRes.data;
		console.log(
			`Successfully created IAP: "${iap.attributes?.name ?? iapConfig.name}" (${iap.id})`,
		);
	} else {
		console.log(
			`Found existing IAP: "${iap.attributes?.name ?? iapConfig.name}" (${iap.id})`,
		);
	}

	console.log(`\n--- Checking localizations for IAP "${iapConfig.name}" ---`);
	const locs = await paginateAll(
		client,
		`/v2/inAppPurchases/${iap.id}/inAppPurchaseLocalizations`,
		{ query: { limit: 50 } },
	);

	let localization = locs.find((l) => l.attributes?.locale === "en-US");
	if (!localization) {
		console.log('No "en-US" IAP localization found. Creating it...');
		const createLocRes = await ascRequest(
			client,
			"POST",
			"/v1/inAppPurchaseLocalizations",
			{
				body: {
					data: {
						type: "inAppPurchaseLocalizations",
						attributes: {
							locale: "en-US",
							name: iapConfig.name,
							description: iapConfig.description,
						},
						relationships: {
							inAppPurchaseV2: {
								data: {
									type: "inAppPurchases",
									id: iap.id,
								},
							},
						},
					},
				},
			},
		);
		localization = createLocRes.data;
		console.log(
			`Successfully created IAP localization: "${localization.attributes?.name ?? iapConfig.name}" (${localization.id})`,
		);
	} else {
		console.log(
			`Found existing IAP localization: "${localization.attributes?.name ?? iapConfig.name}" (${localization.id})`,
		);
	}

	console.log(`\n--- Checking availability for IAP "${iapConfig.name}" ---`);
	let availability = null;
	try {
		const availRes = await ascRequest(
			client,
			"GET",
			`/v2/inAppPurchases/${iap.id}/inAppPurchaseAvailability`,
		);
		availability = availRes.data ?? null;
	} catch (e) {
		console.log("No existing IAP availability found:", e.message);
	}

	if (!availability) {
		const territoryRelationships = await fetchAllTerritoryRelationships(client);
		console.log("Creating IAP availability...");
		const createAvailRes = await ascRequest(
			client,
			"POST",
			"/v1/inAppPurchaseAvailabilities",
			{
				body: {
					data: {
						type: "inAppPurchaseAvailabilities",
						attributes: {
							availableInNewTerritories: true,
						},
						relationships: {
							inAppPurchase: {
								data: {
									type: "inAppPurchases",
									id: iap.id,
								},
							},
							availableTerritories: {
								data: territoryRelationships,
							},
						},
					},
				},
			},
		);
		availability = createAvailRes.data;
		console.log(`Successfully created IAP availability: ${availability.id}`);
	}

	console.log(
		`\n--- Fetching IAP price points for "${iapConfig.name}" to find $${iapConfig.usdPrice} USD ---`,
	);
	const pricePoints = await paginateAll(
		client,
		`/v2/inAppPurchases/${iap.id}/pricePoints`,
		{
			query: {
				"filter[territory]": "USA",
				limit: 200,
			},
			matchFn: (p) => p.attributes?.customerPrice === iapConfig.usdPrice,
		},
	);

	const targetPricePoint = pricePoints.find(
		(p) => p.attributes?.customerPrice === iapConfig.usdPrice,
	);

	if (!targetPricePoint) {
		if (client.dryRun) {
			console.log(
				`[DRY RUN] Skipping price-point lookup & price-schedule creation for IAP "${iapConfig.name}" ($${iapConfig.usdPrice} USD) because no price points were returned.`,
			);
			return iap;
		}
		throw new Error(
			`Could not find a $${iapConfig.usdPrice} USD price point for IAP "${iapConfig.name}" in the USA territory list.`,
		);
	}

	console.log(
		`Found IAP USD $${iapConfig.usdPrice} Price Point: ID = ${targetPricePoint.id}`,
	);

	let existingSchedule = null;
	try {
		const scheduleRes = await ascRequest(
			client,
			"GET",
			`/v2/inAppPurchases/${iap.id}/iapPriceSchedule`,
		);
		existingSchedule = scheduleRes.data ?? null;
	} catch (e) {
		console.log("No existing IAP price schedule found:", e.message);
	}

	if (!existingSchedule) {
		const inlinePriceId = ["$", "{price1}"].join("");
		console.log(
			`Creating IAP price schedule for "${iapConfig.name}" ($${iapConfig.usdPrice} USD)...`,
		);
		await ascRequest(client, "POST", "/v1/inAppPurchasePriceSchedules", {
			body: {
				data: {
					type: "inAppPurchasePriceSchedules",
					relationships: {
						inAppPurchase: {
							data: {
								type: "inAppPurchases",
								id: iap.id,
							},
						},
						baseTerritory: {
							data: {
								type: "territories",
								id: "USA",
							},
						},
						manualPrices: {
							data: [
								{
									type: "inAppPurchasePrices",
									id: inlinePriceId,
								},
							],
						},
					},
				},
				included: [
					{
						type: "inAppPurchasePrices",
						id: inlinePriceId,
						attributes: {
							startDate: null,
						},
						relationships: {
							inAppPurchaseV2: {
								data: {
									type: "inAppPurchases",
									id: iap.id,
								},
							},
							inAppPurchasePricePoint: {
								data: {
									type: "inAppPurchasePricePoints",
									id: targetPricePoint.id,
								},
							},
						},
					},
				],
			},
		});
		console.log(
			`Successfully configured IAP price schedule at $${iapConfig.usdPrice} USD.`,
		);
	} else {
		console.log(`Found existing IAP price schedule: ${existingSchedule.id}`);
	}

	return iap;
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
				quiet: config.quiet,
			});
	}

	const appId = config.appId;

	console.log("--- Checking API connection ---");
	const appRes = await ascRequest(client, "GET", `/apps/${appId}`, {
		query: { "fields[apps]": "name,bundleId,sku" },
	});
	console.log(
		`Connected successfully. App: "${appRes.data?.attributes?.name ?? appId}" (${appRes.data?.attributes?.bundleId ?? "unknown"})`,
	);

	console.log("\n--- Checking Subscription Groups ---");
	const groups = await paginateAll(
		client,
		`/apps/${appId}/subscriptionGroups`,
		{
			query: { limit: 200 },
		},
	);

	let group = groups.find(
		(g) => g.attributes?.referenceName === SUBSCRIPTION_GROUP_NAME,
	);

	if (!group) {
		console.log(`No "${SUBSCRIPTION_GROUP_NAME}" found. Creating one...`);
		const createGroupRes = await ascRequest(
			client,
			"POST",
			"/subscriptionGroups",
			{
				body: {
					data: {
						type: "subscriptionGroups",
						attributes: {
							referenceName: SUBSCRIPTION_GROUP_NAME,
						},
						relationships: {
							app: {
								data: {
									type: "apps",
									id: appId,
								},
							},
						},
					},
				},
			},
		);
		group = createGroupRes.data;
		console.log(
			`Successfully created subscription group: ${group.attributes?.referenceName ?? SUBSCRIPTION_GROUP_NAME} (${group.id})`,
		);
	} else {
		console.log(
			`Found existing subscription group: ${group.attributes?.referenceName ?? SUBSCRIPTION_GROUP_NAME} (${group.id})`,
		);
	}

	const plans = options.subscriptionPlans ?? getSubscriptionPlans();
	for (const plan of plans) {
		await ensureSubscriptionPlan(client, appId, group, plan, {
			delayMs: options.delayMs,
			sleepImpl: options.sleepImpl,
		});
	}

	const iaps = options.nonConsumableIaps ?? NON_CONSUMABLE_IAPS;
	for (const iapConfig of iaps) {
		await ensureNonConsumableIap(client, appId, iapConfig);
	}

	console.log(
		"\n--- Subscription & IAP automation completed successfully! ---",
	);
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
	main().catch((error) => {
		console.error(`\x1b[31mError:\x1b[0m ${error.message}`);
		if (error.payload) {
			console.error("Error Payload:", JSON.stringify(error.payload, null, 2));
		}
		if (error.stack) {
			console.error(error.stack);
		}
		process.exitCode = 1;
	});
}
