import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Load environment variables from .env.local and .env if they exist
for (const envFile of [".env.local", ".env"]) {
	if (fs.existsSync(envFile)) {
		const content = fs.readFileSync(envFile, "utf-8");
		for (const line of content.split("\n")) {
			const match = line.match(/^\s*([^#=]+)\s*=\s*(.*)\s*$/);
			if (match) {
				const key = match[1].trim();
				let val = match[2].trim();
				// Strip optional quotes
				if (
					(val.startsWith('"') && val.endsWith('"')) ||
					(val.startsWith("'") && val.endsWith("'"))
				) {
					val = val.slice(1, -1);
				}
				if (!process.env[key]) {
					process.env[key] = val;
				}
			}
		}
	}
}

// Define expected screenshot criteria for Apple App Store Connect based on app-store-config.json
const DEVICE_SPECS = {
	iphone67: {
		name: 'iPhone Pro Max (6.7")',
		width: 1290,
		height: 2796,
		altWidth: 2796,
		altHeight: 1290,
	},
	iphone65: {
		name: 'iPhone Pro Max (6.5")',
		width: 1242,
		height: 2688,
		altWidth: 2688,
		altHeight: 1242,
	},
	iphone61: {
		name: 'iPhone (6.1")',
		width: 1179,
		height: 2556,
		altWidth: 2556,
		altHeight: 1179,
	},
	iphone55: {
		name: 'iPhone (5.5")',
		width: 1242,
		height: 2208,
		altWidth: 2208,
		altHeight: 1242,
	},
	ipad129: {
		name: 'iPad Pro (12.9")',
		width: 2048,
		height: 2732,
		altWidth: 2732,
		altHeight: 2048,
	},
	ipad11: {
		name: 'iPad Pro (11")',
		width: 1668,
		height: 2388,
		altWidth: 2388,
		altHeight: 1668,
	},
	ipad105: {
		name: 'iPad Pro (10.5")',
		width: 1668,
		height: 2224,
		altWidth: 2224,
		altHeight: 1668,
	},
	ipad97: {
		name: 'iPad (9.7")',
		width: 1536,
		height: 2048,
		altWidth: 2048,
		altHeight: 1536,
	},
};

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

function getImageInfo(filePath) {
	// Use sips (native macOS) to get image details
	const widthStr = runCommand(
		`sips -g pixelWidth "${filePath}" | awk '/pixelWidth/ {print $2}'`,
	);
	const heightStr = runCommand(
		`sips -g pixelHeight "${filePath}" | awk '/pixelHeight/ {print $2}'`,
	);
	const hasAlphaStr = runCommand(
		`sips -g hasAlpha "${filePath}" | awk '/hasAlpha/ {print $2}'`,
	);
	const formatStr = runCommand(
		`sips -g format "${filePath}" | awk '/format/ {print $2}'`,
	);

	return {
		width: widthStr ? parseInt(widthStr, 10) : null,
		height: heightStr ? parseInt(heightStr, 10) : null,
		hasAlpha: hasAlphaStr === "yes",
		format: formatStr ? formatStr.toLowerCase() : null,
		sizeBytes: fs.statSync(filePath).size,
	};
}

function performOCR(filePath) {
	// Use tesseract if available
	const hasTesseract = runCommand("which tesseract");
	if (!hasTesseract) {
		return { available: false, text: "" };
	}

	const text = runCommand(`tesseract "${filePath}" stdout --psm 3 2>/dev/null`);
	return {
		available: true,
		text: text || "",
	};
}

function scanScreenshotsDir(baseDir) {
	const filesList = [];

	function recurse(dir) {
		if (!fs.existsSync(dir)) return;
		const entries = fs.readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				recurse(fullPath);
			} else if (entry.isFile()) {
				const ext = path.extname(entry.name).toLowerCase();
				if ([".png", ".jpg", ".jpeg"].includes(ext)) {
					filesList.push(fullPath);
				}
			}
		}
	}

	recurse(baseDir);
	return filesList;
}

async function analyzeScreenshotWithGemini(filePath, apiKey) {
	const model = "gemini-2.5-flash";
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const buffer = fs.readFileSync(filePath);
	const base64Image = buffer.toString("base64");

	const ext = path.extname(filePath).toLowerCase();
	let mimeType = "image/png";
	if (ext === ".jpg" || ext === ".jpeg") {
		mimeType = "image/jpeg";
	}

	const prompt = `Analyze this App Store screenshot. Check if there are any of the following issues:
1. Is it a screenshot of the mobile home screen (iOS Springboard or Android Launcher/App Drawer) instead of the app?
2. Is it showing the Expo Go client, developer launcher, Metro bundler connection screen, or other developer menus?
3. Does it contain any debug overlays, redbox error screens, FPS meters, or a visible "DEBUG" ribbon?
4. Does it contain any visible popups, modal overlays, permission dialogs (e.g. location permission alert), or system alert dialogs that shouldn't be in a clean production screenshot?
5. Does the status bar show a time other than 9:41?

Respond ONLY with a JSON object in this exact format:
{
  "isHomeScreen": true,
  "isDevLauncher": true,
  "hasDebugOverlay": true,
  "hasPopupOrModal": true,
  "statusBarTime": "9:41",
  "explanation": "Brief explanation of any issues found"
}`;

	const body = {
		contents: [
			{
				parts: [
					{
						inlineData: {
							mimeType: mimeType,
							data: base64Image,
						},
					},
					{
						text: prompt,
					},
				],
			},
		],
		generationConfig: {
			responseMimeType: "application/json",
		},
	};

	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});

		if (!resp.ok) {
			const errorText = await resp.text();
			let errorObj;
			try {
				errorObj = JSON.parse(errorText);
			} catch (_e) {}

			const errorMessage = errorObj?.error?.message || errorText;
			const isBillingOrQuota =
				resp.status === 429 ||
				errorMessage.includes("prepayment credits") ||
				errorMessage.includes("RESOURCE_EXHAUSTED") ||
				errorObj?.error?.status === "RESOURCE_EXHAUSTED";

			if (isBillingOrQuota) {
				console.error(
					"\n======================================================================",
				);
				console.error(
					"🔴 CRITICAL GEMINI API ERROR: BILLING OR QUOTA EXHAUSTED",
				);
				console.error(errorMessage);
				console.error(
					"======================================================================\n",
				);
				process.exit(1);
			}

			throw new Error(`Gemini status ${resp.status}: ${errorText}`);
		}

		const json = await resp.json();
		const responseText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!responseText) {
			throw new Error("No text in Gemini response");
		}
		return JSON.parse(responseText);
	} catch (err) {
		console.warn(
			`  Gemini Vision analysis failed for ${path.basename(filePath)}: ${err.message}`,
		);
		return null;
	}
}

