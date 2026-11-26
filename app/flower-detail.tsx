import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import {
	type ImageSourcePropType,
	Pressable,
	ScrollView,
	StyleSheet,
	Text,
	View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { IridescentOverlay } from "@/components/IridescentOverlay";
import { DEFAULT_FLOWER, pickVariant } from "@/data/defaults";
import { alternateImageUrlFor, formatBloomMonths } from "@/lib/dailyFlower";
import { PALETTE, TYPE } from "@/shared/constants/brand";
import { styles } from "@/styles/flower-detail.styles";

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

function formatDateLabel(iso: string): string {
	const [y, m, d] = iso.split("-").map(Number);
	if (!y || !m || !d) return iso;
	return `${MONTH_SHORT[m - 1]} ${d} ${y}`;
}

function parseBloomMonthsParam(raw?: string): number[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function pickPoppyVariant(timeOfDay?: string): ImageSourcePropType {
	if (timeOfDay) {
		const found = DEFAULT_FLOWER.variants.find((v) => v.time === timeOfDay);
		if (found) return found.image;
	}
	return pickVariant().image;
}

export default function FlowerDetailScreen() {
	const router = useRouter();
	const {
		imageUri,
		source,
		isPlaceholder,
		bloomMonths: bloomMonthsParam,
		timeOfDay,
		common,
		latin,
		blurb,
		state: flowerState,
		date,
	} = useLocalSearchParams<{
		imageUri?: string;
		source?: string;
		isPlaceholder?: string;
		bloomMonths?: string;
		timeOfDay?: string;
		common?: string;
		latin?: string;
		blurb?: string;
		state?: string;
		date?: string;
	}>();

	const [activeUri, setActiveUri] = useState<string>(imageUri ?? "");
	const [triedAlt, setTriedAlt] = useState(false);
	const [imageFailed, setImageFailed] = useState(false);

	useEffect(() => {
		setActiveUri(imageUri ?? "");
		setTriedAlt(false);
		setImageFailed(false);
	}, [imageUri]);

	const regionLabel =
		!flowerState || flowerState === "default"
			? "YOUR AREA"
			: flowerState.toUpperCase();

	const parsedBloomMonths = useMemo(
		() => parseBloomMonthsParam(bloomMonthsParam),
		[bloomMonthsParam],
	);
	const bloomSeasonLabel = useMemo(
		() => formatBloomMonths(parsedBloomMonths),
		[parsedBloomMonths],
	);

	const isCaliforniaPoppy =
		latin === DEFAULT_FLOWER.latin || common === DEFAULT_FLOWER.common;

	const showRemoteImage = Boolean(activeUri) && !imageFailed;
	const showPoppyFallbackImage =
		!showRemoteImage && isCaliforniaPoppy && isPlaceholder !== "1";
	const isSpecimenPlaceholder = !showRemoteImage && !showPoppyFallbackImage;

	function handleImageError() {
		if (activeUri && !triedAlt) {
			const alt = alternateImageUrlFor(activeUri);
			if (alt) {
				setTriedAlt(true);
				setActiveUri(alt);
				return;
			}
		}
		setImageFailed(true);
	}

	const eyebrowText =
		source === "search"
			? `${regionLabel} · SPECIMEN RECORD`
			: `${regionLabel} · ${formatDateLabel(date ?? "")}`;

	const displayBlurb = blurb?.trim()
		? blurb
		: isCaliforniaPoppy
			? DEFAULT_FLOWER.blurb
			: "Botanical photography is not cached for this specimen. Daily regional photography is fetched automatically when published for your area.";

	return (
		<View style={styles.root}>
			{/* Hide the native header — back gesture / zoom-out handles dismissal */}
			<Stack.Screen options={{ headerShown: false }} />

			{/* Full-bleed flower image OR botanical specimen backdrop */}
			{showRemoteImage ? (
				<Image
					source={{ uri: activeUri }}
					onError={handleImageError}
					style={StyleSheet.absoluteFill}
					contentFit="cover"
					cachePolicy="memory-disk"
					preferHighDynamicRange
					accessibilityLabel={common ?? "Botanical flower"}
				/>
			) : showPoppyFallbackImage ? (
				<Image
					source={pickPoppyVariant(timeOfDay)}
					style={StyleSheet.absoluteFill}
					contentFit="cover"
					cachePolicy="memory-disk"
					preferHighDynamicRange
					accessibilityLabel={common ?? DEFAULT_FLOWER.common}
				/>
			) : (
				<View style={StyleSheet.absoluteFill}>
					<LinearGradient
						colors={["#1a1a22", "#0d0d11", "#050507"]}
						start={{ x: 0, y: 0 }}
						end={{ x: 0, y: 1 }}
						style={StyleSheet.absoluteFill}
					/>
					<IridescentOverlay subtle />
				</View>
			)}

			{/* Gradient: transparent at top, deep black at bottom */}
			<LinearGradient
				colors={[
					"rgba(0,0,0,0)",
					"rgba(0,0,0,0)",
					"rgba(0,0,0,0.65)",
					"rgba(0,0,0,0.97)",
				]}
				locations={[0, 0.38, 0.62, 1]}
				style={StyleSheet.absoluteFill}
				pointerEvents="none"
			/>

			{/* Info panel anchored to the bottom */}
			<SafeAreaView
				style={styles.fill}
				edges={["bottom", "left", "right", "top"]}
			>
				<View style={styles.inner}>
					{/* Top row: close button + optional specimen indicator */}
					<View style={specimenStyles.topRow}>
						<Pressable
							style={styles.closeBtn}
							onPress={() => router.back()}
							accessibilityLabel="Close"
							accessibilityRole="button"
							hitSlop={12}
						>
							<Text style={styles.closeIcon}>✕</Text>
						</Pressable>

						{isSpecimenPlaceholder && (
							<View style={specimenStyles.specimenBadge}>
								<Text style={specimenStyles.specimenBadgeText}>
									NO PHOTO CACHED · SPECIMEN
								</Text>
							</View>
						)}
					</View>

					{/* Spacer pushes info to the bottom */}
					<View style={styles.spacer} />

					{isSpecimenPlaceholder && (
						<View style={specimenStyles.crestWrap}>
							<Text style={specimenStyles.crestMonogram}>✿</Text>
							<Text style={specimenStyles.crestCaption}>
								BOTANICAL SPECIMEN ARCHIVE
							</Text>
						</View>
					)}

					<View style={styles.info}>
						<Text style={styles.eyebrow}>{eyebrowText}</Text>

						<Text
							style={styles.common}
							numberOfLines={2}
							adjustsFontSizeToFit
							selectable
						>
							{common}
						</Text>
						<Text style={styles.latin} selectable>
							{latin}
						</Text>

						{bloomSeasonLabel !== "" && (
							<Text style={specimenStyles.bloomSeason}>
								BLOOM SEASON: {bloomSeasonLabel}
							</Text>
						)}

						<View style={styles.rule} />

						<ScrollView
							showsVerticalScrollIndicator={false}
							bounces
							style={styles.blurbScroll}
						>
							<Text style={styles.blurb} selectable>
								{displayBlurb}
							</Text>
							{/* Bottom breathing room inside scroll */}
							<View style={{ height: 24 }} />
						</ScrollView>
					</View>
				</View>
			</SafeAreaView>
		</View>
	);
}

const specimenStyles = StyleSheet.create({
	topRow: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		paddingRight: 16,
	},
	specimenBadge: {
		paddingVertical: 6,
		paddingHorizontal: 10,
		borderRadius: 999,
		backgroundColor: "rgba(255,255,255,0.06)",
		borderWidth: StyleSheet.hairlineWidth,
		borderColor: "rgba(242, 184, 218, 0.35)",
	},
	specimenBadgeText: {
		color: PALETTE.accent,
		fontSize: 9,
		letterSpacing: 1.8,
		fontWeight: "600",
	},
	crestWrap: {
		alignItems: "center",
		marginBottom: 28,
		paddingHorizontal: 28,
	},
	crestMonogram: {
		fontFamily: TYPE.serif,
		fontSize: 42,
		color: "rgba(242, 184, 218, 0.45)",
		marginBottom: 8,
	},
	crestCaption: {
		fontSize: 10,
		letterSpacing: 3,
		color: "rgba(255,255,255,0.4)",
		fontWeight: "600",
	},
	bloomSeason: {
		marginTop: 10,
		fontSize: 11,
		letterSpacing: 2,
		color: PALETTE.accent,
		fontWeight: "600",
	},
});
