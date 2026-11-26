import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// Environment flag to toggle mock behavior.
// We fall back to mock on Web since standard react-native-purchases web configurations
// require Web Billing setup, which is not configured yet.
const USE_MOCK =
	process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES === "true" ||
	Platform.OS === "web";

// Which plan a package represents, normalized so mock and production agree.
// Mirrors the RevenueCat PACKAGE_TYPE values this app uses, plus a catch-all.
export type PackageType = "MONTHLY" | "ANNUAL" | "LIFETIME" | "UNKNOWN";

// Unified Subscription Pass offerings interface.
//
// NOTE: `identifier` lives in one of two namespaces depending on the mode:
//   - mock mode uses our own ids ("premium_monthly", "premium_yearly", ...)
//   - production returns RevenueCat package ids, which for this app's "default"
//     offering are "$rc_monthly", "$rc_yearly", "$rc_lifetime"
//     (in App Store Connect, RevenueCat "$rc_yearly" maps to ASC product
//     "com.djscottyb.playinginthesandoxlookingatflowers.premium_annual",
//     overridable via `ASC_ANNUAL_PRODUCT_ID`)
// It is only a round-trip key back into purchasePackage(), so it stays in
// whichever namespace it arrived in. Anything that needs to know *which plan* a
// package is must use `packageType`, which is identical in both modes.
export interface PurchasesOffering {
	identifier: string;
	packageType: PackageType;
	title: string;
	description: string;
	priceString: string;
	price: number;
}

// Maps identifiers from both namespaces onto a plan, used as a fallback when
// RevenueCat doesn't hand us a packageType we recognize.
const IDENTIFIER_PACKAGE_TYPES: Record<string, PackageType> = {
	$rc_monthly: "MONTHLY",
	$rc_yearly: "ANNUAL",
	$rc_lifetime: "LIFETIME",
	premium_monthly: "MONTHLY",
	premium_yearly: "ANNUAL",
	premium_annual: "ANNUAL",
	premium_founders: "LIFETIME",
};

function resolvePackageType(rawType: unknown, identifier: string): PackageType {
	if (rawType === "MONTHLY" || rawType === "ANNUAL" || rawType === "LIFETIME") {
		return rawType;
	}
	return IDENTIFIER_PACKAGE_TYPES[identifier] ?? "UNKNOWN";
}

// Internal mock package configuration
const MOCK_OFFERINGS: PurchasesOffering[] = [
	{
		identifier: "premium_monthly",
		packageType: "MONTHLY",
		title: "Premium Monthly Pass",
		description: "Unlimited searches, 7-day archive, and Travel Mode monthly.",
		priceString: "$4.99",
		price: 4.99,
	},
	{
		identifier: "premium_yearly",
		packageType: "ANNUAL",
		title: "Premium Annual Pass",
		description: "Best value! Save over 50% compared to the monthly plan.",
		priceString: "$29.99",
		price: 29.99,
	},
	{
		identifier: "premium_founders",
		packageType: "LIFETIME",
		title: "Founders Edition (Lifetime VIP)",
		description:
			"Limited time offer. Support development and get permanent premium access forever.",
		priceString: "$99.99",
		price: 99.99,
	},
];

const MOCK_PREMIUM_KEY = "specimen_sandbox_premium_status";

// Dynamically require react-native-purchases only when needed in native environments
// biome-ignore lint/suspicious/noExplicitAny: dynamically loaded library type
let Purchases: any = null;
if (!USE_MOCK) {
	try {
		Purchases = require("react-native-purchases").default;
	} catch (e) {
		console.warn(
			"Failed to load react-native-purchases package. Falling back to mock.",
			e,
		);
	}
}

let initPromise: Promise<void> | null = null;
let isConfigured = false;
const mockListeners = new Set<(isPremium: boolean) => void>();

// biome-ignore lint/suspicious/noExplicitAny: dynamically parsed RevenueCat CustomerInfo
function hasActivePremiumEntitlement(customerInfo: any): boolean {
	const active = customerInfo?.entitlements?.active;
	if (!active) return false;
	return active.premium !== undefined || active.premium_pass !== undefined;
}

