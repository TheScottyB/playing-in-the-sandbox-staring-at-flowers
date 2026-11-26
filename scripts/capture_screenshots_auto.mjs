import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp, PNGColorType } from "jimp";

export const APP_ID = "com.djscottyb.playinginthesandoxlookingatflowers";
export const APP_SCHEME = "staring-at-flowers";

export function buildDeepLink(query = "disableOnboarding=1") {
	return query ? `${APP_SCHEME}://?${query}` : `${APP_SCHEME}://`;
}

export const DEVICE_TYPES = {
	iphone_pro_max: {
		name: 'iPhone Pro Max (6.7")',
		simulator: "iPhone 16 Pro Max",
		filePrefix: "iphone67",
		fastlaneKey: "APP_IPHONE_67",
		w: 1290,
		h: 2796,
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
			{ prefix: "ipad105", w: 1668, h: 2224, fastlaneKey: "APP_IPAD_105" },
			{ prefix: "ipad97", w: 1536, h: 2048, fastlaneKey: "APP_IPAD_97" },
		],
	},
};

export const SCREENSHOT_SCENES = ["", "_back", "_yesterday", "_search"];

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

export function createDirectoryStructure(fastlaneKey, cwd = process.cwd()) {
	const baseDir = path.join(cwd, "store/apple/screenshot/en-US", fastlaneKey);
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return baseDir;
}

