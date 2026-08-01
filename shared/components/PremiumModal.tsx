import { LinearGradient } from "expo-linear-gradient";
import { useEffect, useState } from "react";
import {
	ActivityIndicator,
	Alert,
	Linking,
	Modal,
	Pressable,
	StyleSheet,
	Text,
	View,
} from "react-native";
import {
	getSubscriptionOfferings,
	type PurchasesOffering,
	purchasePackage,
	restorePurchases,
} from "@/lib/purchases";
import { PALETTE } from "@/shared/constants/brand";
import { IridescentOverlay } from "./IridescentOverlay";

interface PremiumModalProps {
	visible: boolean;
	onClose: () => void;
	onSuccess: () => void;
}

export default function PremiumModal({
	visible,
	onClose,
	onSuccess,
}: PremiumModalProps) {
	const [purchasing, setPurchasing] = useState(false);
	const [offerings, setOfferings] = useState<PurchasesOffering[]>([]);
	const [selectedPackageId, setSelectedPackageId] = useState<string>("");
	const [loadingOfferings, setLoadingOfferings] = useState(true);
	const [offeringsError, setOfferingsError] = useState(false);

	async function loadOfferings() {
		setLoadingOfferings(true);
		setOfferingsError(false);
		try {
			const pkgs = await getSubscriptionOfferings();
			setOfferings(pkgs);
			if (pkgs.length > 0) {
				// Default to premium_monthly or the first package
				const defaultPkg =
					pkgs.find((p) => p.identifier === "premium_monthly") || pkgs[0];
				setSelectedPackageId(defaultPkg.identifier);
			} else {
				setOfferingsError(true);
			}
		} catch (e) {
			console.error("Failed to load offerings:", e);
			setOfferingsError(true);
		} finally {
			setLoadingOfferings(false);
		}
	}

	// biome-ignore lint/correctness/useExhaustiveDependencies: reload only when the modal opens
	useEffect(() => {
		if (visible) {
			loadOfferings();
		}
	}, [visible]);

	async function handlePurchase() {
		if (!selectedPackageId) {
			Alert.alert(
				"Subscription Unavailable",
				"We couldn't load the subscription options. Please check your connection and tap Retry.",
			);
			return;
		}
		setPurchasing(true);
		try {
			const success = await purchasePackage(selectedPackageId);
			if (success) {
				Alert.alert(
					"Premium Unlocked!",
					"Thank you for supporting Specimen Sandbox! All premium features are now active.",
					[
						{
							text: "Great!",
							onPress: () => {
								onSuccess();
								onClose();
							},
						},
					],
				);
			}
		} catch (e) {
			console.error("Purchase failed:", e);
			Alert.alert(
				"Purchase Error",
				"We were unable to complete your checkout transaction.",
			);
		} finally {
			setPurchasing(false);
		}
	}

	async function handleRestore() {
		setPurchasing(true);
		try {
			const success = await restorePurchases();
			if (success) {
				Alert.alert(
					"Restore Success",
					"Your Premium Pass was successfully restored! Enjoy all features.",
					[
						{
							text: "Great!",
							onPress: () => {
								onSuccess();
								onClose();
							},
						},
					],
				);
			} else {
				Alert.alert(
					"Restore Complete",
					"No previous purchases were found for this account.",
				);
			}
		} catch (e) {
			console.error("Restore failed:", e);
			Alert.alert("Restore Error", "Unable to restore purchases at this time.");
		} finally {
			setPurchasing(false);
		}
	}

	return (
		<Modal
			visible={visible}
			animationType="fade"
			transparent={true}
			onRequestClose={onClose}
		>
			<View style={styles.overlay}>
				<View style={styles.glow} />
				<View style={styles.card}>
					<IridescentOverlay subtle />

					<Text style={styles.tag}>SPECIMEN PREMIUM</Text>
					<Text style={styles.title}>Unlock Premium Pass</Text>
					<Text style={styles.sub}>
						Enhance your daily flower ritual and support local offline database
						growth.
					</Text>

					<View style={styles.divider} />

					<View style={styles.features}>
						<View style={styles.featureRow}>
							<Text style={styles.featureIcon}>⏳</Text>
							<View style={styles.featureText}>
								<Text style={styles.featureTitle}>Full 7-Day Archive</Text>
								<Text style={styles.featureDesc}>
									Go back up to a week to read past daily blooms.
								</Text>
							</View>
						</View>

						<View style={styles.featureRow}>
							<Text style={styles.featureIcon}>🔍</Text>
							<View style={styles.featureText}>
								<Text style={styles.featureTitle}>
									Unlimited Vector Vibe Search
								</Text>
								<Text style={styles.featureDesc}>
									Unlimited semantic searches through offline embedding index.
								</Text>
							</View>
						</View>

						<View style={styles.featureRow}>
							<Text style={styles.featureIcon}>✈️</Text>
							<View style={styles.featureText}>
								<Text style={styles.featureTitle}>Premium Travel Mode</Text>
								<Text style={styles.featureDesc}>
									Override location to explore flowers in other states &
									countries.
								</Text>
							</View>
						</View>
					</View>

					<View style={styles.divider} />

					{/* Packages Selection Section */}
					<View style={styles.packagesContainer}>
						{loadingOfferings ? (
							<ActivityIndicator
								size="small"
								color={PALETTE.accent}
								style={{ marginVertical: 20 }}
							/>
						) : offeringsError || offerings.length === 0 ? (
							<View style={styles.offeringsErrorBox}>
								<Text style={styles.offeringsErrorText}>
									We couldn't load the subscription options right now. Please
									check your connection and try again.
								</Text>
								<Pressable style={styles.retryBtn} onPress={loadOfferings}>
									<Text style={styles.retryBtnText}>Retry</Text>
								</Pressable>
							</View>
						) : (
							offerings.map((pkg) => {
								const isSelected = selectedPackageId === pkg.identifier;
								return (
									<Pressable
										key={pkg.identifier}
										style={[
											styles.packageCard,
											isSelected && styles.packageCardSelected,
										]}
										onPress={() => setSelectedPackageId(pkg.identifier)}
										disabled={purchasing}
									>
										<View style={styles.packageCardHeader}>
											<Text style={styles.packageTitle}>{pkg.title}</Text>
											<Text style={styles.packagePrice}>{pkg.priceString}</Text>
										</View>
										<Text style={styles.packageDesc}>{pkg.description}</Text>
										{isSelected && (
											<LinearGradient
												colors={[
													"rgba(242, 184, 218, 0.08)",
													"rgba(242, 184, 218, 0.0)",
												]}
												start={{ x: 0, y: 0 }}
												end={{ x: 1, y: 1 }}
												style={StyleSheet.absoluteFill}
												pointerEvents="none"
											/>
										)}
									</Pressable>
								);
							})
						)}
					</View>

					{/* App Store Subscription Billing Disclosure */}
					<Text style={styles.disclosureText}>
						Subscriptions auto-renew at the price selected unless cancelled at
						least 24 hours prior to the end of the current billing period.
						Payments are charged to your iTunes Account. You can manage or
						cancel your subscription anytime in your App Store Account Settings.
					</Text>

					<Pressable
						style={[
							styles.primaryBtn,
							(purchasing || loadingOfferings || !selectedPackageId) &&
								styles.disabledBtn,
						]}
						onPress={handlePurchase}
						disabled={purchasing || loadingOfferings}
					>
						<LinearGradient
							colors={[PALETTE.accent, PALETTE.accentDeep]}
							start={{ x: 0, y: 0 }}
							end={{ x: 1, y: 1 }}
							style={styles.gradientBtn}
						>
							{purchasing ? (
								<ActivityIndicator size="small" color="#000" />
							) : (
								<Text style={styles.primaryBtnLabel}>UNLOCK PASS</Text>
							)}
						</LinearGradient>
					</Pressable>

					{/* Footer with Legal Links & Restores */}
					<View style={styles.footerRow}>
						<Pressable onPress={handleRestore} disabled={purchasing}>
							<Text style={styles.footerLink}>Restore Purchases</Text>
						</Pressable>
						<Pressable onPress={onClose} disabled={purchasing}>
							<Text style={styles.footerLink}>Close</Text>
						</Pressable>
					</View>

					<View style={styles.legalLinksRow}>
						<Pressable
							onPress={() =>
								Linking.openURL(
									"https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/privacy.html",
								)
							}
							disabled={purchasing}
						>
							<Text style={styles.legalLink}>Privacy Policy</Text>
						</Pressable>
						<Text style={styles.legalSeparator}>•</Text>
						<Pressable
							onPress={() =>
								Linking.openURL(
									"https://thescottyb.github.io/playing-in-the-sandbox-staring-at-flowers/terms.html",
								)
							}
							disabled={purchasing}
						>
							<Text style={styles.legalLink}>Terms of Use (EULA)</Text>
						</Pressable>
					</View>
				</View>
			</View>
		</Modal>
	);
}

