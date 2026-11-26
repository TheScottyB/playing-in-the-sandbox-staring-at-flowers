import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFiles(cwd = process.cwd()) {
	for (const envFile of [".env.local", ".env"]) {
		const envPath = path.join(cwd, envFile);
		if (fs.existsSync(envPath)) {
			const content = fs.readFileSync(envPath, "utf-8");
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
					if (process.env[key] === undefined) {
						process.env[key] = val;
					}
				}
			}
		}
	}
}

export function getDefaultScreenshotsDir(cwd = process.cwd()) {
	return path.join(cwd, "store/apple/screenshot/en-US");
}

export const DEFAULT_SCREENSHOTS_DIR = getDefaultScreenshotsDir();

// Define expected screenshot criteria for Apple App Store Connect based on app-store-config.json
export const DEVICE_SPECS = {
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

function defaultSleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export function parseRetryAfterMs(headers) {
	const raw = headers?.get?.("Retry-After") ?? headers?.get?.("retry-after");
	if (typeof raw !== "string") return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const seconds = Number(trimmed);
	if (Number.isFinite(seconds)) {
		return seconds >= 0 ? Math.round(seconds * 1000) : null;
	}
	const dateMs = Date.parse(trimmed);
	if (!Number.isNaN(dateMs)) {
		return Math.max(0, dateMs - Date.now());
	}
	return null;
}

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

function normalizeSipsFormat(raw) {
	if (!raw) return null;
	const normalized = raw.trim().toLowerCase();
	if (!normalized || normalized === "<nil>" || normalized === "nil") {
		return null;
	}
	return normalized;
}

export function getImageInfo(filePath) {
	// Use sips (native macOS) to get image details
	const output = runCommand("sips", [
		"-g",
		"pixelWidth",
		"-g",
		"pixelHeight",
		"-g",
		"hasAlpha",
		"-g",
		"format",
		filePath,
	]);
	const widthStr = parseSipsField(output, "pixelWidth");
	const heightStr = parseSipsField(output, "pixelHeight");
	const hasAlphaStr = parseSipsField(output, "hasAlpha");
	const formatStr = parseSipsField(output, "format");

	return {
		width: parseSipsDimension(widthStr),
		height: parseSipsDimension(heightStr),
		hasAlpha: hasAlphaStr === "yes",
		format: normalizeSipsFormat(formatStr),
		sizeBytes: fs.statSync(filePath).size,
	};
}

export function performOCR(filePath) {
	// Use tesseract if available
	const hasTesseract = runCommand("which", ["tesseract"]);
	if (!hasTesseract) {
		return { available: false, text: "" };
	}

	const text = runCommand("tesseract", [filePath, "stdout", "--psm", "3"]);
	return {
		available: true,
		text: text || "",
	};
}

export function scanScreenshotsDir(baseDir) {
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

export async function analyzeScreenshotWithGemini(
	filePath,
	apiKey,
	options = {},
) {
	const {
		fetchImpl = globalThis.fetch,
		sleepImpl = defaultSleep,
		backoffBaseMs = 5000,
		maxAttempts = 3,
		readFile = fs.readFileSync,
	} = options;

	const model = "gemini-2.5-flash";
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

	const buffer = readFile(filePath);
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
		let lastErr;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			let resp;
			try {
				resp = await fetchImpl(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
			} catch (networkErr) {
				lastErr = networkErr;
				if (attempt === maxAttempts) throw lastErr;
				const waitMs = backoffBaseMs * attempt;
				console.warn(
					`  Gemini retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms (${networkErr.message})`,
				);
				await sleepImpl(waitMs);
				continue;
			}

			if (resp.ok) {
				const json = await resp.json();
				const responseText = json?.candidates?.[0]?.content?.parts?.[0]?.text;
				if (!responseText) {
					throw new Error("No text in Gemini response");
				}
				return JSON.parse(responseText);
			}

			const errorText = await resp.text();
			let errorObj;
			try {
				errorObj = JSON.parse(errorText);
			} catch (_e) {}

			const errorMessage = errorObj?.error?.message || errorText;
			const isQuotaExhaustedBody =
				errorMessage.includes("RESOURCE_EXHAUSTED") ||
				errorObj?.error?.status === "RESOURCE_EXHAUSTED";
			const isPermanentBillingOrAuth =
				resp.status === 402 ||
				resp.status === 403 ||
				errorMessage.includes("prepayment credits") ||
				errorMessage.includes("API key not valid") ||
				(resp.status !== 429 &&
					!isQuotaExhaustedBody &&
					/\bbilling\b/i.test(errorMessage));

			if (isPermanentBillingOrAuth) {
				const fatalErr = new Error(
					`Gemini billing/auth error (${resp.status}): ${errorMessage}`,
				);
				fatalErr.isFatalBillingOrQuota = true;
				throw fatalErr;
			}

			lastErr = new Error(`Gemini status ${resp.status}: ${errorText}`);

			const retryable = resp.status === 429 || resp.status >= 500;
			if (!retryable || attempt === maxAttempts) {
				if (resp.status === 429 || isQuotaExhaustedBody) {
					const quotaErr = new Error(
						`Gemini quota exhausted after ${attempt} attempts (${resp.status}): ${errorMessage}`,
					);
					quotaErr.isFatalBillingOrQuota = true;
					throw quotaErr;
				}
				throw lastErr;
			}

			const retryAfterMs = parseRetryAfterMs(resp.headers);
			const waitMs =
				retryAfterMs !== null ? retryAfterMs : backoffBaseMs * attempt;

			console.warn(
				`  Gemini retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms (${resp.status})`,
			);
			await sleepImpl(waitMs);
		}
		throw lastErr;
	} catch (err) {
		if (err?.isFatalBillingOrQuota) {
			throw err;
		}
		console.warn(
			`  Gemini Vision analysis failed for ${path.basename(filePath)}: ${err.message}`,
		);
		return null;
	}
}

export async function analyzeScreenshot(
	filePath,
	baseDir,
	apiKey,
	options = {},
) {
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

	const fileInfo = options.fileInfo ?? getImageInfo(filePath);
	const ocr = options.ocr ?? performOCR(filePath);

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
				`Invalid dimensions for **${spec.name}**: Got \`${fileInfo.width ?? "?"}x${fileInfo.height ?? "?"}\`. Expected \`${spec.width}x${spec.height}\` (Portrait) or \`${spec.altWidth}x${spec.altHeight}\` (Landscape).`,
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
		const aiResult = await analyzeScreenshotWithGemini(
			filePath,
			apiKey,
			options.geminiOptions,
		);
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

function buildJimpStripAlphaArgs(targetPath) {
	const jimpUrl = import.meta.resolve("jimp");
	const inlineScript = [
		'import fs from "node:fs";',
		`import { Jimp, PNGColorType } from ${JSON.stringify(jimpUrl)};`,
		"const p = process.argv[1];",
		"const img = await Jimp.read(p);",
		"const d = img.bitmap.data;",
		"for (let i = 0; i < d.length; i += 4) {",
		"const a = d[i + 3];",
		"if (a < 255) {",
		"const alpha = a / 255;",
		"const inv = 1 - alpha;",
		"d[i] = Math.round(d[i] * alpha + 10 * inv);",
		"d[i + 1] = Math.round(d[i + 1] * alpha + 10 * inv);",
		"d[i + 2] = Math.round(d[i + 2] * alpha + 10 * inv);",
		"d[i + 3] = 255;",
		"}",
		"}",
		'fs.writeFileSync(p, await img.getBuffer("image/png", { colorType: PNGColorType.COLOR }));',
	].join(" ");
	return ["--input-type=module", "-e", inlineScript, targetPath];
}

export function fixScreenshot(
	analysis,
	baseDir = getDefaultScreenshotsDir(),
	options = {},
) {
	const { runCommandImpl = runCommand, getImageInfoImpl = getImageInfo } =
		options;
	const { filePath, fileInfo, relativePath } = analysis;
	let fixed = false;
	let fixFailed = false;
	const actionsTaken = [];

	const rawExt = path.extname(filePath);
	const dirName = path.dirname(filePath);
	const baseName = path.basename(filePath, rawExt);

	let targetPath = filePath;

	if (fileInfo.format !== "png") {
		const pngPath = path.join(dirName, `${baseName}.png`);
		console.log(`Converting ${relativePath} to PNG...`);
		const convertCmd = runCommandImpl("which", ["magick"])
			? "magick"
			: runCommandImpl("which", ["convert"])
				? "convert"
				: null;
		const cmdResult = convertCmd
			? runCommandImpl(convertCmd, [filePath, "-alpha", "off", pngPath])
			: runCommandImpl("sips", [
					"-s",
					"format",
					"png",
					filePath,
					"--out",
					pngPath,
				]);

		const conversionSucceeded =
			cmdResult !== null &&
			fs.existsSync(pngPath) &&
			fs.statSync(pngPath).size > 0;

		if (!conversionSucceeded) {
			if (pngPath !== filePath && fs.existsSync(pngPath)) {
				try {
					if (fs.statSync(pngPath).size === 0) {
						fs.unlinkSync(pngPath);
					}
				} catch (_e) {}
			}
			const errMsg = `Failed to convert ${relativePath} to PNG (original file preserved).`;
			console.warn(`  ⚠️ ${errMsg}`);
			if (Array.isArray(analysis.issues) && !analysis.issues.includes(errMsg)) {
				analysis.issues.push(errMsg);
			}
			return { fixed: false, fixFailed: true, actionsTaken };
		}

		if (pngPath !== filePath && fs.existsSync(filePath)) {
			const pngStat = fs.statSync(pngPath);
			const origStat = fs.statSync(filePath);
			const sameFile =
				pngStat.ino !== 0 &&
				pngStat.dev === origStat.dev &&
				pngStat.ino === origStat.ino;
			if (!sameFile) {
				fs.unlinkSync(filePath);
			}
		}
		targetPath = pngPath;
		actionsTaken.push(`Converted format to PNG: \`${path.basename(pngPath)}\``);
		fixed = true;

		analysis.filePath = pngPath;
		analysis.relativePath = path.relative(baseDir, pngPath);
		analysis.fileInfo = getImageInfoImpl(pngPath);
	}

	if (analysis.fileInfo?.hasAlpha) {
		console.log(`Stripping alpha channel from ${analysis.relativePath}...`);
		const convertCmd = runCommandImpl("which", ["magick"])
			? "magick"
			: runCommandImpl("which", ["convert"])
				? "convert"
				: null;
		const toolName = convertCmd ? "ImageMagick" : "jimp";
		const alphaResult = convertCmd
			? runCommandImpl(convertCmd, [
					targetPath,
					"-background",
					"#0a0a0a",
					"-alpha",
					"remove",
					"-alpha",
					"off",
					targetPath,
				])
			: runCommandImpl(process.execPath, buildJimpStripAlphaArgs(targetPath));

		let updatedInfo = null;
		try {
			updatedInfo = getImageInfoImpl(targetPath);
		} catch (_e) {
			updatedInfo = null;
		}
		if (updatedInfo) {
			analysis.fileInfo = updatedInfo;
		}

		if (alphaResult !== null && updatedInfo?.hasAlpha === false) {
			actionsTaken.push(`Removed alpha channel using ${toolName}`);
			fixed = true;
		} else {
			fixFailed = true;
			const errMsg = `Failed to remove alpha channel from ${analysis.relativePath} using ${toolName}.`;
			console.warn(`  ⚠️ ${errMsg}`);
			if (Array.isArray(analysis.issues) && !analysis.issues.includes(errMsg)) {
				analysis.issues.push(errMsg);
			}
		}
	}

	return fixFailed
		? { fixed, fixFailed: true, actionsTaken }
		: { fixed, actionsTaken };
}

export function generateMarkdownReport(results, baseDir = "") {
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
		md += `> **${totalIssues} critical issues detected!** Screenshots containing alpha channels, incorrect dimensions, or showing developer menu screens will be rejected by Apple App Store Connect. Use the \`pnpm run screenshots:verify -- --fix\` command to resolve alpha channels and formats automatically.\n\n`;
	} else {
		md += `> [!TIP]\n`;
		md += `> No critical technical blocking issues found. Make sure the screenshot content matches your latest design expectations.\n\n`;
	}

	md += `## Detailed Results\n\n`;

	for (const res of results) {
		const relRaw =
			res.relativePath ||
			(baseDir
				? path.relative(baseDir, res.filePath)
				: path.basename(res.filePath));
		const posixRelPath = relRaw.split(path.sep).join("/");
		md += `### \`${posixRelPath}\`\n\n`;
		md += `- **Path**: [${path.basename(res.filePath)}](./${posixRelPath})\n`;
		md += `- **Format**: ${res.fileInfo.format ? res.fileInfo.format.toUpperCase() : "Unknown"}\n`;
		md += `- **Dimensions**: \`${res.fileInfo.width ?? "?"} x ${res.fileInfo.height ?? "?"} px\`\n`;
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

export async function main(argv = process.argv.slice(2)) {
	loadEnvFiles();

	const dirIdx = argv.indexOf("--dir");
	const baseDir =
		dirIdx !== -1 && argv[dirIdx + 1]
			? path.resolve(argv[dirIdx + 1])
			: getDefaultScreenshotsDir();
	const fixArg = argv.includes("--fix");
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
		process.exitCode = 1;
		return;
	}

	const files = scanScreenshotsDir(baseDir);
	if (files.length === 0) {
		console.log(`No screenshots found in ${baseDir} directory.`);
		return;
	}

	const results = [];
	let count = 0;

	try {
		for (const file of files) {
			if (count > 0 && apiKey) {
				// Avoid rate limits of free-tier Gemini API (15 RPM)
				await defaultSleep(5000);
			}
			console.log(`Scanning: ${path.relative(baseDir, file)}...`);
			const analysis = await analyzeScreenshot(file, baseDir, apiKey);
			count++;

			if (fixArg) {
				const fixResult = fixScreenshot(analysis, baseDir);
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
	} catch (err) {
		if (err?.isFatalBillingOrQuota) {
			console.error(
				"\n======================================================================",
			);
			console.error("🔴 CRITICAL GEMINI API ERROR: BILLING OR QUOTA EXHAUSTED");
			console.error(err.message);
			console.error(
				"======================================================================\n",
			);
			process.exitCode = 1;
			return;
		}
		throw err;
	}

	console.log("\n======================================");
	console.log("         SCREENSHOT QC REPORT         ");
	console.log("======================================");

	let totalIssues = 0;
	let totalWarnings = 0;

	results.forEach((res) => {
		totalIssues += res.issues.length;
		totalWarnings += res.warnings.length;

		const formatLabel = res.fileInfo.format
			? res.fileInfo.format.toUpperCase()
			: "UNKNOWN";
		const widthLabel = res.fileInfo.width ?? "?";
		const heightLabel = res.fileInfo.height ?? "?";

		console.log(`\nFile: ${res.relativePath}`);
		console.log(`  Dimensions: ${widthLabel}x${heightLabel}`);
		console.log(
			`  Format: ${formatLabel} | Alpha Channel: ${res.fileInfo.hasAlpha ? "YES (🔴 CRITICAL)" : "NO"}`,
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
		console.log("     pnpm run screenshots:verify -- --fix\n");
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
		console.error("Fatal error:", err);
		process.exitCode = 1;
	});
}
