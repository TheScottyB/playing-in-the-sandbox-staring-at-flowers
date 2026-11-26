import Constants from "expo-constants";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Link, useRouter } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as Updates from "expo-updates";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	AppState,
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
import { DEFAULT_FLOWER } from "@/data/defaults";
import { useOnline } from "@/hooks/useOnline";

import {
	alternateImageUrlFor,
	archivePhotoForLatin,
	type DailyFlower,
	FlowerFetchError,
	fetchArchiveFlower,
	fetchDailyFlower,
	formatBloomMonths,
	getCachedFlower,
	getDefaultFlower,
	todayLocalIso,
} from "@/lib/dailyFlower";
import {
	FREE_SEARCH_LIMIT,
	getSearchQuotaRemaining,
	incrementSearchQuotaUsed,
	isPremiumUserWithVerification,
} from "@/lib/premium";
import { subscribeToPremiumUpdates } from "@/lib/purchases";
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
	isSearchQueryEligible,
	MAX_QUERY_CHARS,
	type SpeciesRecord,
	searchSpeciesVector,
} from "@/lib/speciesDb";
import PremiumModal from "@/shared/components/PremiumModal";
import { PALETTE, TYPE } from "@/shared/constants/brand";
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

function offlineSpeciesToDailyFlower(
	dbFlower: SpeciesRecord,
	date: string,
): DailyFlower {
	const isCaliforniaPoppy =
		dbFlower.latin === DEFAULT_FLOWER.latin ||
		dbFlower.common === DEFAULT_FLOWER.common;
	if (isCaliforniaPoppy) {
		const fallback = getDefaultFlower(date);
		return {
			imageSource: fallback.imageSource,
			common: dbFlower.common,
			latin: dbFlower.latin,
			blurb: dbFlower.blurb || fallback.blurb,
			state: dbFlower.region,
			date,
			isDefault: true,
			isPlaceholder: false,
			bloomMonths: dbFlower.bloomMonths,
			timeOfDay: fallback.timeOfDay,
		};
	}
	return {
		imageSource: null,
		common: dbFlower.common,
		latin: dbFlower.latin,
		blurb: dbFlower.blurb,
		state: dbFlower.region,
		date,
		isDefault: true,
		isPlaceholder: true,
		bloomMonths: dbFlower.bloomMonths,
	};
}

async function resolveOfflineFallbackFlower(
	region: string,
	date: string,
	includeCached: boolean,
): Promise<DailyFlower> {
	if (includeCached) {
		const cached = await getCachedFlower(region);
		if (cached && cached.state === region && cached.date === date) {
			return { ...cached, isDefault: true };
		}
	}
	// A real photograph from the published archive beats a text-only card.
	const archived = await fetchArchiveFlower(region, date);
	if (archived) return archived;
	const dbFlower =
		(await getDailyFlowerOffline(region, date)) ??
		(region !== "default"
			? await getDailyFlowerOffline("default", date)
			: null);
	if (dbFlower) {
		return offlineSpeciesToDailyFlower(dbFlower, date);
	}
	return { ...getDefaultFlower(date), isDefault: true };
}

