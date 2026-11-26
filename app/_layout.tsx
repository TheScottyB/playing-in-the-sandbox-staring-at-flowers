import { Stack } from "expo-router";
import {
	DarkTheme,
	DefaultTheme,
	ThemeProvider,
} from "expo-router/react-navigation";
import { StatusBar } from "expo-status-bar";
import "react-native-reanimated";

import { requireOptionalNativeModule } from "expo";
import { useEffect } from "react";
import { LogBox } from "react-native";
import { useColorScheme } from "@/hooks/useColorScheme";
import { initPurchases } from "@/lib/purchases";

const DevMenuPreferences = requireOptionalNativeModule("DevMenuPreferences");

if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true") {
	LogBox.ignoreAllLogs();
}

export default function RootLayout() {
	const colorScheme = useColorScheme();

	useEffect(() => {
		void initPurchases();
		if (process.env.EXPO_PUBLIC_SCREENSHOT_MODE === "true") {
			console.log(
				"DevMenuPreferences native module is present:",
				!!DevMenuPreferences,
			);
			try {
				DevMenuPreferences?.setPreferencesAsync({
					showFloatingActionButton: false,
					motionGestureEnabled: true,
					touchGestureEnabled: true,
					showsAtLaunch: false,
				});
			} catch (e) {
				console.warn("Failed to configure dev menu preferences:", e);
			}
		}
	}, []);

	return (
		<ThemeProvider value={colorScheme === "dark" ? DarkTheme : DefaultTheme}>
			<Stack screenOptions={{ headerShown: false }}>
				<Stack.Screen name="index" />
				<Stack.Screen name="flower-detail" />
				<Stack.Screen name="+not-found" options={{ headerShown: true }} />
			</Stack>
			<StatusBar style="auto" />
		</ThemeProvider>
	);
}