function notifyMockListeners(isPremium: boolean): void {
	for (const listener of mockListeners) {
		try {
			listener(isPremium);
		} catch (e) {
			console.error("[Purchases Wrapper] Listener error:", e);
		}
	}
}

/**
 * Initializes the Purchases SDK if mock mode is disabled.
 * Safe to call multiple times or concurrently; returns the singleton init promise.
 */
export function initPurchases(): Promise<void> {
	if (initPromise) return initPromise;

	let currentPromise: Promise<void> | null = null;
	currentPromise = (async () => {
		// Defer past the synchronous `initPromise = currentPromise` assignment so
		// a synchronous throw in Purchases.configure() cannot clear `initPromise`
		// before the outer assignment completes.
		await Promise.resolve();

		if (USE_MOCK || !Purchases) {
			console.log("[Purchases Wrapper] Running in MOCK Mode (or Web)");
			return;
		}

		try {
			const apiKey = Platform.select({
				ios: process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY,
				android: process.env.EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY,
				default: "",
			});

			if (!apiKey) {
				console.warn(
					"[Purchases Wrapper] RevenueCat API Key is missing. Check your environment variables.",
				);
				return;
			}

			await Purchases.configure({ apiKey });
			isConfigured = true;
			console.log("[Purchases Wrapper] RevenueCat configured successfully.");
		} catch (e) {
			console.error("[Purchases Wrapper] Failed to initialize RevenueCat:", e);
			isConfigured = false;
			if (initPromise === currentPromise) {
				initPromise = null;
			}
		}
	})();

	initPromise = currentPromise;
	return currentPromise;
}

async function ensureInitialized(): Promise<void> {
	await initPurchases();
}

/**
 * Subscribes to live premium entitlement updates (RevenueCat CustomerInfo updates
 * in native mode, or mock purchase/restore updates in mock mode).
 */
export function subscribeToPremiumUpdates(
	listener: (isPremium: boolean) => void,
): () => void {
	if (USE_MOCK || !Purchases) {
		mockListeners.add(listener);
		return () => {
			mockListeners.delete(listener);
		};
	}

	let active = true;
	// biome-ignore lint/suspicious/noExplicitAny: RevenueCat CustomerInfo payload
	const rcListener = (customerInfo: any) => {
		if (!active) return;
		try {
			listener(hasActivePremiumEntitlement(customerInfo));
		} catch (e) {
			console.error("[Purchases Wrapper] Listener error:", e);
		}
	};

	if (typeof Purchases.addCustomerInfoUpdateListener === "function") {
		Purchases.addCustomerInfoUpdateListener(rcListener);
	}
	void ensureInitialized();

	return () => {
		active = false;
		if (typeof Purchases.removeCustomerInfoUpdateListener === "function") {
			Purchases.removeCustomerInfoUpdateListener(rcListener);
		}
	};
}

/**
 * Retrieves the available offerings/packages.
 */
export async function getSubscriptionOfferings(): Promise<PurchasesOffering[]> {
	if (USE_MOCK || !Purchases) {
		// Simulate brief network delay
		await new Promise((resolve) => setTimeout(resolve, 500));
		return MOCK_OFFERINGS;
	}

	await ensureInitialized();
	if (!isConfigured) {
		return [];
	}

	try {
		const offerings = await Purchases.getOfferings();
		if (
			offerings.current !== null &&
			offerings.current.availablePackages.length > 0
		) {
			// biome-ignore lint/suspicious/noExplicitAny: package properties parsed dynamically
			return offerings.current.availablePackages.map((pkg: any) => ({
				identifier: pkg.identifier,
				packageType: resolvePackageType(pkg.packageType, pkg.identifier),
				title: pkg.product.title,
				description: pkg.product.description,
				priceString: pkg.product.priceString,
				price: pkg.product.price,
			}));
		}

		console.warn(
			"[Purchases Wrapper] No current offerings found in RevenueCat dashboard.",
		);
		return [];
	} catch (e) {
		console.error("[Purchases Wrapper] Failed to fetch offerings:", e);
		return [];
	}
}

