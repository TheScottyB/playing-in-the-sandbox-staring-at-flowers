import "./helpers/m1-rn-loader.mjs";
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

describe("lib/purchases.ts cold-start race, missing key guard & live listener", () => {
	beforeEach(() => {
		globalThis.__mockAsyncStorage.clear();
		globalThis.__mockPlatform.OS = "ios";
	});

	it("serializes concurrent calls behind singleton initPurchases and notifies listeners", async () => {
		const callOrder = [];
		const listeners = new Set();
		let configureCount = 0;
		let configured = false;

		globalThis.__mockPurchases = {
			configure: async ({ apiKey }) => {
				configureCount += 1;
				callOrder.push(`configure:${apiKey}`);
				await new Promise((r) => setTimeout(r, 15));
				configured = true;
			},
			getCustomerInfo: async () => {
				assert.equal(
					configured,
					true,
					"getCustomerInfo called before configure!",
				);
				callOrder.push("getCustomerInfo");
				return { entitlements: { active: { premium: { isActive: true } } } };
			},
			getOfferings: async () => {
				assert.equal(configured, true, "getOfferings called before configure!");
				callOrder.push("getOfferings");
				return {
					current: {
						availablePackages: [
							{
								identifier: "$rc_monthly",
								packageType: "MONTHLY",
								product: {
									title: "Monthly",
									description: "Desc",
									priceString: "$4.99",
									price: 4.99,
								},
							},
						],
					},
				};
			},
			purchasePackage: async (pkg) => {
				assert.equal(
					configured,
					true,
					"purchasePackage called before configure!",
				);
				callOrder.push(`purchase:${pkg.identifier}`);
				return {
					customerInfo: {
						entitlements: { active: { premium_pass: { isActive: true } } },
					},
				};
			},
			restorePurchases: async () => {
				assert.equal(
					configured,
					true,
					"restorePurchases called before configure!",
				);
				callOrder.push("restorePurchases");
				return { entitlements: { active: {} } };
			},
			addCustomerInfoUpdateListener: (fn) => {
				listeners.add(fn);
			},
			removeCustomerInfoUpdateListener: (fn) => {
				return listeners.delete(fn);
			},
		};

		const prevMockEnv = process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		const prevIosKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
		delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = "rc_live_test_key";

		try {
			const purchases = await import("../../lib/purchases.ts?mode=native");

			const updates = [];
			const unsubscribe = purchases.subscribeToPremiumUpdates((isPrem) => {
				updates.push(isPrem);
			});
			assert.equal(listeners.size, 1);

			// Simulate cold-start race: checkPremiumStatus & getSubscriptionOfferings
			// invoked concurrently with initPurchases()
			const [isPrem, offerings] = await Promise.all([
				purchases.checkPremiumStatus(),
				purchases.getSubscriptionOfferings(),
				purchases.initPurchases(),
			]);

			assert.equal(configureCount, 1);
			assert.equal(callOrder[0], "configure:rc_live_test_key");
			assert.equal(isPrem, true);
			assert.equal(offerings.length, 1);
			assert.equal(offerings[0].identifier, "$rc_monthly");

			// Emit live CustomerInfo updates
			for (const listener of listeners) {
				listener({ entitlements: { active: { premium_pass: {} } } });
				listener({ entitlements: { active: {} } });
			}
			assert.deepEqual(updates, [true, false]);

			// Unsubscribe cleans up exact listener reference
			unsubscribe();
			assert.equal(listeners.size, 0);

			// Verify purchasePackage & restorePurchases
			const bought = await purchases.purchasePackage("$rc_monthly");
			assert.equal(bought, true);
			const restored = await purchases.restorePurchases();
			assert.equal(restored, false);
		} finally {
			if (prevMockEnv === undefined) {
				delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			} else {
				process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = prevMockEnv;
			}
			if (prevIosKey === undefined) {
				delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
			} else {
				process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = prevIosKey;
			}
		}
	});

	it("never falls back to free mock mode when native API key is missing", async () => {
		let sdkCalled = false;
		globalThis.__mockPurchases = {
			configure: () => {
				sdkCalled = true;
			},
			getCustomerInfo: async () => {
				sdkCalled = true;
				return { entitlements: { active: {} } };
			},
			getOfferings: async () => {
				sdkCalled = true;
				return { current: null };
			},
			purchasePackage: async () => {
				sdkCalled = true;
				return { customerInfo: { entitlements: { active: {} } } };
			},
			restorePurchases: async () => {
				sdkCalled = true;
				return { entitlements: { active: {} } };
			},
			addCustomerInfoUpdateListener: () => {},
			removeCustomerInfoUpdateListener: () => true,
		};

		const prevMockEnv = process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		const prevIosKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
		delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;

		try {
			const purchases = await import("../../lib/purchases.ts?mode=nokey");
			assert.equal(await purchases.checkPremiumStatus(), false);
			assert.deepEqual(await purchases.getSubscriptionOfferings(), []);
			await assert.rejects(
				() => purchases.purchasePackage("$rc_monthly"),
				/not configured/i,
			);
			await assert.rejects(
				() => purchases.restorePurchases(),
				/not configured/i,
			);
			assert.equal(sdkCalled, false);
		} finally {
			if (prevMockEnv === undefined) {
				delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			} else {
				process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = prevMockEnv;
			}
			if (prevIosKey === undefined) {
				delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
			} else {
				process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = prevIosKey;
			}
		}
	});

	it("retries cleanly after a synchronous Purchases.configure() throw without poisoning initPromise", async () => {
		let configureCalls = 0;
		let configured = false;

		globalThis.__mockPurchases = {
			configure: () => {
				configureCalls += 1;
				if (configureCalls === 1) {
					throw new Error("Synchronous native setup failure");
				}
				configured = true;
			},
			getCustomerInfo: async () => {
				assert.equal(configured, true);
				return { entitlements: { active: { premium: { isActive: true } } } };
			},
			getOfferings: async () => ({ current: null }),
			purchasePackage: async () => ({
				customerInfo: { entitlements: { active: {} } },
			}),
			restorePurchases: async () => ({ entitlements: { active: {} } }),
			addCustomerInfoUpdateListener: () => {},
			removeCustomerInfoUpdateListener: () => true,
		};

		const prevMockEnv = process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		const prevIosKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
		delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = "rc_sync_throw_key";

		try {
			const purchases = await import("../../lib/purchases.ts?mode=syncthrow");

			// Concurrent calls during first failing attempt
			await purchases.initPurchases();
			assert.equal(configureCalls, 1);
			assert.equal(configured, false);

			// Next call must retry configure() cleanly rather than reusing a poisoned initPromise
			const isPrem = await purchases.checkPremiumStatus();
			assert.equal(configureCalls, 2);
			assert.equal(configured, true);
			assert.equal(isPrem, true);
		} finally {
			if (prevMockEnv === undefined) {
				delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			} else {
				process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = prevMockEnv;
			}
			if (prevIosKey === undefined) {
				delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
			} else {
				process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = prevIosKey;
			}
		}
	});

	it("isolates errors thrown by one native subscribeToPremiumUpdates listener from others", async () => {
		const listeners = [];

		globalThis.__mockPurchases = {
			configure: () => {},
			getCustomerInfo: async () => ({ entitlements: { active: {} } }),
			getOfferings: async () => ({ current: null }),
			purchasePackage: async () => ({
				customerInfo: { entitlements: { active: {} } },
			}),
			restorePurchases: async () => ({ entitlements: { active: {} } }),
			addCustomerInfoUpdateListener: (fn) => {
				listeners.push(fn);
			},
			removeCustomerInfoUpdateListener: (fn) => {
				const idx = listeners.indexOf(fn);
				if (idx !== -1) {
					listeners.splice(idx, 1);
					return true;
				}
				return false;
			},
		};

		const prevMockEnv = process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		const prevIosKey = process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
		delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = "rc_listener_isolation";

		try {
			const purchases = await import("../../lib/purchases.ts?mode=isolation");
			const receivedBySecond = [];

			const unsub1 = purchases.subscribeToPremiumUpdates(() => {
				throw new Error("Subscriber A crashed");
			});
			const unsub2 = purchases.subscribeToPremiumUpdates((isPrem) => {
				receivedBySecond.push(isPrem);
			});

			assert.equal(listeners.length, 2);

			// Mirror react-native-purchases dispatch loop (no try/catch in SDK)
			assert.doesNotThrow(() => {
				for (const fn of listeners) {
					fn({ entitlements: { active: { premium: { isActive: true } } } });
				}
			});
			assert.deepEqual(receivedBySecond, [true]);

			unsub1();
			unsub2();
			assert.equal(listeners.length, 0);
		} finally {
			if (prevMockEnv === undefined) {
				delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			} else {
				process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = prevMockEnv;
			}
			if (prevIosKey === undefined) {
				delete process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY;
			} else {
				process.env.EXPO_PUBLIC_REVENUECAT_IOS_API_KEY = prevIosKey;
			}
		}
	});

	it("notifies mock listeners on mock purchase and restore", async () => {
		const prevMockEnv = process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
		process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = "true";

		try {
			const purchases = await import("../../lib/purchases.ts?mode=mock");
			const events = [];
			const unsub = purchases.subscribeToPremiumUpdates((prem) => {
				events.push(prem);
			});

			const bought = await purchases.purchasePackage("premium_monthly");
			assert.equal(bought, true);
			const restored = await purchases.restorePurchases();
			assert.equal(restored, true);
			assert.deepEqual(events, [true, true]);

			unsub();
			await purchases.restorePurchases();
			assert.deepEqual(events, [true, true]);
		} finally {
			if (prevMockEnv === undefined) {
				delete process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES;
			} else {
				process.env.EXPO_PUBLIC_USE_MOCK_PURCHASES = prevMockEnv;
			}
		}
	});
});
