import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "com.djscottyb.playinginthesandoxlookingatflowers";

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

export function getApiKey(envPath = path.join(process.cwd(), ".env.local")) {
	const envKey = process.env.GEMINI_API_KEY?.trim();
	if (envKey) {
		return envKey;
	}
	if (!fs.existsSync(envPath)) {
		throw new Error(
			"GEMINI_API_KEY environment variable not set and .env.local not found",
		);
	}
	const envContent = fs.readFileSync(envPath, "utf-8");
	const match = envContent.match(/^GEMINI_API_KEY=(.*)$/m);
	if (!match?.[1].trim()) {
		throw new Error("GEMINI_API_KEY not found in .env.local");
	}
	let val = match[1].trim();
	if (
		(val.startsWith('"') && val.endsWith('"')) ||
		(val.startsWith("'") && val.endsWith("'"))
	) {
		val = val.slice(1, -1);
	}
	return val;
}

function parseSipsField(output, key) {
	if (!output) return null;
	const match = output.match(new RegExp(`^\\s+${key}:\\s*(.+)$`, "m"));
	return match ? match[1].trim() : null;
}

export function computeTapPercentages(x, y, width, height) {
	if (!Number.isFinite(x) || !Number.isFinite(y)) {
		throw new Error(`Invalid popup coordinates from Gemini: x=${x}, y=${y}`);
	}
	const safeW = Number.isFinite(width) && width > 0 ? width : 1242;
	const safeH = Number.isFinite(height) && height > 0 ? height : 2688;
	const clampPct = (val) => Math.min(100, Math.max(0, Math.round(val)));
	return {
		xPct: clampPct((x / safeW) * 100),
		yPct: clampPct((y / safeH) * 100),
	};
}

export function buildTapFlowYaml(xPct, yPct) {
	if (!Number.isFinite(xPct) || !Number.isFinite(yPct)) {
		throw new Error(`Invalid tap percentages: xPct=${xPct}, yPct=${yPct}`);
	}
	const clampedX = Math.min(100, Math.max(0, xPct));
	const clampedY = Math.min(100, Math.max(0, yPct));
	return `appId: ${APP_ID}
---
- tapOn:
    point: ${clampedX}%, ${clampedY}%
`;
}

