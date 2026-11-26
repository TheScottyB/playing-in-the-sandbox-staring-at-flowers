import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { Jimp, PNGColorType } from "jimp";

/**
 * Script to automate screenshot capture and verification for Specimen Sandbox.
 *
 * It:
 * 1. Boots each required simulator device.
 * 2. Overrides the status bar to show standard Apple guidelines (9:41 AM, full battery/signal).
 * 3. Programmatically captures screenshots.
 * 4. Checks the captures on-the-fly using local Tesseract OCR.
 * 5. Rejects captures with location permission prompts, dev menus, or home screens.
 * 6. Automatically scales/resizes and saves copies for all App Store display resolutions.
 */

export const DEVICE_TYPES = {
	iphone_pro_max: {
		name: 'iPhone Pro Max (6.7")',
		simulator: "iPhone 16 Pro Max",
		filePrefix: "iphone67",
		fastlaneKey: "APP_IPHONE_67",
		w: 1290,
		h: 2796,
		scales: [
			{
				prefix: "iphone65",
				w: 1242,
				h: 2688,
				fastlaneKey: "APP_IPHONE_65",
			},
			{
				prefix: "iphone61",
				w: 1179,
				h: 2556,
				fastlaneKey: "APP_IPHONE_61",
			},
		],
	},
	iphone_plus: {
		name: 'iPhone Plus (5.5")',
		simulator: "iPhone SE (3rd generation)",
		filePrefix: "iphone55",
		fastlaneKey: "APP_IPHONE_55",
		w: 1242,
		h: 2208,
		scales: [],
	},
	ipad_pro: {
		name: 'iPad Pro (12.9")',
		simulator: "iPad Pro 13-inch (M4)",
		filePrefix: "ipad129",
		fastlaneKey: "APP_IPAD_PRO_3GEN_129",
		w: 2048,
		h: 2732,
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
			{
				prefix: "ipad105",
				w: 1668,
				h: 2224,
				fastlaneKey: "APP_IPAD_105",
			},
			{
				prefix: "ipad97",
				w: 1536,
				h: 2048,
				fastlaneKey: "APP_IPAD_97",
			},
		],
	},
};

export const SCREENSHOT_SCENES = [
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

function runCommand(bin, args = []) {
	try {
		return execFileSync(bin, args, {
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "ignore"],
		}).trim();
	} catch (_e) {
		return null;
	}
}

function runIgnore(bin, args = []) {
	try {
		execFileSync(bin, args, { stdio: "ignore" });
	} catch (_e) {
		// Best-effort simulator setup command
	}
}

function parseSipsField(output, key) {
	if (!output) return null;
	const match = output.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : null;
}

function parseSipsDimension(raw) {
	if (!raw || raw === "<nil>") return null;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function sleepMs(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getOutputDir(fastlaneKey = "", cwd = process.cwd()) {
	const rootDir = path.join(cwd, "store/apple/screenshot/en-US");
	return fastlaneKey ? path.join(rootDir, fastlaneKey) : rootDir;
}

export function createDirectoryStructure(
	fastlaneKey = "",
	cwd = process.cwd(),
) {
	const baseDir = getOutputDir(fastlaneKey, cwd);
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return baseDir;
}

function listAvailableSimulators() {
	try {
		const output = execFileSync(
			"xcrun",
			["simctl", "list", "devices", "available"],
			{
				encoding: "utf-8",
			},
		);
		console.log("\nAvailable Simulators:");
		console.log(output);
	} catch (error) {
		console.error("Error listing simulators:", error.message);
	}
}

async function startSimulatorAndConfigure(deviceInfo) {
	const name = deviceInfo.simulator;
	try {
		console.log(`\nBooting simulator for "${name}"...`);
		runIgnore("xcrun", ["simctl", "boot", name]);
		execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });

		// Wait a couple of seconds for boot completion
		await sleepMs(2000);

		console.log(`Standardizing simulator status bar to 9:41 AM...`);
		runIgnore("xcrun", [
			"simctl",
			"status_bar",
			"booted",
			"override",
			"--time",
			"9:41",
			"--batteryState",
			"charged",
			"--batteryLevel",
			"100",
			"--cellularMode",
			"active",
			"--cellularBars",
			"4",
			"--wifiMode",
			"searching",
			"--wifiBars",
			"3",
		]);

		return true;
	} catch (error) {
		console.error(`Error starting simulator for ${name}:`, error.message);
		listAvailableSimulators();
		return false;
	}
}

export function resizeImage(
	sourcePath,
	destPath,
	targetW,
	targetH,
	options = {},
) {
	const {
		runCommandImpl = runCommand,
		execFileSyncImpl = execFileSync,
		copyFileSyncImpl = fs.copyFileSync,
	} = options;
	const sipsOut = runCommandImpl("sips", [
		"-g",
		"pixelWidth",
		"-g",
		"pixelHeight",
		sourcePath,
	]);
	const curW = parseSipsDimension(parseSipsField(sipsOut, "pixelWidth"));
	const curH = parseSipsDimension(parseSipsField(sipsOut, "pixelHeight"));
	const isLandscape = curW && curH && curW > curH;

	const w = isLandscape ? targetH : targetW;
	const h = isLandscape ? targetW : targetH;

	if (curW === w && curH === h) {
		if (sourcePath !== destPath) {
			copyFileSyncImpl(sourcePath, destPath);
		}
		return;
	}

	execFileSyncImpl(
		"sips",
		["-z", String(h), String(w), sourcePath, "--out", destPath],
		{
			stdio: "ignore",
		},
	);
}