const styles = StyleSheet.create({
	overlay: {
		flex: 1,
		backgroundColor: "rgba(5, 5, 8, 0.95)",
		justifyContent: "center",
		alignItems: "center",
		padding: 20,
	},
	glow: {
		position: "absolute",
		width: 250,
		height: 250,
		borderRadius: 125,
		backgroundColor: "rgba(242, 184, 218, 0.04)",
		filter: "blur(80px)",
	},
	card: {
		width: "100%",
		maxWidth: 420,
		backgroundColor: "#121216",
		borderRadius: 24,
		borderWidth: 1,
		borderColor: "rgba(242, 184, 218, 0.15)",
		padding: 24,
		alignItems: "center",
		shadowColor: "#000",
		shadowOffset: { width: 0, height: 12 },
		shadowOpacity: 0.5,
		shadowRadius: 16,
		elevation: 8,
	},
	tag: {
		fontSize: 10,
		fontWeight: "bold",
		color: PALETTE.accent,
		letterSpacing: 2,
		marginBottom: 8,
	},
	title: {
		fontSize: 22,
		fontWeight: "900",
		color: "#ffffff",
		textAlign: "center",
		marginBottom: 8,
	},
	sub: {
		fontSize: 13,
		color: "rgba(255, 255, 255, 0.6)",
		textAlign: "center",
		lineHeight: 18,
		paddingHorizontal: 8,
	},
	divider: {
		width: "100%",
		height: 1,
		backgroundColor: "rgba(255, 255, 255, 0.08)",
		marginVertical: 14,
	},
	features: {
		width: "100%",
		gap: 12,
	},
	featureRow: {
		flexDirection: "row",
		alignItems: "flex-start",
		gap: 14,
	},
	featureIcon: {
		fontSize: 18,
		marginTop: 2,
	},
	featureText: {
		flex: 1,
	},
	featureTitle: {
		fontSize: 13,
		fontWeight: "bold",
		color: "#ffffff",
		marginBottom: 2,
	},
	featureDesc: {
		fontSize: 11,
		color: "rgba(255, 255, 255, 0.5)",
		lineHeight: 15,
	},
	packagesContainer: {
		width: "100%",
		gap: 10,
		marginBottom: 14,
	},
	packageCard: {
		width: "100%",
		backgroundColor: "#171721",
		borderRadius: 14,
		borderWidth: 1,
		borderColor: "rgba(255, 255, 255, 0.06)",
		padding: 12,
		overflow: "hidden",
	},
	packageCardSelected: {
		borderColor: "rgba(242, 184, 218, 0.5)",
		backgroundColor: "#1c1c28",
	},
	packageCardHeader: {
		flexDirection: "row",
		justifyContent: "space-between",
		alignItems: "center",
		marginBottom: 4,
	},
	packageTitle: {
		fontSize: 13,
		fontWeight: "bold",
		color: "#ffffff",
	},
	packagePrice: {
		fontSize: 13,
		fontWeight: "bold",
		color: PALETTE.accent,
	},
	packageDesc: {
		fontSize: 11,
		color: "rgba(255, 255, 255, 0.5)",
		lineHeight: 14,
	},
	disclosureText: {
		fontSize: 9,
		color: "rgba(255, 255, 255, 0.35)",
		textAlign: "center",
		lineHeight: 12,
		marginBottom: 16,
		paddingHorizontal: 4,
	},
	primaryBtn: {
		width: "100%",
		height: 48,
		borderRadius: 12,
		overflow: "hidden",
		marginBottom: 14,
	},
	disabledBtn: {
		opacity: 0.5,
	},
	offeringsErrorBox: {
		alignItems: "center",
		paddingVertical: 16,
		gap: 12,
	},
	offeringsErrorText: {
		color: "rgba(255, 255, 255, 0.7)",
		fontSize: 13,
		lineHeight: 19,
		textAlign: "center",
	},
	retryBtn: {
		borderWidth: 1,
		borderColor: "rgba(242, 184, 218, 0.4)",
		borderRadius: 10,
		paddingHorizontal: 22,
		paddingVertical: 8,
	},
	retryBtnText: {
		color: PALETTE.accent,
		fontSize: 14,
		fontWeight: "600",
	},
	gradientBtn: {
		flex: 1,
		justifyContent: "center",
		alignItems: "center",
	},
	primaryBtnLabel: {
		color: "#000000",
		fontSize: 14,
		fontWeight: "bold",
		letterSpacing: 1.5,
	},
	footerRow: {
		flexDirection: "row",
		justifyContent: "space-between",
		width: "100%",
		paddingHorizontal: 8,
		marginBottom: 12,
	},
	footerLink: {
		color: "rgba(255, 255, 255, 0.4)",
		fontSize: 12,
	},
	legalLinksRow: {
		flexDirection: "row",
		justifyContent: "center",
		alignItems: "center",
		gap: 8,
		width: "100%",
	},
	legalLink: {
		color: PALETTE.accentDeep,
		fontSize: 11,
	},
	legalSeparator: {
		color: "rgba(255, 255, 255, 0.3)",
		fontSize: 11,
	},
});