export async function analyzeScreenshot(apiKey, base64Image, options = {}) {
	const {
		fetchImpl = globalThis.fetch,
		sleepImpl = defaultSleep,
		backoffBaseMs = 5000,
		maxAttempts = 3,
	} = options;

	const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`;

	const payload = {
		contents: [
			{
				parts: [
					{
						text: `You are an expert mobile UI automation agent. Examine this screenshot of an iOS simulator running an Expo app.
Is there ANY system popup, permission dialog, error alert, or Expo developer overlay (like 'Got it', 'Dismiss', 'Allow', 'OK') currently covering the screen?
If yes, find the exact center coordinates (x, y) of the button that will dismiss it or accept it safely (e.g. 'Allow' or 'Dismiss').
Return ONLY a JSON object:
{
  "hasPopup": true,
  "x": 123,
  "y": 456,
  "reason": "Found Expo 'Got it' tooltip"
}
If the screen is clear of any blocking popups and the main app is fully visible, return:
{
  "hasPopup": false
}
Do NOT include any markdown formatting or backticks. Return raw JSON.`,
					},
					{ inlineData: { mimeType: "image/png", data: base64Image } },
				],
			},
		],
		generationConfig: {
			temperature: 0.1,
			responseMimeType: "application/json",
		},
	};

	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		let response;
		try {
			response = await fetchImpl(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
		} catch (networkErr) {
			lastErr = networkErr;
			if (attempt === maxAttempts) throw lastErr;
			const waitMs = backoffBaseMs * attempt;
			console.warn(
				`Gemini retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms (${networkErr.message})`,
			);
			await sleepImpl(waitMs);
			continue;
		}

		if (response.ok) {
			const data = await response.json();
			const textResponse = data?.candidates?.[0]?.content?.parts?.[0]?.text;
			if (!textResponse) {
				throw new Error("No text in Gemini response");
			}
			return JSON.parse(textResponse);
		}

		const text = await response.text();
		let errorObj;
		try {
			errorObj = JSON.parse(text);
		} catch (_e) {}

		const errorMessage = errorObj?.error?.message || text;
		const isQuotaExhaustedBody =
			errorMessage.includes("RESOURCE_EXHAUSTED") ||
			errorObj?.error?.status === "RESOURCE_EXHAUSTED";
		const isPermanentBillingOrAuth =
			response.status === 402 ||
			response.status === 403 ||
			errorMessage.includes("prepayment credits") ||
			errorMessage.includes("API key not valid") ||
			(response.status !== 429 &&
				!isQuotaExhaustedBody &&
				/\bbilling\b/i.test(errorMessage));

		if (isPermanentBillingOrAuth) {
			const fatalErr = new Error(
				`Gemini billing/auth error (${response.status}): ${errorMessage}`,
			);
			fatalErr.isFatalBillingOrQuota = true;
			throw fatalErr;
		}

		lastErr = new Error(`Gemini API error: ${response.status} ${text}`);

		const retryable = response.status === 429 || response.status >= 500;
		if (!retryable || attempt === maxAttempts) {
			if (response.status === 429 || isQuotaExhaustedBody) {
				const quotaErr = new Error(
					`Gemini quota exhausted after ${attempt} attempts (${response.status}): ${errorMessage}`,
				);
				quotaErr.isFatalBillingOrQuota = true;
				throw quotaErr;
			}
			throw lastErr;
		}

		const retryAfterMs = parseRetryAfterMs(response.headers);
		const waitMs =
			retryAfterMs !== null ? retryAfterMs : backoffBaseMs * attempt;

		console.warn(
			`Gemini retry ${attempt}/${maxAttempts - 1} after ${waitMs}ms (${response.status})`,
		);
		await sleepImpl(waitMs);
	}

	throw lastErr;
}

export async function main() {
	console.log("🤖 Starting AI Agent Popup Squasher...");
	const apiKey = getApiKey();
	const maxIterations = 10;
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "squash-popups-"));

	try {
		const screenshotPath = path.join(tempDir, "squash-screenshot.png");
		const tempFlowPath = path.join(tempDir, "temp-squash-tap.yml");

		for (let i = 0; i < maxIterations; i++) {
			console.log(`\n[Iteration ${i + 1}] Taking screenshot...`);
			try {
				execFileSync(
					"xcrun",
					["simctl", "io", "booted", "screenshot", screenshotPath],
					{
						stdio: "ignore",
					},
				);
			} catch (_e) {
				console.error("Failed to take screenshot. Is the simulator booted?");
				process.exitCode = 1;
				return;
			}

			const base64Image = fs.readFileSync(screenshotPath).toString("base64");

			console.log("Analyzing with Gemini Flash...");
			let result;
			try {
				result = await analyzeScreenshot(apiKey, base64Image);
			} catch (e) {
				console.error("Analysis failed:", e.message);
				if (e?.isFatalBillingOrQuota) {
					process.exitCode = 1;
				}
				break;
			}

			if (!result?.hasPopup) {
				console.log("✅ Screen is clear! Proceeding...");
				break;
			}

			console.log(
				`⚠️ Found popup: "${result.reason}". Tapping at (${result.x}, ${result.y})...`,
			);

			try {
				let width = 1242;
				let height = 2688;
				try {
					const sipsOut = execFileSync(
						"sips",
						["-g", "pixelWidth", "-g", "pixelHeight", screenshotPath],
						{ encoding: "utf-8" },
					);
					width =
						Number.parseInt(parseSipsField(sipsOut, "pixelWidth") ?? "", 10) ||
						1242;
					height =
						Number.parseInt(parseSipsField(sipsOut, "pixelHeight") ?? "", 10) ||
						2688;
				} catch (_sipsErr) {
					// Keep default simulator dimensions if sips is unavailable
				}

				const { xPct, yPct } = computeTapPercentages(
					result.x,
					result.y,
					width,
					height,
				);

				console.log(
					`     Calculated percentage: ${xPct}%, ${yPct}% of ${width}x${height}`,
				);

				fs.writeFileSync(tempFlowPath, buildTapFlowYaml(xPct, yPct));
				execFileSync("maestro", ["test", tempFlowPath], { stdio: "ignore" });
			} catch (clickErr) {
				console.error("Failed to click popup via Maestro:", clickErr.message);
			}

			// Wait for dismissal animation
			await defaultSleep(2000);
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
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
		console.error("Fatal error in agent squasher:", err);
		process.exitCode = 1;
	});
}
