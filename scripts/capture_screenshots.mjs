import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Script to automate screenshot capture and verification for Specimen Sandbox.
 *
 * It:
 * 1. Boots each required simulator device.
 * 2. Overrides the status bar to show standard Apple guidelines (9:41 AM, full battery/signal).
 * 3. Programmatically captures screenshots.
 * 4. Checks the captures on-the-fly using local Tesseract OCR.
 * 5. Rejects captures with location permission prompts, dev menus, or home screens.
 * 6. Automatically scales/resizes and saves copies for all 8 App Store display resolutions.
 */

const DEVICE_TYPES = {
	iphone_pro_max: {
		name: 'iPhone Pro Max (6.7")',
		simulator: "iPhone 16 Pro Max",
		filePrefix: "iphone67",
		scales: [
			{ prefix: "iphone65", w: 1242, h: 2688 },
			{ prefix: "iphone61", w: 1179, h: 2556 },
		],
	},
	iphone_plus: {
		name: 'iPhone Plus (5.5")',
		simulator: "iPhone SE (3rd generation)",
		filePrefix: "iphone55",
		scales: [],
	},
	ipad_pro: {
		name: 'iPad Pro (12.9")',
		simulator: "iPad Pro 13-inch (M4)",
		filePrefix: "ipad129",
		scales: [
			{ prefix: "ipad11", w: 1668, h: 2388 },
			{ prefix: "ipad105", w: 1668, h: 2224 },
			{ prefix: "ipad97", w: 1536, h: 2048 },
		],
	},
};

const SCREENSHOT_SCENES = [
	{
		key: "front",
		suffix: "",
		desc: "Daily flower card (front view showing image, title, and region)",
	},
	{
		key: "back",
		suffix: "_back",
		desc: "Daily flower card back view (showing description, stats, and bloom months)",
	},
	{
		key: "yesterday",
		suffix: "_yesterday",
		desc: "Screen showing yesterday's flower (tap YESTERDAY button at bottom)",
	},
	{
		key: "search",
		suffix: "_search",
		desc: "Search overlay with query input and similarity match results (tap SEARCH at top)",
	},
];

const rl = readline.createInterface({
	input: process.stdin,
	output: process.stdout,
});

function question(query) {
	return new Promise((resolve) => rl.question(query, resolve));
}

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

function createDirectoryStructure() {
	const baseDir = path.join(process.cwd(), "app_store_assets/screenshots");
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return baseDir;
}

function listAvailableSimulators() {
	try {
		const output = execSync("xcrun simctl list devices available", {
			encoding: "utf-8",
		});
		console.log("\nAvailable Simulators:");
		console.log(output);
	} catch (error) {
		console.error("Error listing simulators:", error.message);
	}
}

