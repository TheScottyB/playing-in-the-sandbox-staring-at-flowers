import { spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { REPO_ROOT } from "./repo.mjs";

export function createTempSandbox(prefix = "flowers-e2e-") {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	return {
		dir,
		cleanup() {
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function prepareSandbox(scriptRelPath, options) {
	const sandbox = createTempSandbox("flowers-cli-");
	const projectRoot = join(sandbox.dir, "project");
	mkdirSync(projectRoot, { recursive: true });

	const destScript = join(projectRoot, scriptRelPath);
	mkdirSync(dirname(destScript), { recursive: true });
	copyFileSync(join(REPO_ROOT, scriptRelPath), destScript);

	const repoNm = join(REPO_ROOT, "node_modules");
	if (existsSync(repoNm)) {
		symlinkSync(repoNm, join(projectRoot, "node_modules"), "dir");
	}

	if (options.linkEasKit) {
		const realKit = resolve(REPO_ROOT, "..", "eas-app-store-kit");
		if (existsSync(realKit)) {
			symlinkSync(realKit, join(sandbox.dir, "eas-app-store-kit"), "dir");
		}
	}

	for (const rel of options.copyFiles ?? []) {
		const src = join(REPO_ROOT, rel);
		if (!existsSync(src)) continue;
		const dst = join(projectRoot, rel);
		mkdirSync(dirname(dst), { recursive: true });
		copyFileSync(src, dst);
	}

	for (const [rel, content] of Object.entries(options.seedFiles ?? {})) {
		const dst = join(projectRoot, rel);
		mkdirSync(dirname(dst), { recursive: true });
		writeFileSync(dst, content);
	}

	const nodeArgs = [];
	if (
		options.preloadCode ||
		options.mockTimeIso ||
		options.fastTimers ||
		options.httpProxyBaseMap
	) {
		const preloadPath = join(sandbox.dir, "preload.mjs");
		const parts = [];
		if (options.fastTimers) {
			parts.push(`
const origSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => {
	const scaled = typeof ms === "number" && ms >= 100 ? 5 : ms;
	return origSetTimeout(fn, scaled, ...rest);
};`);
		}
		if (options.mockTimeIso) {
			parts.push(`
const RealDate = Date;
const fixedMs = RealDate.parse(${JSON.stringify(options.mockTimeIso)});
class MockDate extends RealDate {
	constructor(...args) {
		if (args.length === 0) {
			super(fixedMs);
		} else {
			super(...args);
		}
	}
	static now() {
		return fixedMs;
	}
}
globalThis.Date = MockDate;`);
		}
		if (options.httpProxyBaseMap) {
			parts.push(`
const origFetch = globalThis.fetch;
const proxyMap = ${JSON.stringify(options.httpProxyBaseMap)};
globalThis.fetch = async (input, init) => {
	const urlStr =
		typeof input === "string"
			? input
			: input instanceof URL
				? input.href
				: input.url;
	for (const [prefix, target] of Object.entries(proxyMap)) {
		if (urlStr.startsWith(prefix)) {
			const rewritten = target + urlStr.slice(prefix.length);
			return origFetch(rewritten, init);
		}
	}
	return origFetch(input, init);
};`);
		}
		if (options.preloadCode) {
			parts.push(options.preloadCode);
		}
		writeFileSync(preloadPath, parts.join("\n"), "utf8");
		nodeArgs.push("--import", preloadPath);
	}

	const env = { ...process.env, ...(options.env ?? {}) };
	for (const k of options.unsetEnv ?? []) {
		delete env[k];
	}

	return { sandbox, projectRoot, destScript, nodeArgs, env };
}

export function runScriptInSandbox(scriptRelPath, options = {}) {
	const { sandbox, projectRoot, destScript, nodeArgs, env } = prepareSandbox(
		scriptRelPath,
		options,
	);
	try {
		const res = spawnSync(
			process.execPath,
			[...nodeArgs, destScript, ...(options.args ?? [])],
			{
				cwd: options.cwd ?? projectRoot,
				env,
				encoding: "utf8",
				timeout: options.timeout ?? 30000,
			},
		);

		let inspectResult = null;
		if (options.inspect) {
			inspectResult = options.inspect(projectRoot, sandbox.dir);
		}

		return {
			status: res.status ?? 1,
			stdout: res.stdout ?? "",
			stderr: res.stderr ?? "",
			signal: res.signal ?? null,
			inspectResult,
		};
	} finally {
		sandbox.cleanup();
	}
}

export async function runScriptInSandboxAsync(scriptRelPath, options = {}) {
	const { sandbox, projectRoot, destScript, nodeArgs, env } = prepareSandbox(
		scriptRelPath,
		options,
	);
	try {
		const res = await new Promise((resolveRun) => {
			const child = spawn(
				process.execPath,
				[...nodeArgs, destScript, ...(options.args ?? [])],
				{
					cwd: options.cwd ?? projectRoot,
					env,
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			let timedOut = false;
			const timer = setTimeout(() => {
				timedOut = true;
				child.kill("SIGKILL");
			}, options.timeout ?? 30000);
			child.stdout.on("data", (d) => {
				stdout += d.toString("utf8");
			});
			child.stderr.on("data", (d) => {
				stderr += d.toString("utf8");
			});
			child.on("close", (code, signal) => {
				clearTimeout(timer);
				resolveRun({
					status: timedOut ? 1 : (code ?? 1),
					stdout,
					stderr,
					signal: signal ?? null,
				});
			});
		});

		let inspectResult = null;
		if (options.inspect) {
			inspectResult = options.inspect(projectRoot, sandbox.dir);
		}

		return { ...res, inspectResult };
	} finally {
		sandbox.cleanup();
	}
}