async function analyzeScreenshot(filePath, baseDir, apiKey) {
	const relativePath = path.relative(baseDir, filePath);
	const fileName = path.basename(filePath);

	// Find which device spec matches this file based on prefix
	let matchedDeviceType = null;
	for (const devicePrefix of Object.keys(DEVICE_SPECS)) {
		if (fileName.startsWith(devicePrefix)) {
			matchedDeviceType = devicePrefix;
			break;
		}
	}

	const fileInfo = getImageInfo(filePath);
	const ocr = performOCR(filePath);

	const issues = [];
	const warnings = [];
	const passes = [];

	// 1. Format check: Apple requires PNG
	if (fileInfo.format !== "png") {
		issues.push(
			`Incorrect format: file is **${fileInfo.format ? fileInfo.format.toUpperCase() : "unknown"}**, but App Store screenshots **MUST** be PNG.`,
		);
	} else {
		passes.push("Format is PNG");
	}

	// 2. Alpha Channel Check
	if (fileInfo.hasAlpha) {
		issues.push(
			"Contains an **alpha channel (transparency)**. App Store Connect will reject this screenshot.",
		);
	} else {
		passes.push("No alpha channel");
	}

	// 3. Dimension Checks
	if (matchedDeviceType) {
		const spec = DEVICE_SPECS[matchedDeviceType];
		const isPortrait =
			fileInfo.width === spec.width && fileInfo.height === spec.height;
		const isLandscape =
			fileInfo.width === spec.altWidth && fileInfo.height === spec.altHeight;

		if (!isPortrait && !isLandscape) {
			issues.push(
				`Invalid dimensions for **${spec.name}**: Got \`${fileInfo.width}x${fileInfo.height}\`. Expected \`${spec.width}x${spec.height}\` (Portrait) or \`${spec.altWidth}x${spec.altHeight}\` (Landscape).`,
			);
		} else {
			passes.push(
				`Dimensions match ${spec.name} (\`${fileInfo.width}x${fileInfo.height}\`)`,
			);
		}
	} else {
		warnings.push(
			`Could not determine device category from filename \`${fileName}\`. Expected prefix like: ${Object.keys(DEVICE_SPECS).join(", ")}.`,
		);
	}

	// 4. OCR Content Scan (SpringBoard, Expo Launcher, Debug Ribbon, Status Bar)
	if (ocr.available && ocr.text) {
		const textLower = ocr.text.toLowerCase();

		// Check for iOS Springboard (Simulator Home screen)
		if (
			textLower.includes("calendar") &&
			textLower.includes("photos") &&
			textLower.includes("settings") &&
			textLower.includes("wallet")
		) {
			issues.push(
				"Looks like a screenshot of the **iOS Simulator Home Screen (Springboard)**, not the app.",
			);
		}

		// Check for Expo Go / Dev Launcher
		if (
			textLower.includes("development build") ||
			textLower.includes("metro") ||
			textLower.includes("enter url manually") ||
			textLower.includes("development servers")
		) {
			issues.push(
				"Looks like a screenshot of the **Expo Development Launcher / Expo Go** screen instead of the application.",
			);
		}

		// Check for React Native DEBUG banner
		if (
			textLower.includes("debug") &&
			(textLower.includes("fps") ||
				textLower.includes("metro") ||
				relativePath.includes("debug"))
		) {
			warnings.push('Contains potential debug overlay or "DEBUG" indicator.');
		}

		// Check for time stamp (status bar)
		const timeMatch = ocr.text.match(/\b\d{1,2}:\d{2}\b/);
		if (timeMatch) {
			const time = timeMatch[0];
			if (time !== "9:41") {
				warnings.push(
					`Status bar time is \`${time}\`. Apple's design guidelines recommend standardizing simulator time to \`9:41\`.`,
				);
			} else {
				passes.push("Status bar shows 9:41");
			}
		}
	} else if (!ocr.available) {
		warnings.push("OCR analysis skipped (tesseract not found in PATH).");
	}

	// AI Multimodal Vision Analysis (Detecting popups, system permission alerts, springboard launcher, etc.)
	if (apiKey) {
		const aiResult = await analyzeScreenshotWithGemini(filePath, apiKey);
		if (aiResult) {
			if (aiResult.isHomeScreen) {
				issues.push(
					"AI Vision: Looks like a screenshot of the **mobile home screen** instead of the app UI.",
				);
			}
			if (aiResult.isDevLauncher) {
				issues.push(
					"AI Vision: Looks like a screenshot of the **Expo Go client / developer launcher**.",
				);
			}
			if (aiResult.hasDebugOverlay) {
				warnings.push(
					"AI Vision: Contains a visible **debug banner / FPS meter / debug overlay**.",
				);
			}
			if (aiResult.hasPopupOrModal) {
				issues.push(
					"AI Vision: Contains a visible **popup, permission dialog (e.g., location permissions), or system alert modal**.",
				);
			}
			if (aiResult.statusBarTime && aiResult.statusBarTime !== "9:41") {
				warnings.push(
					`AI Vision: Status bar time is \`${aiResult.statusBarTime}\` instead of standard \`9:41\`.`,
				);
			} else if (aiResult.statusBarTime === "9:41") {
				passes.push("AI Vision: Status bar shows 9:41");
			}
		}
	}

	// 5. File size check (warning if > 2MB)
	const sizeMB = (fileInfo.sizeBytes / (1024 * 1024)).toFixed(2);
	if (fileInfo.sizeBytes > 2 * 1024 * 1024) {
		warnings.push(
			`Large file size: **${sizeMB} MB**. We recommend compressing screenshots to speed up downloads and uploads.`,
		);
	} else {
		passes.push(`File size is optimized (${sizeMB} MB)`);
	}

	return {
		relativePath,
		filePath,
		deviceType: matchedDeviceType || "unknown",
		theme: "unknown",
		scene: "unknown",
		fileInfo,
		issues,
		warnings,
		passes,
		ocrText: ocr.text,
	};
}