const SEARCH_SUGGESTIONS = [
	"poppy",
	"sunflower",
	"lupine",
	"orchid",
	"lily",
	"violet",
	"cactus",
	"yellow autumn",
];
const SPECIES_TOTAL_LABEL = "396";

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
	const [fallbackImageUri, setFallbackImageUri] = useState<string | null>(null);
	const [imageLoadFailed, setImageLoadFailed] = useState(false);
	const loadedDateRef = useRef<string>(todayLocalIso());
	const dayOffsetRef = useRef<number>(dayOffset);
	dayOffsetRef.current = dayOffset;

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey trigger
	useEffect(() => {
		let cancelled = false;
		async function loadPremiumData() {
			const { isPremium: prem, verified } =
				await isPremiumUserWithVerification();
			if (cancelled) return;
			setIsPremium(prem);
			if (!__DEV__ && verified && !prem) {
				setDevMenuVisible(false);
				const existingOverride = await getRegionOverride();
				if (cancelled) return;
				if (existingOverride !== null) {
					await setRegionOverride(null);
					if (cancelled) return;
					setActiveOverride(null);
					setReloadKey((k) => k + 1);
				}
			}
			const quota = await getSearchQuotaRemaining();
			if (!cancelled) setSearchQuota(quota);
		}
		void loadPremiumData();

		const sub = AppState.addEventListener("change", (nextState) => {
			if (nextState === "active") {
				void loadPremiumData();
				if (
					dayOffsetRef.current === 0 &&
					todayLocalIso() !== loadedDateRef.current
				) {
					setReloadKey((k) => k + 1);
				}
			}
		});
		return () => {
			cancelled = true;
			sub.remove();
		};
	}, [reloadKey]);

	useEffect(() => {
		let cancelled = false;
		const unsubscribe = subscribeToPremiumUpdates((prem) => {
			if (cancelled) return;
			setIsPremium(prem);
			if (!__DEV__ && !prem) {
				setDevMenuVisible(false);
				void (async () => {
					const existingOverride = await getRegionOverride();
					if (cancelled || existingOverride === null) return;
					await setRegionOverride(null);
					if (cancelled) return;
					setActiveOverride(null);
					setReloadKey((k) => k + 1);
				})();
			}
		});
		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, []);

	const [searchVisible, setSearchVisible] = useState(false);
	const [searchQuery, setSearchQuery] = useState("");
	const [searchResults, setSearchResults] = useState<SpeciesRecord[]>([]);
	const [searching, setSearching] = useState(false);
	const [searchHint, setSearchHint] = useState<string | null>(null);
	const searchingRef = useRef(false);
	const router = useRouter();

	async function handleSearch(overrideQuery?: string) {
		if (searchingRef.current) return;
		const trimmed = (overrideQuery ?? searchQuery)
			.trim()
			.slice(0, MAX_QUERY_CHARS);
		if (!isSearchQueryEligible(trimmed)) {
			setSearchResults([]);
			setSearchHint(
				"Enter at least 2 characters with a flower name, color, season, or region.",
			);
			return;
		}
		setSearchHint(null);
		searchingRef.current = true;
		setSearching(true);
		try {
			if (!isPremium) {
				const currentQuota = await getSearchQuotaRemaining();
				setSearchQuota(currentQuota);
				if (currentQuota <= 0) {
					setSearchVisible(false);
					setSearchResults([]);
					setPremiumModalVisible(true);
					return;
				}
			}
			const results = await searchSpeciesVector(trimmed);
			setSearchResults(results);
			if (!isPremium) {
				const remaining = await incrementSearchQuotaUsed();
				setSearchQuota(remaining);
			}
		} catch (e) {
			console.error("Search failed:", e);
			Alert.alert("Search Error", "Unable to complete search.");
		} finally {
			searchingRef.current = false;
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
	const extractedImageUri =
		state.status === "ok" &&
		state.flower.imageSource != null &&
		typeof state.flower.imageSource === "object" &&
		"uri" in (state.flower.imageSource as Record<string, unknown>)
			? (state.flower.imageSource as { uri: string }).uri
			: null;
	const detailImageUri = fallbackImageUri ?? extractedImageUri;
	const activeImageSource = fallbackImageUri
		? { uri: fallbackImageUri }
		: state.status === "ok"
			? (state.flower.imageSource ?? null)
			: null;

	const flowerIdentity =
		state.status === "ok"
			? `${state.flower.state}:${state.flower.date}:${state.flower.common}:${extractedImageUri ?? ""}:${Boolean(state.flower.isDefault)}`
			: "";

	// biome-ignore lint/correctness/useExhaustiveDependencies: reset image error state when active flower changes
	useEffect(() => {
		setFallbackImageUri(null);
		setImageLoadFailed(false);
	}, [flowerIdentity]);

	function handleCardImageError() {
		const currentUri = detailImageUri;
		if (currentUri && !fallbackImageUri) {
			const alt = alternateImageUrlFor(currentUri);
			if (alt) {
				setFallbackImageUri(alt);
				return;
			}
		}
		setImageLoadFailed(true);
	}

	useEffect(() => {
		let cancelled = false;
		async function checkDevData() {
			const over = await getRegionOverride();
			if (cancelled) return;
			if (__DEV__ || isPremium) {
				setActiveOverride(over);
			} else {
				setActiveOverride(null);
			}
			if (__DEV__ && devMenuVisible) {
				const count = await getSpeciesCount();
				if (!cancelled) setDbCount(count);
			}
		}
		void checkDevData();
		return () => {
			cancelled = true;
		};
	}, [devMenuVisible, isPremium]);

	function handleEyebrowPress() {
		if (!__DEV__) return;
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
		if (!__DEV__ && !isPremium) return;
		await setRegionOverride(regionCode);
		setActiveOverride(regionCode);
		setDevMenuVisible(false);
		setDayOffset(0);
		setReloadKey((k) => k + 1);
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey trigger
	useEffect(() => {
		let cancelled = false;

		async function resolveEffectiveRegion(): Promise<string> {
			if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true") {
				return "CA";
			}
			if (!__DEV__) {
				const existingOverride = await getRegionOverride();
				if (existingOverride !== null) {
					const { isPremium: prem, verified } =
						await isPremiumUserWithVerification();
					if (verified && !prem) {
						await setRegionOverride(null);
						if (!cancelled) setActiveOverride(null);
					}
				}
			}
			return getRegion();
		}

		async function load() {
			setState({ status: "loading" });
			const today = todayLocalIso();
			loadedDateRef.current = today;
			const date = offsetDate(today, dayOffset);
			let region = "default";
			try {
				region = await resolveEffectiveRegion();
				if (cancelled) return;
				const flower = await fetchDailyFlower(region, date);
				if (!cancelled) setState({ status: "ok", flower });
			} catch (e) {
				if (cancelled) return;
				console.error("Flower fetch failed:", e);

				if (e instanceof FlowerFetchError && e.status === 404) {
					if (region !== "default") {
						try {
							const defaultFlower = await fetchDailyFlower("default", date);
							if (!cancelled) setState({ status: "ok", flower: defaultFlower });
							return;
						} catch (defaultErr) {
							if (cancelled) return;
							const includeCached = !(
								defaultErr instanceof FlowerFetchError &&
								defaultErr.status === 404
							);
							const fallback = await resolveOfflineFallbackFlower(
								region,
								date,
								includeCached,
							);
							if (!cancelled) setState({ status: "ok", flower: fallback });
							return;
						}
					}
					const fallback = await resolveOfflineFallbackFlower(
						region,
						date,
						false,
					);
					if (!cancelled) setState({ status: "ok", flower: fallback });
				} else if (!online) {
					const fallback = await resolveOfflineFallbackFlower(
						region,
						date,
						true,
					);
					if (!cancelled) setState({ status: "ok", flower: fallback });
				} else {
					// 5xx or other: retry once with backoff before falling through.
					await new Promise((r) => setTimeout(r, 1500));
					if (cancelled) return;
					try {
						region = await resolveEffectiveRegion();
						if (cancelled) return;
						const flower = await fetchDailyFlower(region, date);
						if (!cancelled) setState({ status: "ok", flower });
					} catch (retryErr) {
						if (cancelled) return;
						if (
							retryErr instanceof FlowerFetchError &&
							retryErr.status === 404 &&
							region !== "default"
						) {
							try {
								const defaultFlower = await fetchDailyFlower("default", date);
								if (!cancelled) {
									setState({ status: "ok", flower: defaultFlower });
								}
								return;
							} catch {
								if (cancelled) return;
							}
						}
						const is404 =
							retryErr instanceof FlowerFetchError && retryErr.status === 404;
						const fallback = await resolveOfflineFallbackFlower(
							region,
							date,
							!is404,
						);
						if (!cancelled) setState({ status: "ok", flower: fallback });
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
		const hadOverride =
			activeOverride !== null || (await getRegionOverride()) !== null;
		const prevDisplayedRegion =
			state.status === "ok" ? state.flower.state : null;
		const isLoading = state.status === "loading";
		await setRegionOverride(null);
		setActiveOverride(null);
		await resetRegion();
		const { region: nextRegion, permissionDenied } =
			await getRegionWithStatus();
		if (permissionDenied) {
			if (hadOverride) {
				setDayOffset(0);
				setReloadKey((k) => k + 1);
			} else if (
				isLoading ||
				(prevDisplayedRegion !== null && nextRegion !== prevDisplayedRegion)
			) {
				setDayOffset(0);
				setReloadKey((k) => k + 1);
			}
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
					<Pressable
						onPress={__DEV__ ? handleEyebrowPress : undefined}
						disabled={!__DEV__}
						style={styles.topBar}
					>
						<Text style={styles.eyebrow}>
							{eyebrowRegion} · {dateLabel}
						</Text>
					</Pressable>
					<Pressable
						onPress={() => {
							setSearchVisible(true);
							void getSearchQuotaRemaining().then(setSearchQuota);
						}}
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

					{state.status === "ok" &&
						(() => {
							const bloomLabel = formatBloomMonths(state.flower.bloomMonths);
							const isSpecimenCard =
								activeImageSource == null || imageLoadFailed;
							const showExpandBtn =
								detailImageUri != null ||
								Boolean(state.flower.isPlaceholder) ||
								imageLoadFailed ||
								Boolean(state.flower.isDefault);
							return (
								<View style={styles.cardWrap}>
									<View style={styles.glow} />
									<FlipCard
										key={`${state.flower.date}:${state.flower.state}`}
										style={{ width: cardW, height: cardH }}
									>
										{/* Front: image or botanical specimen card */}
										<View style={styles.face}>
											{!isSpecimenCard ? (
												<Image
													source={activeImageSource}
													onError={handleCardImageError}
													style={[StyleSheet.absoluteFill, styles.imageRadius]}
													contentFit="cover"
													cachePolicy="memory-disk"
													transition={400}
													preferHighDynamicRange
													accessibilityLabel={state.flower.common}
												/>
											) : (
												<LinearGradient
													colors={["#1a1a20", "#0a0a0c"]}
													start={{ x: 0, y: 0 }}
													end={{ x: 0, y: 1 }}
													style={[styles.back, styles.imageRadius]}
												>
													<Text style={specimenStyles.frontEyebrow}>
														NO PHOTO CACHED · SPECIMEN
													</Text>
													<Text style={styles.common} numberOfLines={3}>
														{state.flower.common}
													</Text>
													<Text style={styles.latin}>{state.flower.latin}</Text>
													<View style={styles.rule} />
													{bloomLabel !== "" && (
														<Text style={specimenStyles.bloomText}>
															BLOOMS: {bloomLabel}
														</Text>
													)}
													<Text style={specimenStyles.specimenNote}>
														{state.flower.blurb?.trim() ||
															"Regional specimen record from your offline botanical archive."}
													</Text>
												</LinearGradient>
											)}
											{__DEV__ && (
												<View style={styles.sandboxBadge}>
													<Text style={styles.sandboxBadgeText}>SANDBOX</Text>
												</View>
											)}
											{state.flower.archivedFrom && !state.flower.isDefault && (
												<View
													style={[
														styles.fallbackBadge,
														showExpandBtn && { right: 56 },
													]}
												>
													<Text style={styles.fallbackBadgeText}>
														FROM THE ARCHIVE ·{" "}
														{formatDateLabel(state.flower.archivedFrom)}
													</Text>
												</View>
											)}
											{state.flower.isDefault && (
												<View
													style={[
														styles.fallbackBadge,
														showExpandBtn && { right: 56 },
													]}
												>
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

											{showExpandBtn && (
												<Link
													href={{
														pathname: "/flower-detail",
														params: {
															imageUri: imageLoadFailed
																? ""
																: (detailImageUri ?? ""),
															source:
																state.flower.isPlaceholder || imageLoadFailed
																	? "offline"
																	: state.flower.isDefault
																		? "default"
																		: "daily",
															isPlaceholder:
																state.flower.isPlaceholder || imageLoadFailed
																	? "1"
																	: "0",
															common: state.flower.common,
															latin: state.flower.latin,
															blurb: state.flower.blurb,
															bloomMonths: state.flower.bloomMonths
																? JSON.stringify(state.flower.bloomMonths)
																: "",
															timeOfDay: state.flower.timeOfDay ?? "",
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
												{bloomLabel !== "" && (
													<Text style={specimenStyles.backBloom}>
														BLOOM SEASON: {bloomLabel}
													</Text>
												)}
												<View style={styles.rule} />
												<Text style={styles.blurb} selectable>
													{state.flower.blurb?.trim() ||
														"Native regional specimen. Connect to fetch today's botanical photography and notes."}
												</Text>
												<Text style={styles.hintBack} selectable={false}>
													TAP TO FLIP BACK
												</Text>
											</LinearGradient>
										</View>
									</FlipCard>
								</View>
							);
						})()}
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
				visible={devMenuVisible && (__DEV__ || isPremium)}
				animationType="slide"
				transparent={true}
				onRequestClose={() => setDevMenuVisible(false)}
			>
				<View style={styles.modalOverlay}>
					<View style={styles.modalContent}>
						<Text style={styles.modalHeader}>
							{isPremium || !__DEV__ ? "✈️ Travel Mode" : "Dev Controls"}
						</Text>

						<Text style={styles.overrideLabel}>
							{isPremium || !__DEV__
								? "Current Destination:"
								: "Active Location:"}
						</Text>
						<Text style={styles.overrideStatus}>
							{activeOverride
								? activeOverride
								: isPremium || !__DEV__
									? "Home (No Active Override)"
									: "Real System Location (No Override)"}
						</Text>

						<Text style={styles.sectionTitle}>
							{isPremium || !__DEV__ ? "Select Destination" : "Quick Select"}
						</Text>
						<ScrollView
							contentContainerStyle={styles.chipContainer}
							showsVerticalScrollIndicator={false}
							style={{ maxHeight: 150 }}
						>
							{[
								{ code: null, label: __DEV__ ? "System" : "My Location" },
								...(__DEV__ ? [{ code: "default", label: "Default" }] : []),
								{ code: "MX-MEX", label: "MX-MEX (Mexico)" },
								{ code: "IS", label: "IS (Iceland)" },
								{ code: "RU-MOW", label: "RU-MOW (Russia)" },
								{ code: "CN-BJ", label: "CN-BJ (China)" },
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

						{__DEV__ && (
							<>
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
							</>
						)}

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
					setSearchHint(null);
				}}
			>
				<View style={styles.modalOverlay}>
					<View
						style={[styles.modalContent, { maxWidth: 450, maxHeight: "85%" }]}
					>
						<Text style={styles.modalHeader}>Botanical Search</Text>
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
								onChangeText={(text) => {
									setSearchQuery(text);
									if (searchHint) setSearchHint(null);
								}}
								onSubmitEditing={() => handleSearch()}
								maxLength={200}
								autoCorrect={false}
							/>
							<Pressable
								style={styles.applyBtn}
								onPress={() => handleSearch()}
								disabled={searching}
							>
								{searching ? (
									<ActivityIndicator size="small" color="#000" />
								) : (
									<Text style={styles.applyBtnText}>Search</Text>
								)}
							</Pressable>
						</View>

						{searchQuota <= 0 && !isPremium && searchResults.length === 0 ? (
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
									You've used your 3 free daily searches. Upgrade to Premium for
									unlimited offline botanical searches.
								</Text>
								<Pressable
									style={styles.premiumLockBtn}
									onPress={() => {
										setSearchVisible(false);
										setPremiumModalVisible(true);
									}}
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
									<>
										<Text style={styles.noResultsText}>
											{searchHint ??
												`Search ${SPECIES_TOTAL_LABEL} native wildflowers from around the world by name, color, season, or region. Works offline, anywhere — no location needed.`}
										</Text>
										<Text style={styles.suggestionHeader}>TRY</Text>
										<View style={styles.suggestionRow}>
											{SEARCH_SUGGESTIONS.map((term) => (
												<Pressable
													key={term}
													style={styles.suggestionChip}
													accessibilityRole="button"
													accessibilityLabel={`Search for ${term}`}
													onPress={() => {
														setSearchQuery(term);
														handleSearch(term);
													}}
												>
													<Text style={styles.suggestionChipText}>{term}</Text>
												</Pressable>
											))}
										</View>
									</>
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
												const photo = archivePhotoForLatin(result.latin);
												router.push({
													pathname: "/flower-detail",
													params: {
														imageUri: photo ?? "",
														source: "search",
														isPlaceholder: photo ? "0" : "1",
														common: result.common,
														latin: result.latin,
														blurb: result.blurb ?? "",
														bloomMonths: JSON.stringify(
															result.bloomMonths ?? [],
														),
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
												{archivePhotoForLatin(result.latin)
													? "  ·  📷 Photo"
													: ""}
											</Text>
										</Pressable>
									);
								})}
								{searchQuota <= 0 && !isPremium && searchResults.length > 0 && (
									<Pressable
										style={{
											marginTop: 12,
											marginBottom: 4,
											paddingVertical: 12,
											paddingHorizontal: 14,
											borderRadius: 10,
											borderWidth: 1,
											borderColor: "rgba(255, 215, 0, 0.22)",
											backgroundColor: "rgba(255, 215, 0, 0.06)",
											alignItems: "center",
										}}
										onPress={() => {
											setSearchVisible(false);
											setSearchResults([]);
											setPremiumModalVisible(true);
										}}
									>
										<Text style={styles.quotaCount}>
											0 free searches left today
										</Text>
										<Text style={[styles.premiumLockBtnText, { marginTop: 4 }]}>
											UNLOCK UNLIMITED SEARCH
										</Text>
									</Pressable>
								)}
							</ScrollView>
						)}

						<Pressable
							style={styles.dismissBtn}
							onPress={() => {
								setSearchVisible(false);
								setSearchQuery("");
								setSearchResults([]);
								setSearchHint(null);
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

const specimenStyles = StyleSheet.create({
	frontEyebrow: {
		fontSize: 10,
		letterSpacing: 2.2,
		color: PALETTE.accent,
		fontWeight: "600",
		marginBottom: 12,
	},
	bloomText: {
		fontSize: 11,
		letterSpacing: 1.8,
		color: PALETTE.accent,
		fontWeight: "600",
		marginBottom: 10,
	},
	specimenNote: {
		fontFamily: TYPE.serif,
		fontSize: 14,
		lineHeight: 22,
		color: "rgba(255,255,255,0.72)",
	},
	backBloom: {
		marginTop: 12,
		fontSize: 10,
		letterSpacing: 1.8,
		color: PALETTE.accent,
		fontWeight: "600",
	},
});