const PNG_SIGNATURE = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export function pngHasAlpha(filePath) {
	const buf = fs.readFileSync(filePath);
	if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
		return false;
	}
	const colorType = buf[25];
	if (colorType === 4 || colorType === 6) {
		return true;
	}
	let offset = 8;
	while (offset + 8 <= buf.length) {
		const chunkLen = buf.readUInt32BE(offset);
		const chunkType = buf.subarray(offset + 4, offset + 8).toString("ascii");
		if (chunkType === "tRNS") return true;
		if (chunkType === "IDAT" || chunkType === "IEND") break;
		offset += 12 + chunkLen;
	}
	return false;
}

export async function stripAlphaChannel(
	filePath,
	bg = { r: 10, g: 10, b: 10 },
) {
	if (!fs.existsSync(filePath)) return;
	const image = await Jimp.read(filePath);
	const data = image.bitmap.data;
	for (let i = 0; i < data.length; i += 4) {
		const a = data[i + 3];
		if (a < 255) {
			const alpha = a / 255;
			const inv = 1 - alpha;
			data[i] = Math.round(data[i] * alpha + bg.r * inv);
			data[i + 1] = Math.round(data[i + 1] * alpha + bg.g * inv);
			data[i + 2] = Math.round(data[i + 2] * alpha + bg.b * inv);
			data[i + 3] = 255;
		}
	}
	const rgbBuf = await image.getBuffer("image/png", {
		colorType: PNGColorType.COLOR,
	});
	fs.writeFileSync(filePath, rgbBuf);
}

async function ensureNoAlpha(filePath) {
	const sipsOut = runCommand("sips", ["-g", "hasAlpha", filePath]);
	const hasAlpha =
		pngHasAlpha(filePath) || parseSipsField(sipsOut, "hasAlpha") === "yes";
	if (hasAlpha) {
		console.log(`   Removing alpha channel/transparency...`);
		await stripAlphaChannel(filePath);
	}
}

export async function captureAndVerify(
	_baseDir,
	deviceInfo,
	scene,
	questionFn,
) {
	const prefix = deviceInfo.filePrefix;
	const primaryDir = createDirectoryStructure(deviceInfo.fastlaneKey);
	const targetPath = path.join(primaryDir, `${prefix}${scene.suffix}.png`);

	while (true) {
		console.log(`\n--------------------------------------------------`);
		console.log(`SCENE: ${scene.key.toUpperCase()} (${scene.desc})`);
		console.log(`--------------------------------------------------`);

		await questionFn(
			`👉 Setup the app on the simulator, then press [Enter] to capture programmatically: `,
		);

		console.log(`   Capturing screenshot...`);
		try {
			execFileSync(
				"xcrun",
				["simctl", "io", "booted", "screenshot", targetPath],
				{
					stdio: "ignore",
				},
			);
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
		await ensureNoAlpha(targetPath);

		// OCR Verification Check using Tesseract
		const hasTesseract = runCommand("which", ["tesseract"]);
		if (hasTesseract) {
			console.log(`   Running OCR verification...`);
			const ocrText = runCommand("tesseract", [
				targetPath,
				"stdout",
				"--psm",
				"3",
			]);
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

		// Normalize primary capture dimensions to App Store Connect spec
		if (deviceInfo.w && deviceInfo.h) {
			resizeImage(targetPath, targetPath, deviceInfo.w, deviceInfo.h);
			await ensureNoAlpha(targetPath);
		}

		// Generate scaled copies for other required dimensions
		for (const scale of deviceInfo.scales) {
			const scaleDir = createDirectoryStructure(scale.fastlaneKey);
			const scalePath = path.join(
				scaleDir,
				`${scale.prefix}${scene.suffix}.png`,
			);
			const actionLabel = scale.copyOnly
				? "Copying legacy format for"
				: "Scaling copy for";
			console.log(
				`   ${actionLabel} ${scale.prefix} (${scale.w}x${scale.h})...`,
			);
			resizeImage(targetPath, scalePath, scale.w, scale.h);

			// Ensure no alpha channel on scaled copy
			await ensureNoAlpha(scalePath);
		}

		break;
	}
}

export async function main() {
	console.log("Welcome to the Specimen Sandbox Screen Capture & Scaler Tool!");

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	const question = (query) =>
		new Promise((resolve) => rl.question(query, resolve));

	try {
		const baseDir = createDirectoryStructure();

		const devices = Object.keys(DEVICE_TYPES);
		for (const deviceKey of devices) {
			const deviceInfo = DEVICE_TYPES[deviceKey];
			console.log(`\n==================================================`);
			console.log(`DEVICE: ${deviceInfo.name}`);
			console.log(`==================================================`);

			const booted = await startSimulatorAndConfigure(deviceInfo);
			if (!booted) {
				console.log(`Skipping device ${deviceInfo.name} due to boot error.`);
				continue;
			}

			for (const scene of SCREENSHOT_SCENES) {
				await captureAndVerify(baseDir, deviceInfo, scene, question);
			}
		}

		console.log("\n==================================================");
		console.log("🎉 All screenshots captured, verified, and scaled!");
		console.log(`Saved under: ${baseDir}`);
		console.log("You can now run quality control verification:");
		console.log("  pnpm run screenshots:verify");
		console.log("==================================================\n");
	} finally {
		rl.close();
	}
}

function isMainModule() {
	if (!process.argv[1]) return false;
	try {
		return (
			fs.realpathSync(fileURLToPath(import.meta.url)) ===
			fs.realpathSync(path.resolve(process.argv[1]))
		);
	} catch {
		return false;
	}
}

if (isMainModule()) {
	main().catch((err) => {
		console.error(err);
		process.exitCode = 1;
	});
}