function fixScreenshot(analysis) {
	const { filePath, fileInfo, relativePath } = analysis;
	let fixed = false;
	const actionsTaken = [];

	const fileExt = path.extname(filePath).toLowerCase();
	const dirName = path.dirname(filePath);
	const baseName = path.basename(filePath, fileExt);

	let targetPath = filePath;

	if (fileInfo.format !== "png") {
		const pngPath = path.join(dirName, `${baseName}.png`);
		console.log(`Converting ${relativePath} to PNG...`);
		const convertCmd = runCommand(`which convert`);
		if (convertCmd) {
			runCommand(`convert "${filePath}" -alpha off "${pngPath}"`);
		} else {
			runCommand(`sips -s format png "${filePath}" --out "${pngPath}"`);
		}
		fs.unlinkSync(filePath);
		targetPath = pngPath;
		actionsTaken.push(`Converted format to PNG: \`${path.basename(pngPath)}\``);
		fixed = true;

		analysis.filePath = pngPath;
		analysis.relativePath = path.relative(
			path.join(process.cwd(), "app_store_assets/screenshots"),
			pngPath,
		);
		analysis.fileInfo = getImageInfo(pngPath);
	}

	if (analysis.fileInfo.hasAlpha) {
		console.log(`Stripping alpha channel from ${analysis.relativePath}...`);
		const convertCmd = runCommand(`which convert`);
		if (convertCmd) {
			runCommand(
				`convert "${targetPath}" -background white -alpha remove -alpha off "${targetPath}"`,
			);
			actionsTaken.push("Removed alpha channel using ImageMagick");
			fixed = true;
		} else {
			runCommand(
				`sips -s format png "${targetPath}" --setProperty formatOptions default --out "${targetPath}"`,
			);
			actionsTaken.push("Removed alpha channel using sips");
			fixed = true;
		}

		analysis.fileInfo = getImageInfo(targetPath);
	}

	return { fixed, actionsTaken };
}

