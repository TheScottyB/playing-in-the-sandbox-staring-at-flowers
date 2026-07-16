import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ENV_PATH = path.join(process.cwd(), ".env.local");

function getApiKey() {
	if (!fs.existsSync(ENV_PATH)) {
		throw new Error(".env.local not found");
	}
	const envContent = fs.readFileSync(ENV_PATH, "utf-8");
	const match = envContent.match(/^GEMINI_API_KEY=(.*)$/m);
	if (!match) {
		throw new Error("GEMINI_API_KEY not found in .env.local");
	}
	return match[1].trim();
}

async function analyzeScreenshot(apiKey, base64Image) {
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

	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const text = await response.text();
		let errorObj;
		try {
			errorObj = JSON.parse(text);
		} catch (_e) {}

		const errorMessage = errorObj?.error?.message || text;
		const isBillingOrQuota =
			response.status === 429 ||
			errorMessage.includes("prepayment credits") ||
			errorMessage.includes("RESOURCE_EXHAUSTED") ||
			errorObj?.error?.status === "RESOURCE_EXHAUSTED";

		if (isBillingOrQuota) {
			console.error(
				"\n======================================================================",
			);
			console.error("🔴 CRITICAL GEMINI API ERROR: BILLING OR QUOTA EXHAUSTED");
			console.error(errorMessage);
			console.error(
				"======================================================================\n",
			);
			process.exit(1);
		}

		throw new Error(`Gemini API error: ${response.status} ${text}`);
	}

	const data = await response.json();
	const textResponse = data.candidates[0].content.parts[0].text;
	return JSON.parse(textResponse);
}

async function main() {
	console.log("🤖 Starting AI Agent Popup Squasher...");
	const apiKey = getApiKey();
	const maxIterations = 10;

	for (let i = 0; i < maxIterations; i++) {
		console.log(`\n[Iteration ${i + 1}] Taking screenshot...`);
		const screenshotPath = "/tmp/squash-screenshot.png";
		try {
			execSync(`xcrun simctl io booted screenshot ${screenshotPath}`, {
				stdio: "ignore",
			});
		} catch (_e) {
			console.error("Failed to take screenshot. Is the simulator booted?");
			process.exit(1);
		}

		const base64Image = fs.readFileSync(screenshotPath).toString("base64");

		console.log("Analyzing with Gemini 2.0 Flash...");
		let result;
		try {
			result = await analyzeScreenshot(apiKey, base64Image);
		} catch (e) {
			console.error("Analysis failed:", e.message);
			break;
		}

		if (!result.hasPopup) {
			console.log("✅ Screen is clear! Proceeding...");
			break;
		}

		console.log(
			`⚠️ Found popup: "${result.reason}". Tapping at (${result.x}, ${result.y})...`,
		);

		try {
			const wStr = execSync(
				`sips -g pixelWidth /tmp/squash-screenshot.png | awk '/pixelWidth/ {print $2}'`,
				{ encoding: "utf-8" },
			).trim();
			const hStr = execSync(
				`sips -g pixelHeight /tmp/squash-screenshot.png | awk '/pixelHeight/ {print $2}'`,
				{ encoding: "utf-8" },
			).trim();
			const width = parseInt(wStr, 10) || 1242;
			const height = parseInt(hStr, 10) || 2688;

			const xPct = Math.round((result.x / width) * 100);
			const yPct = Math.round((result.y / height) * 100);

			console.log(
				`     Calculated percentage: ${xPct}%, ${yPct}% of ${width}x${height}`,
			);

			const tempFlowPath = "/tmp/temp-squash-tap.yml";
			fs.writeFileSync(
				tempFlowPath,
				`appId: host.exp.Exponent
---
- tapOn:
    point: ${xPct}%, ${yPct}%
`,
			);
			execSync(`maestro test ${tempFlowPath}`, { stdio: "ignore" });
		} catch (clickErr) {
			console.error("Failed to click popup via Maestro:", clickErr.message);
		}

		// Wait for dismissal animation
		execSync("sleep 2");
	}
}

main().catch((err) => {
	console.error("Fatal error in agent squasher:", err);
	process.exit(1);
});
