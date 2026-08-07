import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

// Environment flag to toggle mock behavior.
// We fall back to mock on Web since standard react-native-purchases web configurations
// require Web Billing setup, which is not configured yet.
const USE_MOCK =
	process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES === "true" ||
	Platform.OS === "web";

// Unified Subscription Pass offerings interface
export interface PurchasesOffering {
	identifier: string;
	title: string;
	description: string;
	priceString: string;
	price: number;
}

// Internal mock package configuration
const MOCK_OFFERINGS: PurchasesOffering[] = [
	{
		identifier: "premium_monthly",
		title: "Premium Monthly Pass",
		description: "Unlimited searches, 7-day archive, and Travel Mode monthly.",
		priceString: "$4.99",
		price: 4.99,
	},
	{
		identifier: "premium_yearly",
		title: "Premium Annual Pass",
		description: "Best value! Save over 50% compared to the monthly plan.",
		priceString: "$29.99",
		price: 29.99,
	},
	{
		identifier: "premium_founders",
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

/**
 * Initializes the Purchases SDK if mock mode is disabled.
 */
export async function initPurchases(): Promise<void> {
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
		console.log("[Purchases Wrapper] RevenueCat configured successfully.");
	} catch (e) {
		console.error("[Purchases Wrapper] Failed to initialize RevenueCat:", e);
	}
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

	try {
		const offerings = await Purchases.getOfferings();
		if (
			offerings.current !== null &&
			offerings.current.availablePackages.length > 0
		) {
			// biome-ignore lint/suspicious/noExplicitAny: package properties parsed dynamically
			return offerings.current.availablePackages.map((pkg: any) => ({
				identifier: pkg.identifier,
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
			return true;
		} catch (e) {
			console.error("Failed to write mock premium status:", e);
			return false;
		}
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
		const entitlements = customerInfo.entitlements.active;
		return (
			entitlements.premium !== undefined ||
			entitlements.premium_pass !== undefined
		);
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
		return val === "true";
	}

	try {
		const customerInfo = await Purchases.restorePurchases();
		const entitlements = customerInfo.entitlements.active;
		return (
			entitlements.premium !== undefined ||
			entitlements.premium_pass !== undefined
		);
	} catch (e) {
		console.error("[Purchases Wrapper] Restore failed:", e);
		throw e;
	}
}

/**
 * Query customer info to see if the user is premium.
 */
export async function checkPremiumStatus(): Promise<boolean> {
	if (USE_MOCK || !Purchases) {
		try {
			const value = await AsyncStorage.getItem(MOCK_PREMIUM_KEY);
			return value === "true";
		} catch (e) {
			console.error("Failed to load mock premium status:", e);
			return false;
		}
	}

	try {
		const customerInfo = await Purchases.getCustomerInfo();
		const entitlements = customerInfo.entitlements.active;
		return (
			entitlements.premium !== undefined ||
			entitlements.premium_pass !== undefined
		);
	} catch (e) {
		console.error("[Purchases Wrapper] Failed to check premium status:", e);
		return false;
	}
}