function generateMarkdownReport(results, _baseDir) {
	let md = `# App Store Screenshot Quality Control Report\n\n`;
	md += `*Generated on: ${new Date().toLocaleString()}*\n\n`;

	const totalFiles = results.length;
	const totalIssues = results.reduce((acc, r) => acc + r.issues.length, 0);
	const totalWarnings = results.reduce((acc, r) => acc + r.warnings.length, 0);

	md += `## Summary\n\n`;
	md += `- **Total screenshots found**: ${totalFiles}\n`;
	md += `- **Critical Issues (App Store Rejections)**: <span style="color:red">**${totalIssues}**</span>\n`;
	md += `- **Warnings / Design Recommendations**: <span style="color:orange">**${totalWarnings}**</span>\n\n`;

	if (totalIssues > 0) {
		md += `> [!CAUTION]\n`;
		md += `> **${totalIssues} critical issues detected!** Screenshots containing alpha channels, incorrect dimensions, or showing developer menu screens will be rejected by Apple App Store Connect. Use the \`pnpm run qc-screenshots -- --fix\` command to resolve alpha channels and formats automatically.\n\n`;
	} else {
		md += `> [!TIP]\n`;
		md += `> No critical technical blocking issues found. Make sure the screenshot content matches your latest design expectations.\n\n`;
	}

	md += `## Detailed Results\n\n`;

	for (const res of results) {
		md += `### \`${res.relativePath}\`\n\n`;
		md += `- **Path**: [${path.basename(res.filePath)}](file://${res.filePath})\n`;
		md += `- **Format**: ${res.fileInfo.format ? res.fileInfo.format.toUpperCase() : "Unknown"}\n`;
		md += `- **Dimensions**: \`${res.fileInfo.width} x ${res.fileInfo.height} px\`\n`;
		md += `- **Alpha Channel**: ${res.fileInfo.hasAlpha ? "🔴 Yes (Rejected by Apple)" : "🟢 No"}\n`;
		md += `- **File Size**: \`${(res.fileInfo.sizeBytes / (1024 * 1024)).toFixed(2)} MB\`\n\n`;

		if (res.issues.length > 0) {
			md += `#### 🔴 Critical Issues:\n`;
			res.issues.forEach((iss) => {
				md += `- ${iss}\n`;
			});
			md += `\n`;
		}

		if (res.warnings.length > 0) {
			md += `#### ⚠️ Warnings:\n`;
			res.warnings.forEach((warn) => {
				md += `- ${warn}\n`;
			});
			md += `\n`;
		}

		if (res.passes.length > 0) {
			md += `#### 🟢 Passed Checks:\n`;
			res.passes.forEach((pass) => {
				md += `- ${pass}\n`;
			});
			md += `\n`;
		}

		if (res.ocrText) {
			md += `<details>\n<summary>Extracted Text (OCR)</summary>\n\n\`\`\`text\n${res.ocrText.trim()}\n\`\`\`\n\n</details>\n\n`;
		}

		md += `---\n\n`;
	}

	return md;
}

