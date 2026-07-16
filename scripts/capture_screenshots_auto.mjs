import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Jimp } from "jimp";

const DEVICE_TYPES = {
	iphone_pro_max: {
		name: 'iPhone Pro Max (6.7")',
		simulator: "iPhone 16 Pro Max",
		filePrefix: "iphone67",
		fastlaneKey: "APP_IPHONE_67",
		scales: [
			{ prefix: "iphone65", w: 1242, h: 2688, fastlaneKey: "APP_IPHONE_65" },
			{ prefix: "iphone61", w: 1179, h: 2556, fastlaneKey: "APP_IPHONE_61" },
		],
	},
	iphone_plus: {
		name: 'iPhone Plus (5.5")',
		simulator: "iPhone SE (3rd generation)",
		filePrefix: "iphone55",
		fastlaneKey: "APP_IPHONE_55",
		scales: [],
	},
	ipad_pro: {
		name: 'iPad Pro (12.9")',
		simulator: "iPad Pro 13-inch (M4)",
		filePrefix: "ipad129",
		fastlaneKey: "APP_IPAD_PRO_3GEN_129",
		scales: [
			{
				prefix: "ipad129_legacy",
				w: 2048,
				h: 2732,
				fastlaneKey: "APP_IPAD_PRO_129",
				copyOnly: true,
			},
			{
				prefix: "ipad11",
				w: 1668,
				h: 2388,
				fastlaneKey: "APP_IPAD_PRO_3GEN_11",
			},
			{ prefix: "ipad105", w: 1668, h: 2224, fastlaneKey: "APP_IPAD_105" },
			{ prefix: "ipad97", w: 1536, h: 2048, fastlaneKey: "APP_IPAD_97" },
		],
	},
};

const SCREENSHOT_SCENES = ["", "_back", "_yesterday", "_search"];