function startSimulatorAndConfigure(deviceInfo) {
	const name = deviceInfo.simulator;
	try {
		console.log(`\nBooting simulator for "${name}"...`);
		execSync(`xcrun simctl boot "${name}" || true`, { stdio: "ignore" });
		execSync(`open -a Simulator`, { stdio: "ignore" });

		// Wait a couple of seconds for boot completion
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

		return true;
	} catch (error) {
		console.error(`Error starting simulator for ${name}:`, error.message);
		listAvailableSimulators();
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

async function captureAndVerify(baseDir, deviceInfo, scene) {
	const prefix = deviceInfo.filePrefix;
	const targetPath = path.join(baseDir, `${prefix}${scene.suffix}.png`);

	while (true) {
		console.log(`\n--------------------------------------------------`);
		console.log(`SCENE: ${scene.key.toUpperCase()} (${scene.desc})`);
		console.log(`--------------------------------------------------`);

		await question(
			`👉 Setup the app on the simulator, then press [Enter] to capture programmatically: `,
		);

		console.log(`   Capturing screenshot...`);
		try {
			execSync(`xcrun simctl io booted screenshot "${targetPath}"`, {
				stdio: "ignore",
			});
		} catch (err) {
			console.error(
				`   ❌ Failed to capture screenshot from simulator: ${err.message}`,
			);
			console.log(
				`   Make sure the simulator is active, booted, and running the app.`,
			);
			continue;
		}

		// Standardize Alpha Channel (remove if present)
		const hasAlpha =
			runCommand(
				`sips -g hasAlpha "${targetPath}" | awk '/hasAlpha/ {print $2}'`,
			) === "yes";
		if (hasAlpha) {
			console.log(`   Removing alpha channel/transparency...`);
			execSync(
				`sips -s format png "${targetPath}" --setProperty formatOptions default --out "${targetPath}"`,
				{ stdio: "ignore" },
			);
		}

		// OCR Verification Check using Tesseract
		const hasTesseract = runCommand("which tesseract");
		if (hasTesseract) {
			console.log(`   Running OCR verification...`);
			const ocrText = runCommand(
				`tesseract "${targetPath}" stdout --psm 3 2>/dev/null`,
			);
			const textLower = (ocrText || "").toLowerCase();

			let issue = null;
			if (
				textLower.includes("calendar") &&
				textLower.includes("photos") &&
				textLower.includes("settings") &&
				textLower.includes("wallet")
			) {
				issue = "iOS Simulator Home Screen (Springboard)";
			} else if (
				textLower.includes("development build") ||
				textLower.includes("metro") ||
				textLower.includes("enter url manually") ||
				textLower.includes("development servers")
			) {
				issue = "Expo Go / Developer Launcher Menu";
			} else if (
				textLower.includes("would like to use your location") ||
				(textLower.includes("allow") && textLower.includes("location"))
			) {
				issue = "Location Permission Alert Popup";
			} else if (textLower.includes("cancel") && textLower.includes("allow")) {
				issue = "Active alert dialog or system popup";
			}

			if (issue) {
				console.log(`   🔴 REJECTED: Screenshot shows a **${issue}**.`);
				console.log(
					`   Please dismiss the popup/screen on the simulator and try again.`,
				);
				if (fs.existsSync(targetPath)) {
					fs.unlinkSync(targetPath);
				}
				continue;
			}
		} else {
			console.log(`   ⚠️ Tesseract OCR not found. Skipping popup check.`);
		}

		console.log(
			`   🟢 Screenshot captured clean: ${path.basename(targetPath)}`,
		);

		// Generate scaled copies for other required dimensions
		for (const scale of deviceInfo.scales) {
			const scalePath = path.join(
				baseDir,
				`${scale.prefix}${scene.suffix}.png`,
			);
			console.log(
				`   Scaling copy for ${scale.prefix} (${scale.w}x${scale.h})...`,
			);
			resizeImage(targetPath, scalePath, scale.w, scale.h);

			// Ensure no alpha channel on scaled copy
			execSync(
				`sips -s format png "${scalePath}" --setProperty formatOptions default --out "${scalePath}"`,
				{ stdio: "ignore" },
			);
		}

		break;
	}
}

async function main() {
	console.log("Welcome to the Specimen Sandbox Screen Capture & Scaler Tool!");

	const baseDir = createDirectoryStructure();

	const devices = Object.keys(DEVICE_TYPES);
	for (const deviceKey of devices) {
		const deviceInfo = DEVICE_TYPES[deviceKey];
		console.log(`\n==================================================`);
		console.log(`DEVICE: ${deviceInfo.name}`);
		console.log(`==================================================`);

		const booted = startSimulatorAndConfigure(deviceInfo);
		if (!booted) {
			console.log(`Skipping device ${deviceInfo.name} due to boot error.`);
			continue;
		}

		for (const scene of SCREENSHOT_SCENES) {
			await captureAndVerify(baseDir, deviceInfo, scene);
		}
	}

	console.log("\n==================================================");
	console.log("🎉 All screenshots captured, verified, and scaled!");
	console.log(`Saved under: ${baseDir}`);
	console.log("You can now run quality control verification:");
	console.log("  pnpm run qc-screenshots");
	console.log("==================================================\n");

	rl.close();
}

main().catch((err) => {
	console.error(err);
	rl.close();
	process.exit(1);
});