async function main() {
	const baseDir = path.join(process.cwd(), "app_store_assets/screenshots");
	const fixArg = process.argv.includes("--fix");
	const apiKey = process.env.GEMINI_API_KEY;

	console.log(`Starting Screenshot QC Scanner in: ${baseDir}`);
	console.log(`Fix option: ${fixArg ? "ENABLED" : "DISABLED"}`);
	if (apiKey) {
		console.log(`AI Vision: ENABLED (using gemini-2.5-flash)\n`);
	} else {
		console.log(
			`AI Vision: DISABLED (GEMINI_API_KEY environment variable not found)\n`,
		);
	}

	if (!fs.existsSync(baseDir)) {
		console.error(`Error: Screenshots directory not found at ${baseDir}`);
		process.exit(1);
	}

	const files = scanScreenshotsDir(baseDir);
	if (files.length === 0) {
		console.log(
			"No screenshots found in app_store_assets/screenshots/ directory.",
		);
		process.exit(0);
	}

	const results = [];
	let count = 0;

	for (const file of files) {
		if (count > 0 && apiKey) {
			// Avoid rate limits of free-tier Gemini API (15 RPM)
			await new Promise((r) => setTimeout(r, 5000));
		}
		console.log(`Scanning: ${path.relative(baseDir, file)}...`);
		const analysis = await analyzeScreenshot(file, baseDir, apiKey);
		count++;

		if (fixArg) {
			const fixResult = fixScreenshot(analysis);
			if (fixResult.fixed) {
				console.log(`Fixed issues: ${fixResult.actionsTaken.join(", ")}`);
				const reanalysis = await analyzeScreenshot(
					analysis.filePath,
					baseDir,
					apiKey,
				);
				reanalysis.fixedActions = fixResult.actionsTaken;
				results.push(reanalysis);
				continue;
			}
		}

		results.push(analysis);
	}

	console.log("\n======================================");
	console.log("         SCREENSHOT QC REPORT         ");
	console.log("======================================");

	let totalIssues = 0;
	let totalWarnings = 0;

	results.forEach((res) => {
		totalIssues += res.issues.length;
		totalWarnings += res.warnings.length;

		console.log(`\nFile: ${res.relativePath}`);
		console.log(`  Dimensions: ${res.fileInfo.width}x${res.fileInfo.height}`);
		console.log(
			`  Format: ${res.fileInfo.format.toUpperCase()} | Alpha Channel: ${res.fileInfo.hasAlpha ? "YES (🔴 CRITICAL)" : "NO"}`,
		);

		if (res.issues.length > 0) {
			console.log("  🔴 Issues:");
			res.issues.forEach((iss) => {
				console.log(`     - ${iss.replace(/\*\*/g, "")}`);
			});
		}
		if (res.warnings.length > 0) {
			console.log("  ⚠️ Warnings:");
			res.warnings.forEach((warn) => {
				console.log(`     - ${warn.replace(/\*\*/g, "")}`);
			});
		}
		if (res.issues.length === 0 && res.warnings.length === 0) {
			console.log("  🟢 All checks passed.");
		}
		if (res.fixedActions) {
			console.log(`  🛠️ Fixed Actions: ${res.fixedActions.join(", ")}`);
		}
	});

	console.log("\n======================================");
	console.log(`Scan Summary:`);
	console.log(`Total Files Checked: ${results.length}`);
	console.log(`Critical Issues: ${totalIssues}`);
	console.log(`Warnings/Suggestions: ${totalWarnings}`);
	console.log("======================================\n");

	const reportPath = path.join(baseDir, "qc_report.md");
	const markdownReport = generateMarkdownReport(results, baseDir);
	fs.writeFileSync(reportPath, markdownReport, "utf-8");
	console.log(`Saved detailed QC report to: ${reportPath}`);

	if (totalIssues > 0 && !fixArg) {
		console.log(
			"Tip: Run this script with the --fix argument to automatically resolve alpha channels and format mismatches:",
		);
		console.log("     pnpm run qc-screenshots -- --fix\n");
	}
}

main();