function runCommand(cmd) {
	try {
		return execSync(cmd, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
	} catch (_e) {
		return null;
	}
}

function createDirectoryStructure(fastlaneKey) {
	const baseDir = path.join(
		process.cwd(),
		"store/apple/screenshot/en-US",
		fastlaneKey,
	);
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return baseDir;
}

function startSimulatorAndConfigure(deviceInfo) {
	const name = deviceInfo.simulator;
	try {
		console.log(`\nBooting simulator: "${name}"...`);
		execSync(`xcrun simctl boot "${name}" || true`, { stdio: "ignore" });
		execSync(`open -a Simulator`, { stdio: "ignore" });
		console.log(`Waiting for simulator to finish booting...`);
		execSync(`xcrun simctl bootstatus booted || true`, { stdio: "ignore" });
		execSync("sleep 2");

		console.log(`Standardizing simulator status bar to 9:41 AM...`);
		execSync(
			`xcrun simctl status_bar booted override ` +
				`--time "9:41" ` +
				`--batteryState "charged" ` +
				`--batteryLevel "100" ` +
				`--cellularMode "active" ` +
				`--cellularBars "4" ` +
				`--wifiMode "searching" ` +
				`--wifiBars "3" || true`,
			{ stdio: "ignore" },
		);

		console.log(
			`Installing Expo Go (host.exp.Exponent) on booted simulator...`,
		);
		execSync(
			`xcrun simctl install booted ~/.expo/ios-simulator-app-cache/Expo-Go-56.0.2.tar.app || true`,
			{ stdio: "ignore" },
		);

		console.log(`Setting simulator location to Cupertino, CA...`);
		execSync(`xcrun simctl location booted set 37.33182 -122.03118 || true`, {
			stdio: "ignore",
		});

		console.log(`Granting location permissions to Expo Go...`);
		execSync(
			`xcrun simctl privacy booted grant location host.exp.Exponent || true`,
			{ stdio: "ignore" },
		);

		console.log(`Disabling Expo Go developer menu overlays...`);
		// Terminate first to ensure defaults write registers on fresh start
		execSync(`xcrun simctl terminate booted host.exp.Exponent || true`, {
			stdio: "ignore",
		});
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent EXKernelShowDevMenuOverlayKey -bool false || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent showDevMenuOverlay -bool false || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent EXKernelDisableDevMenuKey -bool true || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent EXKernelDevMenuTooltipShownKey -bool true || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent EXDevMenuIsOnboardingFinished -bool true || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent EXDevMenuShowFloatingActionButton -bool false || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent showFloatingActionButton -bool false || true`,
			{ stdio: "ignore" },
		);
		execSync(
			`xcrun simctl spawn booted defaults write host.exp.Exponent showFloatingActionButtonKey -bool false || true`,
			{ stdio: "ignore" },
		);

		// Kill preference daemon to force reload of written defaults
		execSync(`xcrun simctl spawn booted killall cfprefsd || true`, {
			stdio: "ignore",
		});

		return true;
	} catch (error) {
		console.error(`Error starting simulator for ${name}: ${error.message}`);
		return false;
	}
}

function resizeImage(sourcePath, destPath, targetW, targetH) {
	const wStr = runCommand(
		`sips -g pixelWidth "${sourcePath}" | awk '/pixelWidth/ {print $2}'`,
	);
	const hStr = runCommand(
		`sips -g pixelHeight "${sourcePath}" | awk '/pixelHeight/ {print $2}'`,
	);
	const isLandscape = wStr && hStr && parseInt(wStr, 10) > parseInt(hStr, 10);

	const w = isLandscape ? targetH : targetW;
	const h = isLandscape ? targetW : targetH;

	execSync(`sips -z ${h} ${w} "${sourcePath}" --out "${destPath}"`, {
		stdio: "ignore",
	});
}

async function eraseGearIcon(filePath, filePrefix) {
	if (!fs.existsSync(filePath) || !filePrefix) return;
	try {
		const image = await Jimp.read(filePath);
		const _w = image.bitmap.width;
		const _h = image.bitmap.height;

		let rect = null;
		if (filePrefix.startsWith("iphone67")) {
			rect = { x: 1110, y: 150, w: 160, h: 150 };
		} else if (filePrefix.startsWith("iphone55")) {
			rect = { x: 1080, y: 40, w: 140, h: 140 };
		} else if (filePrefix.startsWith("ipad129")) {
			rect = { x: 1880, y: 48, w: 140, h: 140 };
		}

		if (rect) {
			console.log(
				`     Erasing floating gear overlay from ${path.basename(filePath)}...`,
			);
			// Paint #0a0a0a (hex 10, 10, 10) matching the top header's background color
			image.scan(rect.x, rect.y, rect.w, rect.h, function (_x, _y, idx) {
				this.bitmap.data[idx] = 10; // R
				this.bitmap.data[idx + 1] = 10; // G
				this.bitmap.data[idx + 2] = 10; // B
				this.bitmap.data[idx + 3] = 255; // A
			});
			await image.write(filePath);
		}
	} catch (err) {
		console.error(`     Warning: Failed to erase gear icon: ${err.message}`);
	}
}

async function postProcessScreenshot(filePath, filePrefix) {
	if (!fs.existsSync(filePath)) return;

	// 1. Erase gear icon if prefix matches
	if (filePrefix) {
		await eraseGearIcon(filePath, filePrefix);
	}

	// 2. Remove alpha channel
	const hasAlpha =
		runCommand(
			`sips -g hasAlpha "${filePath}" | awk '/hasAlpha/ {print $2}'`,
		) === "yes";
	if (hasAlpha) {
		console.log(
			`     Removing alpha channel from ${path.basename(filePath)}...`,
		);
		execSync(
			`sips -s format png "${filePath}" --setProperty formatOptions default --out "${filePath}"`,
			{ stdio: "ignore" },
		);
	}
}

async function main() {
	console.log("=== Starting Automated Screen Capture & Scaler ===");

	console.log("=== Starting Automated Screen Capture & Scaler ===");

	const devices = Object.keys(DEVICE_TYPES);

	for (const deviceKey of devices) {
		const deviceInfo = DEVICE_TYPES[deviceKey];
		console.log(`\n==================================================`);
		console.log(`RUNNING DEVICE: ${deviceInfo.name}`);
		console.log(`==================================================`);

		const booted = startSimulatorAndConfigure(deviceInfo);
		if (!booted) {
			console.log(`Skipping device ${deviceInfo.name} due to boot error.`);
			continue;
		}

		console.log(`Launching app deep link to trigger any popups...`);
		try {
			execSync(
				`xcrun simctl openurl booted "exp://localhost:8081?disableOnboarding=1"`,
				{ stdio: "ignore" },
			);
			execSync(`sleep 5`); // Wait for JS bundle to load
		} catch (e) {
			console.log(`Warning: Failed to open deep link: ${e.message}`);
		}

		console.log(`Running AI Agent Popup Squasher...`);
		try {
			execSync(`node scripts/agent-squash-popups.mjs`, { stdio: "inherit" });
		} catch (e) {
			console.error(`Warning: AI Squasher failed: ${e.message}`);
		}

		console.log(`Running Maestro capture flow...`);
		try {
			execSync(
				`maestro test -e PREFIX=${deviceInfo.filePrefix} .maestro/capture_flow.yml`,
				{ stdio: "inherit" },
			);
		} catch (e) {
			console.error(`Maestro run failed for ${deviceInfo.name}: ${e.message}`);
			// Continue anyway, try to process what we captured
		}

		console.log(`Post-processing screenshots for ${deviceInfo.name}...`);

		// Setup maestro output dir (temporary flat dir)
		const tempDir = path.join(process.cwd(), "app_store_assets/screenshots");
		if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

		const mainDir = createDirectoryStructure(deviceInfo.fastlaneKey);

		for (const suffix of SCREENSHOT_SCENES) {
			const sourcePath = path.join(
				tempDir,
				`${deviceInfo.filePrefix}${suffix}.png`,
			);
			if (!fs.existsSync(sourcePath)) {
				console.warn(`  ⚠️ Missing screenshot: ${path.basename(sourcePath)}`);
				continue;
			}

			// Clean up base image
			await postProcessScreenshot(sourcePath, deviceInfo.filePrefix);

			// Move base image to main fastlane dir
			const mainDestPath = path.join(
				mainDir,
				`${deviceInfo.filePrefix}${suffix}.png`,
			);
			fs.copyFileSync(sourcePath, mainDestPath);

			// Generate and clean up scaled copies
			for (const scale of deviceInfo.scales) {
				const scaleDir = createDirectoryStructure(scale.fastlaneKey);
				const destPath = path.join(scaleDir, `${scale.prefix}${suffix}.png`);

				if (scale.copyOnly) {
					console.log(
						`  Copying legacy format to ${scale.prefix}${suffix}.png...`,
					);
					fs.copyFileSync(sourcePath, destPath);
				} else {
					console.log(
						`  Scaling copy to ${scale.prefix}${suffix}.png (${scale.w}x${scale.h})...`,
					);
					resizeImage(sourcePath, destPath, scale.w, scale.h);
				}
				await postProcessScreenshot(destPath, scale.prefix);
			}
		}

		// Shutdown the simulator to keep system resources clean
		console.log(`Shutting down simulator for ${deviceInfo.name}...`);
		runCommand(`xcrun simctl shutdown booted`);
	}

	console.log("\n==================================================");
	console.log("🎉 Automated capture, scaling, and formatting complete!");
	console.log(`Saved under: store/apple/screenshot/en-US/`);
	console.log("You can now run quality control verification:");
	console.log("  pnpm run qc-screenshots");
	console.log("==================================================\n");
}

main().catch((err) => {
	console.error("Fatal error:", err);
	process.exit(1);
});
