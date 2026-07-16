import Constants from "expo-constants";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Link, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { useEffect, useMemo, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Linking,
	Modal,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	TextInput,
	useWindowDimensions,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IridescentOverlay } from "@/components/IridescentOverlay";
import FlipCard from "@/components/ModernFlipCard";
import { useOnline } from "@/hooks/useOnline";

import {
	type DailyFlower,
	FlowerFetchError,
	fetchDailyFlower,
	getCachedFlower,
	getDefaultFlower,
	todayLocalIso,
} from "@/lib/dailyFlower";
import {
	FREE_SEARCH_LIMIT,
	getSearchQuotaRemaining,
	incrementSearchQuotaUsed,
	isPremiumUser,
} from "@/lib/premium";
import {
	getRegion,
	getRegionOverride,
	getRegionWithStatus,
	resetRegion,
	setRegionOverride,
} from "@/lib/region";
import {
	getDailyFlowerOffline,
	getSpeciesCount,
	type SpeciesRecord,
	searchSpeciesVector,
} from "@/lib/speciesDb";
import PremiumModal from "@/shared/components/PremiumModal";
import { styles } from "@/styles/home.styles";

type ErrorKind = "unpublished" | "service" | "network";

type State =
	| { status: "loading" }
	| { status: "ok"; flower: DailyFlower }
	| { status: "error"; kind: ErrorKind; message: string };

const ERROR_COPY: Record<ErrorKind, { title: string; sub: string }> = {
	unpublished: {
		title: "Coming soon to your area",
		sub: "No flower has been published for this date yet. It usually arrives by 4 a.m. Pacific.",
	},
	service: {
		title: "The flower service is having trouble",
		sub: "Please try again in a moment.",
	},
	network: {
		title: "Couldn't reach the flower service",
		sub: "Check your connection, then tap Try again.",
	},
};

const MONTH_SHORT = [
	"JAN",
	"FEB",
	"MAR",
	"APR",
	"MAY",
	"JUN",
	"JUL",
	"AUG",
	"SEP",
	"OCT",
	"NOV",
	"DEC",
];

/**
 * Add `days` to a `YYYY-MM-DD` string in the user's local calendar (anchored
 * at noon to dodge DST shifts).
 */
function offsetDate(base: string, days: number): string {
	const d = new Date(`${base}T12:00:00`);
	d.setDate(d.getDate() + days);
	const yyyy = d.getFullYear();
	const mm = String(d.getMonth() + 1).padStart(2, "0");
	const dd = String(d.getDate()).padStart(2, "0");
	return `${yyyy}-${mm}-${dd}`;
}

function formatDateLabel(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number);
	if (!y || !m || !d) return iso;
	return `${MONTH_SHORT[m - 1]} ${d} ${y}`;
}

