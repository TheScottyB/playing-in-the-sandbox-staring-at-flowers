import assert from "node:assert/strict";
import { describe, test } from "node:test";
import ts from "typescript";
import {
	collectStringLiterals,
	findCallExpressions,
	findFunctionsByName,
	findJsxElements,
	getNodeText,
	parseTsxAst,
	readRepoFile,
	walkAst,
} from "./helpers/repo.mjs";
import { createE2EContext } from "./helpers/rn-loader.mjs";

function unwrapParens(node) {
	let cur = node;
	while (cur && ts.isParenthesizedExpression(cur)) {
		cur = cur.expression;
	}
	return cur;
}

function exprRequiresDevTrue(node) {
	const expr = unwrapParens(node);
	if (!expr) return false;
	if (ts.isIdentifier(expr) && expr.text === "__DEV__") return true;
	if (
		ts.isBinaryExpression(expr) &&
		expr.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
	) {
		return exprRequiresDevTrue(expr.left) || exprRequiresDevTrue(expr.right);
	}
	return false;
}

function exprTrueWhenNotDev(node) {
	const expr = unwrapParens(node);
	if (!expr) return false;
	if (
		ts.isPrefixUnaryExpression(expr) &&
		expr.operator === ts.SyntaxKind.ExclamationToken
	) {
		const operand = unwrapParens(expr.operand);
		return ts.isIdentifier(operand) && operand.text === "__DEV__";
	}
	if (
		ts.isBinaryExpression(expr) &&
		expr.operatorToken.kind === ts.SyntaxKind.BarBarToken
	) {
		return exprTrueWhenNotDev(expr.left) || exprTrueWhenNotDev(expr.right);
	}
	return false;
}

function isDescendantOf(node, ancestor) {
	let cur = node;
	while (cur) {
		if (cur === ancestor) return true;
		cur = cur.parent;
	}
	return false;
}

function subtreeHasText(ast, root, needles) {
	let found = false;
	walkAst(root, (n) => {
		if (found) return;
		if (
			ts.isStringLiteral(n) ||
			ts.isNoSubstitutionTemplateLiteral(n) ||
			ts.isJsxText(n)
		) {
			const txt = n.text;
			if (needles.some((needle) => txt.includes(needle))) {
				found = true;
			}
		} else if (ts.isIdentifier(n) && needles.includes(n.text)) {
			found = true;
		}
	});
	if (found) return true;
	const text = getNodeText(ast, root);
	return needles.some((needle) => text.includes(needle));
}