/**
 * Purchase a subscription package by package identifier.
 */
export async function purchasePackage(packageId: string): Promise<boolean> {
	if (USE_MOCK || !Purchases) {
		console.log(`[Purchases Wrapper] Simulating purchase of ${packageId}...`);
		await new Promise((resolve) => setTimeout(resolve, 1500));
		try {
			await AsyncStorage.setItem(MOCK_PREMIUM_KEY, "true");
			notifyMockListeners(true);
			return true;
		} catch (e) {
			console.error("Failed to write mock premium status:", e);
			return false;
		}
	}

	await ensureInitialized();
	if (!isConfigured) {
		throw new Error("Purchases SDK is not configured");
	}

	try {
		const offerings = await Purchases.getOfferings();
		if (!offerings.current) {
			throw new Error("No current offerings available");
		}

		const pkg = offerings.current.availablePackages.find(
			// biome-ignore lint/suspicious/noExplicitAny: package properties parsed dynamically
			(p: any) => p.identifier === packageId,
		);

		if (!pkg) {
			throw new Error(`Package ${packageId} not found in offerings`);
		}

		const { customerInfo } = await Purchases.purchasePackage(pkg);
		return hasActivePremiumEntitlement(customerInfo);
		// biome-ignore lint/suspicious/noExplicitAny: error types are caught as any
	} catch (e: any) {
		if (e.userCancelled) {
			console.log("[Purchases Wrapper] User cancelled purchase.");
			return false;
		}
		console.error("[Purchases Wrapper] Purchase failed:", e);
		throw e;
	}
}

/**
 * Restore previous purchases.
 */
export async function restorePurchases(): Promise<boolean> {
	if (USE_MOCK || !Purchases) {
		console.log("[Purchases Wrapper] Simulating purchase restoration...");
		await new Promise((resolve) => setTimeout(resolve, 1000));
		const val = await AsyncStorage.getItem(MOCK_PREMIUM_KEY);
		const restored = val === "true";
		if (restored) {
			notifyMockListeners(true);
		}
		return restored;
	}

	await ensureInitialized();
	if (!isConfigured) {
		throw new Error("Purchases SDK is not configured");
	}

	try {
		const customerInfo = await Purchases.restorePurchases();
		return hasActivePremiumEntitlement(customerInfo);
	} catch (e) {
		console.error("[Purchases Wrapper] Restore failed:", e);
		throw e;
	}
}

export interface PremiumStatusVerification {
	isPremium: boolean;
	verified: boolean;
}

/**
 * Query customer info and indicate whether the result was verified by the
 * backing store (mock AsyncStorage or RevenueCat CustomerInfo) vs. inferred from
 * an unconfigured SDK or transient error.
 */
export async function checkPremiumStatusWithVerification(): Promise<PremiumStatusVerification> {
	if (USE_MOCK || !Purchases) {
		try {
			const value = await AsyncStorage.getItem(MOCK_PREMIUM_KEY);
			return { isPremium: value === "true", verified: true };
		} catch (e) {
			console.error("Failed to load mock premium status:", e);
			return { isPremium: false, verified: false };
		}
	}

	await ensureInitialized();
	if (!isConfigured) {
		return { isPremium: false, verified: false };
	}

	try {
		const customerInfo = await Purchases.getCustomerInfo();
		return {
			isPremium: hasActivePremiumEntitlement(customerInfo),
			verified: true,
		};
	} catch (e) {
		console.error("[Purchases Wrapper] Failed to check premium status:", e);
		return { isPremium: false, verified: false };
	}
}

/**
 * Query customer info to see if the user is premium.
 */
export async function checkPremiumStatus(): Promise<boolean> {
	const { isPremium } = await checkPremiumStatusWithVerification();
	return isPremium;
}