export default function HomeScreen() {
	const [state, setState] = useState<State>({ status: "loading" });
	const [dayOffset, setDayOffset] = useState(0);
	const [reloadKey, setReloadKey] = useState(0);
	const [, setEyebrowTaps] = useState(0);
	const [devMenuVisible, setDevMenuVisible] = useState(false);
	const [activeOverride, setActiveOverride] = useState<string | null>(null);
	const [customCode, setCustomCode] = useState("");
	const [dbCount, setDbCount] = useState<number | null>(null);
	const online = useOnline();

	const [isPremium, setIsPremium] = useState(false);
	const [searchQuota, setSearchQuota] = useState(FREE_SEARCH_LIMIT);
	const [premiumModalVisible, setPremiumModalVisible] = useState(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey trigger
	useEffect(() => {
		async function loadPremiumData() {
			const prem = await isPremiumUser();
			setIsPremium(prem);
			const quota = await getSearchQuotaRemaining();
			setSearchQuota(quota);
		}
		loadPremiumData();
	}, [reloadKey]);

	const [searchVisible, setSearchVisible] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SpeciesRecord[]>([]);
	const [searching, setSearching] = useState(false);
	const router = useRouter();

	async function handleSearch() {
		if (!searchQuery.trim()) return;
		if (searchQuota <= 0 && !isPremium) {
			setPremiumModalVisible(true);
			return;
		}
		setSearching(true);
		try {
			const results = await searchSpeciesVector(searchQuery.trim());
			setSearchResults(results);
			if (!isPremium) {
				const remaining = await incrementSearchQuotaUsed();
				setSearchQuota(remaining);
			}
		} catch (e) {
			console.error("Search failed:", e);
			Alert.alert("Search Error", "Unable to complete search.");
		} finally {
			setSearching(false);
		}
	}

	const { width: winW, height: winH } = useWindowDimensions();
	// Portrait card sized to the screen: leaves room for the eyebrow at the top
	// and the nav row at the bottom. Caps width on tablets/desktop.
	const cardW = Math.min(winW - 48, 440);
	const cardH = Math.min(cardW * 1.35, winH - 220);

	// Extract a plain URI string from imageSource (only set for CDN flowers,
	// not for bundled require() fallbacks — those can't be serialised as a param).
	const detailImageUri =
		state.status === "ok" &&
		state.flower.imageSource != null &&
		typeof state.flower.imageSource === "object" &&
		"uri" in (state.flower.imageSource as Record<string, unknown>)
			? (state.flower.imageSource as { uri: string }).uri
			: null;

	useEffect(() => {
		async function checkDevData() {
			const over = await getRegionOverride();
			setActiveOverride(over);
			if (devMenuVisible) {
				const count = await getSpeciesCount();
				setDbCount(count);
			}
		}
		checkDevData();
	}, [devMenuVisible]);

	function handleEyebrowPress() {
		setEyebrowTaps((prev) => {
			const next = prev + 1;
			if (next >= 5) {
				setDevMenuVisible(true);
				return 0;
			}
			return next;
		});
	}

	async function applyOverride(regionCode: string | null) {
		await setRegionOverride(regionCode);
		setActiveOverride(regionCode);
		setDevMenuVisible(false);
		setDayOffset(0);
		setReloadKey((k) => k + 1);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey trigger
	useEffect(() => {
		let cancelled = false;

		async function load() {
			setState({ status: "loading" });
			const date = offsetDate(todayLocalIso(), dayOffset);
			let region = "default";
			try {
				if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true") {
					region = "CA";
				} else {
					region = await getRegion();
				}
				const flower = await fetchDailyFlower(region, date);
				if (!cancelled) setState({ status: "ok", flower });
			} catch (e) {
				if (cancelled) return;
				console.error("Flower fetch failed:", e);

				if (e instanceof FlowerFetchError && e.status === 404) {
					// 404 is a legitimate "coming soon" — keep the error treatment so
					// the user knows we don't have a flower for that exact date.
					setState({
						status: "error",
						kind: "unpublished",
						message: ERROR_COPY.unpublished.sub,
					});
				} else if (!online) {
					// Network down: prefer the last successfully fetched flower from
					// AsyncStorage; fall back to our pre-compiled SQLite species database.
					const cached = await getCachedFlower();
					if (cancelled) return;
					if (cached) {
						setState({ status: "ok", flower: { ...cached, isDefault: true } });
					} else {
						const dbFlower = await getDailyFlowerOffline(region, date);
						if (cancelled) return;
						if (dbFlower) {
							setState({
								status: "ok",
								flower: {
									imageSource: getDefaultFlower(date).imageSource, // daylight variants
									common: dbFlower.common,
									latin: dbFlower.latin,
									blurb: dbFlower.blurb,
									state: dbFlower.region,
									date,
									isDefault: true,
								},
							});
						} else {
							setState({
								status: "ok",
								flower: { ...getDefaultFlower(date), isDefault: true },
							});
						}
					}
				} else {
					// 5xx or other: retry once with backoff before falling through.
					await new Promise((r) => setTimeout(r, 1500));
					if (cancelled) return;
					try {
						region = await getRegion();
						const flower = await fetchDailyFlower(region, date);
						if (!cancelled) setState({ status: "ok", flower });
					} catch {
						if (cancelled) return;
						const cached = await getCachedFlower();
						if (cancelled) return;
						if (cached) {
							setState({
								status: "ok",
								flower: { ...cached, isDefault: true },
							});
						} else {
							const dbFlower = await getDailyFlowerOffline(region, date);
							if (cancelled) return;
							if (dbFlower) {
								setState({
									status: "ok",
									flower: {
										imageSource: getDefaultFlower(date).imageSource,
										common: dbFlower.common,
										latin: dbFlower.latin,
										blurb: dbFlower.blurb,
										state: dbFlower.region,
										date,
										isDefault: true,
									},
								});
							} else {
								setState({
									status: "ok",
									flower: { ...getDefaultFlower(date), isDefault: true },
								});
							}
						}
					}
				}
			}
		}

		load();
		return () => {
			cancelled = true;
		};
		// `online` is intentionally in the deps: when network state flips, we
		// want to refetch — coming back online should refresh today's flower
		// instead of leaving the user looking at the fallback.
	}, [dayOffset, reloadKey, online]);

	async function handleUpdateLocation() {
		await resetRegion();
		const { permissionDenied } = await getRegionWithStatus();
		if (permissionDenied) {
			Alert.alert(
				"Location access is off",
				"To show flowers native to your area, enable location access in Settings.",
				[
					{ text: "Not now", style: "cancel" },
					{ text: "Open Settings", onPress: () => Linking.openSettings() },
				],
			);
			return;
		}
		setDayOffset(0);
		setReloadKey((k) => k + 1);
	}

	const dateLabel = useMemo(() => {
		if (state.status === "ok") return formatDateLabel(state.flower.date);
		return formatDateLabel(offsetDate(todayLocalIso(), dayOffset));
	}, [state, dayOffset]);

	const eyebrowRegion =
		state.status === "ok"
			? state.flower.state === "default"
				? "YOUR AREA"
				: state.flower.state
			: "YOUR AREA";

	return (
		<View style={styles.root}>
			<StatusBar style="light" />
			<SafeAreaView style={styles.fill}>
				<View
					style={[
						styles.topBarRow,
						process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true" && {
							paddingRight: 80,
						},
					]}
				>
					<Pressable onPress={handleEyebrowPress} style={styles.topBar}>
						<Text style={styles.eyebrow}>
							{eyebrowRegion} · {dateLabel}
						</Text>
					</Pressable>
					<Pressable
						onPress={() => setSearchVisible(true)}
						style={styles.searchBarBtn}
						accessibilityLabel="Search species"
					>
						<Text style={styles.searchBarBtnLabel}>🔍 SEARCH</Text>
					</Pressable>
				</View>

				<View style={styles.stage}>
					{state.status === "loading" && (
						<View style={[styles.placeholder, { width: cardW, height: cardH }]}>
							<ActivityIndicator size="small" color="rgba(255,255,255,0.5)" />
							<Text style={styles.loadingLabel}>
								FINDING TODAY&apos;S BLOOM
							</Text>
						</View>
					)}

					{state.status === "error" && (
						<View style={[styles.placeholder, { width: cardW, height: cardH }]}>
							<Text style={styles.errorTitle}>
								{ERROR_COPY[state.kind].title}
							</Text>
							<Text style={styles.errorSub}>{state.message}</Text>
							<Pressable
								style={styles.primaryBtn}
								onPress={() => setReloadKey((k) => k + 1)}
							>
								<Text style={styles.primaryBtnLabel}>Try again</Text>
							</Pressable>
						</View>
					)}

					{state.status === "ok" && (
						<View style={styles.cardWrap}>
							<View style={styles.glow} />
							<FlipCard
								key={`${state.flower.date}:${state.flower.state}`}
								style={{ width: cardW, height: cardH }}
							>
								{/* Front: image */}
								<View style={styles.face}>
									<Image
										source={state.flower.imageSource}
										style={[StyleSheet.absoluteFill, styles.imageRadius]}
										contentFit="cover"
										cachePolicy="memory-disk"
										transition={400}
										preferHighDynamicRange
										accessibilityLabel={state.flower.common}
									/>
									{__DEV__ && (
										<View style={styles.sandboxBadge}>
											<Text style={styles.sandboxBadgeText}>SANDBOX</Text>
										</View>
									)}
									{state.flower.isDefault && (
										<View style={styles.fallbackBadge}>
											<Text style={styles.fallbackBadgeText}>
												OFFLINE · ARCHIVE
											</Text>
										</View>
									)}
									<IridescentOverlay subtle />
									<LinearGradient
										pointerEvents="none"
										colors={["rgba(0,0,0,0)", "rgba(0,0,0,0.55)"]}
										style={styles.hintScrim}
									/>
									<Text style={styles.hint}>TAP TO READ</Text>

									{/* Expand button — zoom-transitions to the full-screen detail view.
                      Only shown when we have a real CDN URI (not a bundled fallback). */}
									{detailImageUri != null && (
										<Link
											href={{
												pathname: "/flower-detail",
												params: {
													imageUri: detailImageUri,
													common: state.flower.common,
													latin: state.flower.latin,
													blurb: state.flower.blurb,
													state: state.flower.state,
													date: state.flower.date,
												},
											}}
											asChild
										>
											<Link.Trigger withAppleZoom>
												<Pressable
													style={styles.expandBtn}
													accessibilityLabel="View full screen"
													accessibilityRole="button"
												>
													<Text style={styles.expandIcon}>↗</Text>
												</Pressable>
											</Link.Trigger>
										</Link>
									)}
								</View>

								{/* Back: serif info panel */}
								<View style={styles.face}>
									<LinearGradient
										colors={["#1a1a1a", "#0a0a0a"]}
										start={{ x: 0, y: 0 }}
										end={{ x: 0, y: 1 }}
										style={[styles.back, styles.imageRadius]}
									>
										<IridescentOverlay />
										<Text style={styles.backEyebrow}>SPECIES</Text>
										<Text style={styles.common} selectable>
											{state.flower.common}
										</Text>
										<Text style={styles.latin} selectable>
											{state.flower.latin}
										</Text>
										<View style={styles.rule} />
										<Text style={styles.blurb} selectable>
											{state.flower.blurb}
										</Text>
										<Text style={styles.hintBack} selectable={false}>
											TAP TO FLIP BACK
										</Text>
									</LinearGradient>
								</View>
							</FlipCard>
						</View>
					)}
				</View>

				<View style={styles.nav}>
					<Pressable
						style={[
							styles.navBtn,
							dayOffset <= -6 && styles.navBtnDisabled,
							process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true" && {
								borderColor: "transparent",
								backgroundColor: "transparent",
							},
						]}
						onPress={() => {
							const target = dayOffset - 1;
							if (target < -2 && !isPremium) {
								setPremiumModalVisible(true);
							} else {
								setDayOffset(Math.max(target, -6));
							}
						}}
						disabled={dayOffset <= -6}
						hitSlop={8}
					>
						<Text
							style={[
								styles.navLabel,
								process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true" && {
									color: "transparent",
								},
							]}
						>
							← Yesterday
							{!isPremium && dayOffset <= -2 && (
								<Text style={styles.navLockIcon}> 🔒</Text>
							)}
						</Text>
					</Pressable>

					{dayOffset === 0 && (
						<Pressable
							style={styles.travelModeBtn}
							onPress={() => {
								if (!isPremium) {
									setPremiumModalVisible(true);
								} else {
									setDevMenuVisible(true);
								}
							}}
							hitSlop={8}
						>
							<Text style={styles.travelModeLabel}>
								✈️ Travel Mode
								{!isPremium && <Text style={styles.travelModeLock}> 🔒</Text>}
							</Text>
						</Pressable>
					)}

					{dayOffset < 0 ? (
						<Pressable
							style={[
								styles.navBtn,
								process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true" && {
									borderColor: "transparent",
									backgroundColor: "transparent",
								},
							]}
							onPress={() => setDayOffset(0)}
							hitSlop={8}
						>
							<Text
								style={[
									styles.navLabel,
									process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true" && {
										color: "transparent",
									},
								]}
							>
								Today →
							</Text>
						</Pressable>
					) : (
						<Pressable onPress={handleUpdateLocation} hitSlop={8}>
							<Text
								style={[
									styles.navSubtle,
									process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true" && {
										color: "transparent",
									},
								]}
							>
								Update location
							</Text>
						</Pressable>
					)}
				</View>
			</SafeAreaView>

			<Modal
				visible={devMenuVisible}
				animationType="slide"
				transparent={true}
				onRequestClose={() => setDevMenuVisible(false)}
			>
				<View style={styles.modalOverlay}>
					<View style={styles.modalContent}>
						<Text style={styles.modalHeader}>
							{isPremium ? "✈️ Travel Mode" : "Dev Controls"}
						</Text>

						<Text style={styles.overrideLabel}>
							{isPremium ? "Current Destination:" : "Active Location:"}
						</Text>
						<Text style={styles.overrideStatus}>
							{activeOverride
								? activeOverride
								: isPremium
									? "Home (No Active Override)"
									: "Real System Location (No Override)"}
						</Text>

						<Text style={styles.sectionTitle}>
							{isPremium ? "Select Destination" : "Quick Select"}
						</Text>
						<ScrollView
							contentContainerStyle={styles.chipContainer}
							showsVerticalScrollIndicator={false}
							style={{ maxHeight: 150 }}
						>
							{[
								{ code: null, label: "System" },
								{ code: "default", label: "Default" },
								{ code: "MX", label: "MX (Mexico)" },
								{ code: "IS", label: "IS (Iceland)" },
								{ code: "RU", label: "RU (Russia)" },
								{ code: "CN", label: "CN (China)" },
								{ code: "CA-ON", label: "CA-ON (Ontario)" },
								{ code: "CA-BC", label: "CA-BC" },
								{ code: "CA", label: "CA (California)" },
								{ code: "NY", label: "NY (New York)" },
								{ code: "TX", label: "TX (Texas)" },
							].map((item) => {
								const isSelected = activeOverride === item.code;
								return (
									<Pressable
										key={String(item.code)}
										style={[styles.chip, isSelected && styles.chipSelected]}
										onPress={() => applyOverride(item.code)}
									>
										<Text
											style={[
												styles.chipText,
												isSelected && styles.chipTextSelected,
											]}
										>
											{item.label}
										</Text>
									</Pressable>
								);
							})}
						</ScrollView>

						<Text style={[styles.sectionTitle, { marginTop: 16 }]}>
							Custom Code
						</Text>
						<View style={styles.inputContainer}>
							<TextInput
								style={styles.textInput}
								placeholder="e.g. CA-QC, AL, WY"
								placeholderTextColor="rgba(255,255,255,0.3)"
								value={customCode}
								onChangeText={setCustomCode}
								autoCapitalize="characters"
								autoCorrect={false}
							/>
							<Pressable
								style={styles.applyBtn}
								onPress={() => {
									const trimmed = customCode.trim().toUpperCase();
									if (!trimmed) {
										Alert.alert("Invalid Code", "Please enter a region code.");
										return;
									}
									applyOverride(trimmed);
								}}
							>
								<Text style={styles.applyBtnText}>Apply</Text>
							</Pressable>
						</View>

						<Text style={[styles.sectionTitle, { marginTop: 16 }]}>
							Diagnostics
						</Text>
						<View style={{ marginBottom: 12 }}>
							<Text
								style={{
									color: "rgba(255,255,255,0.7)",
									fontSize: 13,
									marginBottom: 4,
								}}
							>
								App Version: {Constants.expoConfig?.version || "Unknown"}
							</Text>
							<Text
								style={{
									color: "rgba(255,255,255,0.7)",
									fontSize: 13,
									marginBottom: 4,
								}}
							>
								OTA Update ID: {Updates.updateId || "None (Dev/Base Build)"}
							</Text>
							<Text
								style={{
									color: "rgba(255,255,255,0.7)",
									fontSize: 13,
									marginBottom: 4,
								}}
							>
								Environment: {__DEV__ ? "Development" : "Production"}
							</Text>
							<Text
								style={{
									color: "rgba(255,255,255,0.7)",
									fontSize: 13,
									marginBottom: 4,
								}}
							>
								Local Species DB:{" "}
								{dbCount !== null ? `${dbCount} records` : "Loading..."}
							</Text>
						</View>

						<Pressable
							style={styles.dismissBtn}
							onPress={() => setDevMenuVisible(false)}
						>
							<Text style={styles.dismissBtnText}>Dismiss</Text>
						</Pressable>
					</View>
				</View>
			</Modal>

			{/* Search Modal */}
			<Modal
				visible={searchVisible}
				animationType="fade"
				transparent={true}
				onRequestClose={() => {
					setSearchVisible(false);
					setSearchQuery("");
					setSearchResults([]);
				}}
			>
				<View style={styles.modalOverlay}>
					<View
						style={[styles.modalContent, { maxWidth: 450, maxHeight: "85%" }]}
					>
						<Text style={styles.modalHeader}>Vector Vibe Search</Text>
						{!isPremium && (
							<Text style={styles.quotaCount}>
								Free quota: {searchQuota} of {FREE_SEARCH_LIMIT} searches left
								today
							</Text>
						)}

						<View style={styles.inputContainer}>
							<TextInput
								style={styles.textInput}
								placeholder="e.g. purple spring poppy or desert cactus..."
								placeholderTextColor="rgba(255,255,255,0.4)"
								value={searchQuery}
								onChangeText={setSearchQuery}
								onSubmitEditing={handleSearch}
								autoCorrect={false}
							/>
							<Pressable
								style={styles.applyBtn}
								onPress={handleSearch}
								disabled={searching}
							>
								{searching ? (
									<ActivityIndicator size="small" color="#000" />
								) : (
									<Text style={styles.applyBtnText}>Search</Text>
								)}
							</Pressable>
						</View>

						{searchQuota <= 0 && !isPremium ? (
							<View
								style={{
									flex: 1,
									justifyContent: "center",
									alignItems: "center",
									paddingVertical: 40,
								}}
							>
								<Text style={{ fontSize: 44, marginBottom: 12 }}>🔒</Text>
								<Text style={styles.premiumLockTitle}>
									Search Limit Reached
								</Text>
								<Text style={styles.premiumLockDesc}>
									You've used your 3 free daily vector searches. Upgrade to
									Premium for unlimited offline searches.
								</Text>
								<Pressable
									style={styles.premiumLockBtn}
									onPress={() => setPremiumModalVisible(true)}
								>
									<Text style={styles.premiumLockBtnText}>
										UNLOCK UNLIMITED SEARCH
									</Text>
								</Pressable>
							</View>
						) : (
							<ScrollView
								style={{ marginTop: 12, flex: 1 }}
								showsVerticalScrollIndicator={false}
							>
								{searchResults.length === 0 && !searching && (
									<Text style={styles.noResultsText}>
										{
											'Type a description or vibe (like "yellow autumn bloom") to search the offline database using semantic embeddings.'
										}
									</Text>
								)}
								{searchResults.map((result) => {
									const pct = result.similarity
										? Math.round(result.similarity * 100)
										: 50;
									return (
										<Pressable
											key={result.id}
											style={styles.searchResultItem}
											onPress={() => {
												setSearchVisible(false);
												setSearchQuery("");
												setSearchResults([]);
												router.push({
													pathname: "/flower-detail",
													params: {
														imageUri: "", // Forces local fallback image in details screen
														common: result.common,
														latin: result.latin,
														blurb: result.blurb,
														state: result.region,
														date: todayLocalIso(),
													},
												});
											}}
										>
											<View style={styles.searchResultHeader}>
												<Text style={styles.searchResultCommon}>
													{result.common}
												</Text>
												<Text style={styles.searchResultMatch}>
													{pct}% match
												</Text>
											</View>
											<Text style={styles.searchResultLatin}>
												{result.latin}
											</Text>
											<Text style={styles.searchResultRegion}>
												Region: {result.region}
											</Text>
										</Pressable>
									);
								})}
							</ScrollView>
						)}

						<Pressable
							style={styles.dismissBtn}
							onPress={() => {
								setSearchVisible(false);
								setSearchQuery("");
								setSearchResults([]);
							}}
						>
							<Text style={styles.dismissBtnText}>Close</Text>
						</Pressable>
					</View>
				</View>
			</Modal>

			<PremiumModal
				visible={premiumModalVisible}
				onClose={() => setPremiumModalVisible(false)}
				onSuccess={() => {
					setIsPremium(true);
					setReloadKey((k) => k + 1);
				}}
			/>
		</View>
	);
}