async function startSimulatorAndConfigure(deviceInfo) {
	const name = deviceInfo.simulator;
	try {
		console.log(`\nBooting simulator: "${name}"...`);
		runIgnore("xcrun", ["simctl", "boot", name]);
		execFileSync("open", ["-a", "Simulator"], { stdio: "ignore" });
		console.log(`Waiting for simulator to finish booting...`);
		runIgnore("xcrun", ["simctl", "bootstatus", "booted"]);
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

		if (process.env.IOS_APP_PATH) {
			console.log(
				`Installing app (${APP_ID}) from IOS_APP_PATH=${process.env.IOS_APP_PATH}...`,
			);
			execFileSync(
				"xcrun",
				["simctl", "install", "booted", process.env.IOS_APP_PATH],
				{
					stdio: "inherit",
				},
			);
		} else {
			const installed = runCommand("xcrun", [
				"simctl",
				"get_app_container",
				"booted",
				APP_ID,
				"app",
			]);
			if (!installed) {
				console.warn(
					`App ${APP_ID} is not installed on the booted simulator. ` +
						`Build and install it first with: eas build --profile development-simulator --platform ios --local (or set IOS_APP_PATH).`,
				);
			}
		}

		console.log(`Setting simulator location to Cupertino, CA...`);
		runIgnore("xcrun", [
			"simctl",
			"location",
			"booted",
			"set",
			"37.33182",
			"-122.03118",
		]);

		console.log(`Granting location permissions to ${APP_ID}...`);
		runIgnore("xcrun", [
			"simctl",
			"privacy",
			"booted",
			"grant",
			"location",
			APP_ID,
		]);

		console.log(
			`Disabling dev-client developer menu overlays for ${APP_ID}...`,
		);
		// Terminate first to ensure defaults write registers on fresh start
		runIgnore("xcrun", ["simctl", "terminate", "booted", APP_ID]);
		for (const [key, val] of [
			["EXKernelShowDevMenuOverlayKey", "false"],
			["showDevMenuOverlay", "false"],
			["EXKernelDisableDevMenuKey", "true"],
			["EXKernelDevMenuTooltipShownKey", "true"],
			["EXDevMenuIsOnboardingFinished", "true"],
			["EXDevMenuShowFloatingActionButton", "false"],
			["showFloatingActionButton", "false"],
			["showFloatingActionButtonKey", "false"],
		]) {
			runIgnore("xcrun", [
				"simctl",
				"spawn",
				"booted",
				"defaults",
				"write",
				APP_ID,
				key,
				"-bool",
				val,
			]);
		}

		// Kill preference daemon to force reload of written defaults
		runIgnore("xcrun", ["simctl", "spawn", "booted", "killall", "cfprefsd"]);

		return true;
	} catch (error) {
		console.error(`Error starting simulator for ${name}: ${error.message}`);
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

async function writeFlattenedRgbPng(
	image,
	filePath,
	bg = { r: 10, g: 10, b: 10 },
) {
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

export async function stripAlphaChannel(filePath) {
	if (!fs.existsSync(filePath)) return;
	const image = await Jimp.read(filePath);
	await writeFlattenedRgbPng(image, filePath);
}

export async function eraseGearIcon(filePath, filePrefix) {
	if (!fs.existsSync(filePath) || !filePrefix) return;
	try {
		const image = await Jimp.read(filePath);

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
			await writeFlattenedRgbPng(image, filePath);
		}
	} catch (err) {
		console.error(`     Warning: Failed to erase gear icon: ${err.message}`);
	}
}

export async function postProcessScreenshot(filePath, filePrefix) {
	if (!fs.existsSync(filePath)) return;

	// 1. Erase gear icon if prefix matches
	if (filePrefix) {
		await eraseGearIcon(filePath, filePrefix);
	}

	// 2. Deterministically remove alpha channel (flatten RGBA over #0a0a0a and encode RGB-24)
	const sipsOut = runCommand("sips", ["-g", "hasAlpha", filePath]);
	const hasAlpha =
		pngHasAlpha(filePath) || parseSipsField(sipsOut, "hasAlpha") === "yes";
	if (hasAlpha) {
		console.log(
			`     Removing alpha channel from ${path.basename(filePath)}...`,
		);
		await stripAlphaChannel(filePath);
	}
}

export async function main() {
	console.log("=== Starting Automated Screen Capture & Scaler ===");

	const devices = Object.keys(DEVICE_TYPES);
	const stagingDir = path.join(
		process.cwd(),
		"store/apple/screenshot/_staging",
	);

	try {
		for (const deviceKey of devices) {
			const deviceInfo = DEVICE_TYPES[deviceKey];
			console.log(`\n==================================================`);
			console.log(`RUNNING DEVICE: ${deviceInfo.name}`);
			console.log(`==================================================`);

			const booted = await startSimulatorAndConfigure(deviceInfo);
			if (!booted) {
				console.log(`Skipping device ${deviceInfo.name} due to boot error.`);
				continue;
			}

			console.log(`Launching app deep link to trigger any popups...`);
			try {
				execFileSync(
					"xcrun",
					["simctl", "openurl", "booted", buildDeepLink()],
					{
						stdio: "ignore",
					},
				);
				await sleepMs(5000); // Wait for JS bundle to load
			} catch (e) {
				console.log(`Warning: Failed to open deep link: ${e.message}`);
			}

			console.log(`Running AI Agent Popup Squasher...`);
			try {
				execFileSync(process.execPath, ["scripts/agent-squash-popups.mjs"], {
					stdio: "inherit",
				});
			} catch (e) {
				console.error(`Warning: AI Squasher failed: ${e.message}`);
			}

			if (!fs.existsSync(stagingDir)) {
				fs.mkdirSync(stagingDir, { recursive: true });
			}

			console.log(`Running Maestro capture flow...`);
			try {
				execFileSync(
					"maestro",
					[
						"test",
						"-e",
						`PREFIX=${deviceInfo.filePrefix}`,
						"-e",
						`SCREENSHOT_DIR=${stagingDir}`,
						".maestro/capture_flow.yml",
					],
					{ stdio: "inherit" },
				);
			} catch (e) {
				console.error(
					`Maestro run failed for ${deviceInfo.name}: ${e.message}`,
				);
				// Continue anyway, try to process what we captured
			}

			console.log(`Post-processing screenshots for ${deviceInfo.name}...`);

			const mainDir = createDirectoryStructure(deviceInfo.fastlaneKey);

			for (const suffix of SCREENSHOT_SCENES) {
				const sourcePath = path.join(
					stagingDir,
					`${deviceInfo.filePrefix}${suffix}.png`,
				);
				if (!fs.existsSync(sourcePath)) {
					console.warn(`  ⚠️ Missing screenshot: ${path.basename(sourcePath)}`);
					continue;
				}

				// Normalize primary capture dimensions to App Store Connect spec before post-processing
				if (deviceInfo.w && deviceInfo.h) {
					resizeImage(sourcePath, sourcePath, deviceInfo.w, deviceInfo.h);
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

					const actionLabel = scale.copyOnly
						? "Copying legacy format to"
						: "Scaling copy to";
					console.log(
						`  ${actionLabel} ${scale.prefix}${suffix}.png (${scale.w}x${scale.h})...`,
					);
					resizeImage(sourcePath, destPath, scale.w, scale.h);
					await postProcessScreenshot(destPath, scale.prefix);
				}
			}

			// Shutdown the simulator to keep system resources clean
			console.log(`Shutting down simulator for ${deviceInfo.name}...`);
			runCommand("xcrun", ["simctl", "shutdown", "booted"]);
		}
	} finally {
		if (fs.existsSync(stagingDir)) {
			fs.rmSync(stagingDir, { recursive: true, force: true });
		}
	}

	console.log("\n==================================================");
	console.log("🎉 Automated capture, scaling, and formatting complete!");
	console.log(`Saved under: store/apple/screenshot/en-US/`);
	console.log("You can now run quality control verification:");
	console.log("  pnpm run screenshots:verify");
	console.log("==================================================\n");
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
		console.error("Fatal error:", err);
		process.exitCode = 1;
	});
}