describe("01 — Client Paywall, RevenueCat Purchases & Premium Quota (Items 1, 2, 7)", () => {
	// =========================================================================
	// Item 1: Travel Mode __DEV__ Guard & Dev Menu Separation
	// =========================================================================

	test("T1-I1-01: app/index.tsx handleEyebrowPress is gated by __DEV__", () => {
		const ast = parseTsxAst("app/index.tsx");
		const fns = findFunctionsByName(ast, "handleEyebrowPress");
		assert.equal(fns.length, 1, "handleEyebrowPress function should exist");
		const bodyText = getNodeText(ast, fns[0]);
		assert.match(
			bodyText,
			/__DEV__/,
			"handleEyebrowPress must guard dev menu activation with __DEV__",
		);
	});

	test("T1-I1-02: app/index.tsx separates Travel Mode modal from Dev Diagnostics", () => {
		const ast = parseTsxAst("app/index.tsx");
		let hasSeparateTravelState = false;
		let diagnosticsGatedByDev = false;
		const diagMarkers = ["OTA Update ID", "Local Species DB", "Diagnostics"];

		walkAst(ast, (node) => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isArrayBindingPattern(node.name)
			) {
				const first = node.name.elements[0];
				if (
					first &&
					ts.isBindingElement(first) &&
					ts.isIdentifier(first.name) &&
					/^(travelModalVisible|travelMenuVisible|travelModeVisible)$/i.test(
						first.name.text,
					)
				) {
					hasSeparateTravelState = true;
				}
			}

			if (
				ts.isBinaryExpression(node) &&
				node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
				exprRequiresDevTrue(node.left) &&
				subtreeHasText(ast, node.right, diagMarkers)
			) {
				diagnosticsGatedByDev = true;
			}

			if (ts.isConditionalExpression(node)) {
				if (
					(exprRequiresDevTrue(node.condition) &&
						subtreeHasText(ast, node.whenTrue, diagMarkers)) ||
					(exprTrueWhenNotDev(node.condition) &&
						subtreeHasText(ast, node.whenFalse, diagMarkers))
				) {
					diagnosticsGatedByDev = true;
				}
			}

			if (
				ts.isIfStatement(node) &&
				exprRequiresDevTrue(node.expression) &&
				subtreeHasText(ast, node.thenStatement, diagMarkers)
			) {
				diagnosticsGatedByDev = true;
			}
		});

		assert.ok(
			hasSeparateTravelState || diagnosticsGatedByDev,
			"Dev diagnostics (OTA Update ID / Local Species DB) must be gated by a real __DEV__ AST condition or separated from Travel Mode modal",
		);
	});

	test("T1-I1-03: app/index.tsx Travel Mode button routes non-premium users to PremiumModal", () => {
		const source = readRepoFile("app/index.tsx");
		assert.match(
			source,
			/Travel Mode/,
			"Travel Mode button should exist in app/index.tsx",
		);
		assert.match(
			source,
			/if\s*\(\s*!isPremium\s*\)[\s\S]{0,120}setPremiumModalVisible\(\s*true\s*\)/,
			"Non-premium users tapping Travel Mode must open PremiumModal",
		);
	});

	test("T1-I1-04: app/index.tsx eyebrow Pressable wires handleEyebrowPress and initializes devMenuVisible to false", () => {
		const ast = parseTsxAst("app/index.tsx");
		const pressables = findJsxElements(ast, "Pressable");
		const hasEyebrowPressable = pressables.some((el) =>
			el.attributes.properties.some(
				(prop) =>
					ts.isJsxAttribute(prop) &&
					prop.name.getText(ast) === "onPress" &&
					prop.initializer &&
					ts.isJsxExpression(prop.initializer) &&
					prop.initializer.expression &&
					/^(handleEyebrowPress|__DEV__\s*\?\s*handleEyebrowPress\s*:\s*undefined)$/.test(
						getNodeText(ast, prop.initializer.expression).trim(),
					),
			),
		);
		assert.ok(
			hasEyebrowPressable,
			"Eyebrow Pressable must bind handleEyebrowPress",
		);

		let devMenuInitFalse = false;
		walkAst(ast, (node) => {
			if (
				ts.isVariableDeclaration(node) &&
				ts.isArrayBindingPattern(node.name) &&
				node.initializer &&
				ts.isCallExpression(node.initializer) &&
				getNodeText(ast, node.initializer.expression) === "useState"
			) {
				const first = node.name.elements[0];
				const arg0 = node.initializer.arguments[0];
				if (
					first &&
					ts.isBindingElement(first) &&
					ts.isIdentifier(first.name) &&
					first.name.text === "devMenuVisible" &&
					arg0?.kind === ts.SyntaxKind.FalseKeyword
				) {
					devMenuInitFalse = true;
				}
			}
		});
		assert.ok(
			devMenuInitFalse,
			"devMenuVisible must default to useState(false)",
		);
	});

	test("T1-I1-05: meta/FEATURES.md documents __DEV__-gated diagnostics separate from Travel Mode", () => {
		const features = readRepoFile("meta/FEATURES.md");
		assert.match(features, /__DEV__/);
		assert.match(features, /Travel Mode/);
	});

	test("T2-I1-06: app/index.tsx handleEyebrowPress never mutates devMenuVisible when !__DEV__", () => {
		const ast = parseTsxAst("app/index.tsx");
		const fns = findFunctionsByName(ast, "handleEyebrowPress");
		assert.equal(fns.length, 1);
		const bodyText = getNodeText(ast, fns[0]);
		assert.match(
			bodyText,
			/if\s*\(\s*!__DEV__\s*\)\s*return|if\s*\(\s*__DEV__\s*\)/,
			"handleEyebrowPress must explicitly short-circuit or branch on __DEV__ before updating tap/menu state",
		);
	});

	test("T2-I1-07: app/index.tsx does not expose 'Dev Controls' header when !__DEV__", () => {
		const ast = parseTsxAst("app/index.tsx");
		const devControlsNodes = [];
		walkAst(ast, (node) => {
			if (
				(ts.isStringLiteral(node) ||
					ts.isNoSubstitutionTemplateLiteral(node) ||
					ts.isJsxText(node)) &&
				node.text.includes("Dev Controls")
			) {
				devControlsNodes.push(node);
			}
		});

		if (devControlsNodes.length === 0) {
			assert.equal(
				collectStringLiterals(ast).some((s) => s.includes("Dev Controls")),
				false,
				"Dev Controls header string should not be exposed",
			);
			return;
		}

		for (const node of devControlsNodes) {
			let guardedAgainstNonDev = false;
			let cur = node.parent;
			while (cur) {
				if (
					ts.isConditionalExpression(cur) &&
					((isDescendantOf(node, cur.whenFalse) &&
						exprTrueWhenNotDev(cur.condition)) ||
						(isDescendantOf(node, cur.whenTrue) &&
							exprRequiresDevTrue(cur.condition)))
				) {
					guardedAgainstNonDev = true;
					break;
				}
				if (
					ts.isBinaryExpression(cur) &&
					cur.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
					isDescendantOf(node, cur.right) &&
					exprRequiresDevTrue(cur.left)
				) {
					guardedAgainstNonDev = true;
					break;
				}
				if (
					ts.isIfStatement(cur) &&
					isDescendantOf(node, cur.thenStatement) &&
					exprRequiresDevTrue(cur.expression)
				) {
					guardedAgainstNonDev = true;
					break;
				}
				cur = cur.parent;
			}
			assert.ok(
				guardedAgainstNonDev,
				"Dev Controls header must be inside an AST branch unreachable when !__DEV__",
			);
		}
	});

	test("T2-I1-08: app/index.tsx contains no direct setIsPremium(true) backdoor in eyebrow or region handlers", () => {
		const ast = parseTsxAst("app/index.tsx");
		for (const fnName of ["handleEyebrowPress", "applyOverride"]) {
			const fns = findFunctionsByName(ast, fnName);
			assert.equal(fns.length, 1, `${fnName} should exist`);
			const text = getNodeText(ast, fns[0]);
			assert.equal(
				text.includes("setIsPremium(true)"),
				false,
				`${fnName} must never grant premium`,
			);
		}
	});

	test("T2-I1-09: app/index.tsx custom region code validates empty input before applyOverride", () => {
		const source = readRepoFile("app/index.tsx");
		assert.match(
			source,
			/if\s*\(\s*!trimmed\s*\)/,
			"Empty custom region code should be rejected before applyOverride",
		);
	});

	test("T2-I1-10: app/index.tsx Travel Mode modal gates Dev Diagnostics and applyOverride behind __DEV__ or isPremium", () => {
		const source = readRepoFile("app/index.tsx");
		assert.match(
			source,
			/visible=\{devMenuVisible\s*&&\s*\(__DEV__\s*\|\|\s*isPremium\)\}/,
			"Modal visibility must require (__DEV__ || isPremium)",
		);
		assert.match(
			source,
			/if\s*\(\s*!__DEV__\s*&&\s*!isPremium\s*\)\s*return/,
			"applyOverride must reject calls when neither __DEV__ nor isPremium",
		);
	});

	// =========================================================================
	// Item 2: RevenueCat Cold-Start Race & CustomerInfo Listener
	// =========================================================================

	test("T1-I2-01: initPurchases configures RevenueCat once with iOS key on iOS", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_ios_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			assert.equal(ctx.purchases.configureCalls, 1);
			assert.deepEqual(ctx.purchases.configureArgs[0], {
				apiKey: "appl_test_ios_key",
			});
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I2-02: initPurchases configures RevenueCat with Android key on Android", async () => {
		const ctx = createE2EContext({
			platform: "android",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_ANDROID_API_KEY: "goog_test_android_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			assert.equal(ctx.purchases.configureCalls, 1);
			assert.deepEqual(ctx.purchases.configureArgs[0], {
				apiKey: "goog_test_android_key",
			});
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I2-03: getSubscriptionOfferings maps $rc_monthly, $rc_yearly, $rc_lifetime packageTypes", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			const pkgs = await purchases.getSubscriptionOfferings();
			assert.equal(pkgs.length, 3);
			assert.deepEqual(
				pkgs.map((p) => [p.identifier, p.packageType]),
				[
					["$rc_monthly", "MONTHLY"],
					["$rc_yearly", "ANNUAL"],
					["$rc_lifetime", "LIFETIME"],
				],
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I2-04: purchasePackage and restorePurchases reflect active entitlements", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			assert.equal(await purchases.restorePurchases(), false);
			const ok = await purchases.purchasePackage("$rc_monthly");
			assert.equal(ok, true);
			assert.equal(await purchases.restorePurchases(), true);
			assert.equal(await purchases.checkPremiumStatus(), true);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I2-05: subscribeToPremiumUpdates notifies listeners on CustomerInfo updates", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			assert.equal(
				typeof purchases.subscribeToPremiumUpdates,
				"function",
				"lib/purchases.ts must export subscribeToPremiumUpdates",
			);
			await purchases.initPurchases();
			const events = [];
			const unsub = purchases.subscribeToPremiumUpdates((val) =>
				events.push(val),
			);
			assert.equal(typeof unsub, "function");
			ctx.purchases.emitCustomerInfo({
				entitlements: { active: { premium: { isActive: true } } },
			});
			ctx.purchases.emitCustomerInfo({
				entitlements: { active: {} },
			});
			unsub();
			ctx.purchases.emitCustomerInfo({
				entitlements: { active: { premium_pass: { isActive: true } } },
			});
			assert.deepEqual(events, [true, false]);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I2-06: cold-start race awaits configure once before getCustomerInfo/getOfferings", async () => {
		const order = [];
		const ctx = createE2EContext({
			platform: "ios",
			configureDelayMs: 30,
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_race_key",
			},
		});
		const origConfigure = ctx.purchases.configure.bind(ctx.purchases);
		ctx.purchases.configure = async (cfg) => {
			order.push("configure:start");
			await origConfigure(cfg);
			order.push("configure:done");
		};
		const origGetInfo = ctx.purchases.getCustomerInfo.bind(ctx.purchases);
		ctx.purchases.getCustomerInfo = async () => {
			order.push("getCustomerInfo");
			return origGetInfo();
		};
		const origGetOff = ctx.purchases.getOfferings.bind(ctx.purchases);
		ctx.purchases.getOfferings = async () => {
			order.push("getOfferings");
			return origGetOff();
		};
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await Promise.all([
				purchases.initPurchases(),
				purchases.initPurchases(),
				purchases.checkPremiumStatus(),
				purchases.getSubscriptionOfferings(),
			]);
			assert.equal(
				ctx.purchases.configureCalls,
				1,
				"Concurrent cold-start callers must configure RevenueCat at most once",
			);
			const doneIdx = order.indexOf("configure:done");
			assert.ok(doneIdx !== -1, "configure:done must be recorded");
			assert.ok(
				order.indexOf("getCustomerInfo") > doneIdx,
				`getCustomerInfo must await configure completion; observed order: ${order.join(" -> ")}`,
			);
			assert.ok(
				order.indexOf("getOfferings") > doneIdx,
				`getOfferings must await configure completion; observed order: ${order.join(" -> ")}`,
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I2-07: missing API key in native mode fails safely without throwing", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "false" },
			unsetEnv: ["EXPO_PUBLIC_REVENUECAT_IOS_API_KEY"],
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			assert.equal(ctx.purchases.configureCalls, 0);
			assert.equal(await purchases.checkPremiumStatus(), false);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I2-08: rejected configure does not cause unhandled rejection on checkPremiumStatus", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			configureError: new Error("SDK boot error"),
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_bad_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			const status = await purchases.checkPremiumStatus();
			assert.equal(typeof status, "boolean");
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I2-09: subscribeToPremiumUpdates unsubscribe invokes removeCustomerInfoUpdateListener", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			assert.equal(typeof purchases.subscribeToPremiumUpdates, "function");
			await purchases.initPurchases();
			const unsub = purchases.subscribeToPremiumUpdates(() => {});
			assert.equal(ctx.purchases.listenerCount, 1);
			unsub();
			assert.equal(ctx.purchases.removeListenerCalls, 1);
			assert.equal(ctx.purchases.listenerCount, 0);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I2-10: userCancelled purchase returns false and premium_pass entitlement grants access", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			initialEntitlements: { premium_pass: { isActive: true } },
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			await purchases.initPurchases();
			assert.equal(await purchases.checkPremiumStatus(), true);
			ctx.purchases.userCancelledNextPurchase = true;
			const bought = await purchases.purchasePackage("$rc_monthly");
			assert.equal(bought, false);
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Item 7: lib/premium.ts Cleanup & Midnight Reset
	// =========================================================================

	test("T1-I7-01: lib/premium.ts removes setPremiumStatus export and PREMIUM_KEY", async () => {
		const source = readRepoFile("lib/premium.ts");
		assert.equal(
			source.includes("setPremiumStatus"),
			false,
			"lib/premium.ts must remove setPremiumStatus",
		);
		assert.equal(
			source.includes("PREMIUM_KEY"),
			false,
			"lib/premium.ts must remove PREMIUM_KEY",
		);
		const ctx = createE2EContext({
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			assert.equal("setPremiumStatus" in prem, false);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I7-02: isPremiumUser delegates to purchases status rather than legacy AsyncStorage key", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			initialStorage: { specimen_sandbox_premium_status: "true" },
			initialEntitlements: {},
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_test_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			const prem = await ctx.importFresh("lib/premium.ts");
			await purchases.initPurchases();
			assert.equal(await prem.isPremiumUser(), false);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I7-03: getSearchQuotaRemaining starts at FREE_SEARCH_LIMIT (3) on fresh install", async () => {
		const ctx = createE2EContext({
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			assert.equal(prem.FREE_SEARCH_LIMIT, 3);
			assert.equal(await prem.getSearchQuotaRemaining(), 3);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I7-04: incrementSearchQuotaUsed decrements quota 3 -> 2 -> 1 -> 0", async () => {
		const ctx = createE2EContext({
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			assert.equal(await prem.getSearchQuotaRemaining(), 3);
			assert.equal(await prem.incrementSearchQuotaUsed(), 2);
			assert.equal(await prem.incrementSearchQuotaUsed(), 1);
			assert.equal(await prem.incrementSearchQuotaUsed(), 0);
			assert.equal(await prem.getSearchQuotaRemaining(), 0);
		} finally {
			ctx.cleanup();
		}
	});

	test("T1-I7-05: app/index.tsx refreshes quota/premium on AppState foreground transition", () => {
		const ast = parseTsxAst("app/index.tsx");
		const calls = findCallExpressions(ast, "AppState.addEventListener");
		assert.ok(
			calls.length >= 1,
			"app/index.tsx must register an AppState.addEventListener handler",
		);

		const quotaFnNames = new Set([
			"refreshQuota",
			"getSearchQuotaRemaining",
			"checkPremiumStatus",
			"isPremiumUser",
		]);
		const refreshesQuotaInForeground = calls.some((call) => {
			const eventArg = call.arguments[0];
			const cbArg = call.arguments[1];
			if (
				!eventArg ||
				!ts.isStringLiteral(eventArg) ||
				eventArg.text !== "change" ||
				!cbArg ||
				(!ts.isArrowFunction(cbArg) && !ts.isFunctionExpression(cbArg))
			) {
				return false;
			}

			const invoked = new Set();
			walkAst(cbArg.body, (n) => {
				if (ts.isCallExpression(n)) {
					invoked.add(getNodeText(ast, n.expression));
				}
			});
			if ([...invoked].some((name) => quotaFnNames.has(name))) {
				return true;
			}
			for (const helperName of invoked) {
				if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(helperName)) continue;
				for (const helperFn of findFunctionsByName(ast, helperName)) {
					const helperCalls = new Set();
					walkAst(helperFn, (n) => {
						if (ts.isCallExpression(n)) {
							helperCalls.add(getNodeText(ast, n.expression));
						}
					});
					if ([...helperCalls].some((name) => quotaFnNames.has(name))) {
						return true;
					}
				}
			}
			return false;
		});

		assert.ok(
			refreshesQuotaInForeground,
			"AppState.addEventListener('change', ...) callback must actively refresh quota/premium state (not a no-op)",
		);
	});

	test("T2-I7-06: incrementSearchQuotaUsed resets count across midnight even if called without prior getSearchQuotaRemaining", async () => {
		const ctx = createE2EContext({
			initialStorage: {
				specimen_sandbox_last_search_date: "2020-01-01",
				specimen_sandbox_search_count: "3",
			},
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			const remaining = await prem.incrementSearchQuotaUsed();
			assert.equal(
				remaining,
				2,
				"Calling incrementSearchQuotaUsed on a new day must reset yesterday's count of 3 to 0 before incrementing to 1 (2 remaining)",
			);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I7-07: getSearchQuotaRemaining resets exhausted quota when lastSearchDate is yesterday", async () => {
		const ctx = createE2EContext({
			initialStorage: {
				specimen_sandbox_last_search_date: "2020-01-01",
				specimen_sandbox_search_count: "3",
			},
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			const remaining = await prem.getSearchQuotaRemaining();
			assert.equal(remaining, 3);
			assert.equal(ctx.asyncStorage.get("specimen_sandbox_search_count"), "0");
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I7-08: corrupted AsyncStorage search counts clamp safely without NaN", async () => {
		for (const badVal of ["NaN", "-5", "999", "abc"]) {
			const ctx = createE2EContext({
				env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
			});
			try {
				const daily = await ctx.importFresh("lib/dailyFlower.ts");
				const prem = await ctx.importFresh("lib/premium.ts");
				ctx.asyncStorage.set(
					"specimen_sandbox_last_search_date",
					daily.todayLocalIso(),
				);
				ctx.asyncStorage.set("specimen_sandbox_search_count", badVal);
				const remaining = await prem.getSearchQuotaRemaining();
				assert.equal(
					Number.isNaN(remaining),
					false,
					`Corrupted value "${badVal}" must not yield NaN`,
				);
				assert.ok(
					remaining >= 0 && remaining <= prem.FREE_SEARCH_LIMIT,
					`Corrupted value "${badVal}" yielded out-of-range quota ${remaining}`,
				);
			} finally {
				ctx.cleanup();
			}
		}
	});

	test("T2-I7-09: incrementSearchQuotaUsed clamps at 0 on excessive calls", async () => {
		const ctx = createE2EContext({
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			for (let i = 0; i < 6; i++) {
				const rem = await prem.incrementSearchQuotaUsed();
				assert.ok(rem >= 0, "Remaining quota must never go negative");
			}
			assert.equal(await prem.getSearchQuotaRemaining(), 0);
		} finally {
			ctx.cleanup();
		}
	});

	test("T2-I7-10: AsyncStorage failures fail closed to 0 without unhandled rejections", async () => {
		const ctx = createE2EContext({
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "true" },
		});
		try {
			const prem = await ctx.importFresh("lib/premium.ts");
			ctx.asyncStorage.has = () => {
				throw new Error("Disk I/O failure");
			};
			ctx.asyncStorage.get = () => {
				throw new Error("Disk I/O failure");
			};
			assert.equal(await prem.getSearchQuotaRemaining(), 0);
			assert.equal(await prem.incrementSearchQuotaUsed(), 0);
		} finally {
			ctx.cleanup();
		}
	});

	// =========================================================================
	// Tier 3: Pairwise Cross-Feature Integration
	// =========================================================================

	test("T3-01-01: subscribeToPremiumUpdates + isPremiumUser track live entitlement activation and revocation", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_pair_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			const prem = await ctx.importFresh("lib/premium.ts");
			await purchases.initPurchases();
			const updates = [];
			const unsub = purchases.subscribeToPremiumUpdates((v) => updates.push(v));
			assert.equal(await prem.isPremiumUser(), false);
			ctx.purchases.emitCustomerInfo({
				entitlements: { active: { premium: { isActive: true } } },
			});
			assert.equal(await prem.isPremiumUser(), true);
			ctx.purchases.emitCustomerInfo({ entitlements: { active: {} } });
			assert.equal(await prem.isPremiumUser(), false);
			unsub();
			assert.deepEqual(updates, [true, false]);
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-01-02: Web mock purchases flow triggers subscribeToPremiumUpdates and unlocks isPremiumUser", async () => {
		const ctx = createE2EContext({
			platform: "web",
			env: { EXPO_PUBLIC_USE_MOCK_PURCHASES: "false" },
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			const prem = await ctx.importFresh("lib/premium.ts");
			await purchases.initPurchases();
			const observed = [];
			const unsub = purchases.subscribeToPremiumUpdates((v) =>
				observed.push(v),
			);
			const ok = await purchases.purchasePackage("premium_monthly");
			assert.equal(ok, true);
			assert.equal(await prem.isPremiumUser(), true);
			assert.deepEqual(observed, [true]);
			unsub();
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-01-03: quota exhaustion -> midnight rollover reset -> restorePurchases unlock", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_pair_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			const prem = await ctx.importFresh("lib/premium.ts");
			await purchases.initPurchases();
			await prem.getSearchQuotaRemaining();
			await prem.incrementSearchQuotaUsed();
			await prem.incrementSearchQuotaUsed();
			assert.equal(await prem.incrementSearchQuotaUsed(), 0);
			// Simulate midnight rollover
			ctx.asyncStorage.set("specimen_sandbox_last_search_date", "2020-01-01");
			assert.equal(await prem.incrementSearchQuotaUsed(), 2);
			// Restore previous purchase
			ctx.purchases.activeEntitlements = { premium_pass: { isActive: true } };
			assert.equal(await purchases.restorePurchases(), true);
			assert.equal(await prem.isPremiumUser(), true);
		} finally {
			ctx.cleanup();
		}
	});

	test("T3-01-04: app/_layout.tsx and app/index.tsx wire initPurchases + subscribeToPremiumUpdates + __DEV__ gate", () => {
		const layoutSrc = readRepoFile("app/_layout.tsx");
		const indexSrc = readRepoFile("app/index.tsx");
		assert.match(layoutSrc, /initPurchases\s*\(/);
		assert.ok(
			/subscribeToPremiumUpdates/.test(layoutSrc) ||
				/subscribeToPremiumUpdates/.test(indexSrc),
			"Either app/_layout.tsx or app/index.tsx must subscribe to subscribeToPremiumUpdates",
		);
		assert.match(indexSrc, /handleEyebrowPress/);
		assert.match(indexSrc, /__DEV__/);
	});

	// =========================================================================
	// Tier 4: Real-World E2E Scenarios
	// =========================================================================

	test("T4-01-01: Full cold-start purchase, quota exhaustion, midnight reset, and live subscription E2E", async () => {
		const ctx = createE2EContext({
			platform: "ios",
			configureDelayMs: 25,
			env: {
				EXPO_PUBLIC_USE_MOCK_PURCHASES: "false",
				EXPO_PUBLIC_REVENUECAT_IOS_API_KEY: "appl_e2e_key",
			},
		});
		try {
			const purchases = await ctx.importFresh("lib/purchases.ts");
			const prem = await ctx.importFresh("lib/premium.ts");

			const listenerLog = [];
			const unsub = purchases.subscribeToPremiumUpdates((isPrem) =>
				listenerLog.push(isPrem),
			);

			// Concurrent app startup calls
			const [, initialPrem, offerings, initialQuota] = await Promise.all([
				purchases.initPurchases(),
				prem.isPremiumUser(),
				purchases.getSubscriptionOfferings(),
				prem.getSearchQuotaRemaining(),
			]);

			assert.equal(ctx.purchases.configureCalls, 1);
			assert.equal(initialPrem, false);
			assert.equal(offerings.length, 3);
			assert.equal(initialQuota, 3);

			// Exhaust 3 free searches
			assert.equal(await prem.incrementSearchQuotaUsed(), 2);
			assert.equal(await prem.incrementSearchQuotaUsed(), 1);
			assert.equal(await prem.incrementSearchQuotaUsed(), 0);

			// Simulate midnight rollover
			ctx.asyncStorage.set("specimen_sandbox_last_search_date", "2020-01-01");
			assert.equal(await prem.getSearchQuotaRemaining(), 3);

			// Upgrade via monthly offering
			const monthly = offerings.find((o) => o.packageType === "MONTHLY");
			assert.ok(monthly);
			assert.equal(await purchases.purchasePackage(monthly.identifier), true);
			assert.equal(await prem.isPremiumUser(), true);
			assert.deepEqual(listenerLog, [true]);

			unsub();
		} finally {
			ctx.cleanup();
		}
	});

	test("T4-01-02: Production paywall integrity audit across purchases, premium, and HomeScreen AST", async () => {
		const premSrc = readRepoFile("lib/premium.ts");
		const indexAst = parseTsxAst("app/index.tsx");
		const eyebrowFns = findFunctionsByName(indexAst, "handleEyebrowPress");
		assert.equal(eyebrowFns.length, 1);
		const eyebrowBody = getNodeText(indexAst, eyebrowFns[0]);

		assert.equal(premSrc.includes("setPremiumStatus"), false);
		assert.equal(premSrc.includes("PREMIUM_KEY"), false);
		assert.match(eyebrowBody, /__DEV__/);

		const indexSrc = readRepoFile("app/index.tsx");
		assert.match(indexSrc, /setPremiumModalVisible\(\s*true\s*\)/);
	});
});
