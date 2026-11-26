import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(__dirname, "../../..");

export function repoPath(relPath) {
	return join(REPO_ROOT, relPath);
}

export function repoExists(relPath) {
	return existsSync(repoPath(relPath));
}

export function readRepoFile(relPath) {
	return readFileSync(repoPath(relPath), "utf8");
}

export function readRepoJson(relPath) {
	return JSON.parse(readRepoFile(relPath));
}

export function listFilesRecursive(relDir, filterFn = null) {
	const root = repoPath(relDir);
	if (!existsSync(root)) return [];
	const out = [];
	function walk(dir) {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
			} else if (entry.isFile()) {
				const rel = full.slice(REPO_ROOT.length + 1);
				if (!filterFn || filterFn(rel, full)) {
					out.push(rel);
				}
			}
		}
	}
	walk(root);
	return out.sort();
}

export function runCli(cmd, args, opts = {}) {
	try {
		const stdout = execFileSync(cmd, args, {
			cwd: opts.cwd ?? REPO_ROOT,
			env: opts.env ?? process.env,
			encoding: "utf8",
			stdio: ["pipe", "pipe", "pipe"],
			timeout: opts.timeout ?? 30000,
		});
		return { status: 0, stdout, stderr: "" };
	} catch (err) {
		return {
			status: err.status ?? 1,
			stdout: err.stdout ? String(err.stdout) : "",
			stderr: err.stderr ? String(err.stderr) : String(err.message),
		};
	}
}

export function parseTsxAst(relPath) {
	const fullPath = repoPath(relPath);
	const source = readFileSync(fullPath, "utf8");
	const kind = relPath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
	return ts.createSourceFile(
		fullPath,
		source,
		ts.ScriptTarget.Latest,
		true,
		kind,
	);
}

export function walkAst(node, visitor) {
	visitor(node);
	ts.forEachChild(node, (child) => walkAst(child, visitor));
}

export function getNodeText(ast, node) {
	return ast.text.slice(node.getStart(ast), node.getEnd());
}

export function findFunctionsByName(ast, name) {
	const results = [];
	walkAst(ast, (node) => {
		if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
			results.push(node);
		} else if (
			ts.isVariableDeclaration(node) &&
			ts.isIdentifier(node.name) &&
			node.name.text === name &&
			node.initializer &&
			(ts.isArrowFunction(node.initializer) ||
				ts.isFunctionExpression(node.initializer))
		) {
			results.push(node.initializer);
		}
	});
	return results;
}

export function findCallExpressions(ast, calleeSubstr) {
	const calls = [];
	walkAst(ast, (node) => {
		if (ts.isCallExpression(node)) {
			const exprText = getNodeText(ast, node.expression);
			if (exprText === calleeSubstr || exprText.endsWith(`.${calleeSubstr}`)) {
				calls.push(node);
			}
		}
	});
	return calls;
}

export function findJsxElements(ast, tagName) {
	const elements = [];
	walkAst(ast, (node) => {
		if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
			if (getNodeText(ast, node.tagName) === tagName) {
				elements.push(node);
			}
		}
	});
	return elements;
}

export function findObjectPropertyAssignments(ast, propName) {
	const props = [];
	walkAst(ast, (node) => {
		if (ts.isPropertyAssignment(node)) {
			const key = ts.isIdentifier(node.name)
				? node.name.text
				: ts.isStringLiteral(node.name)
					? node.name.text
					: null;
			if (key === propName) {
				props.push(node);
			}
		}
	});
	return props;
}

export function hasStringLiteral(ast, value) {
	let found = false;
	walkAst(ast, (node) => {
		if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			node.text === value
		) {
			found = true;
		}
	});
	return found;
}

export function collectStringLiterals(ast) {
	const vals = [];
	walkAst(ast, (node) => {
		if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
			vals.push(node.text);
		}
	});
	return vals;
}

export function validateYamlBasic(content) {
	const lines = content.split(/\r?\n/);
	const errors = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^\t/.test(line)) {
			errors.push(`Line ${i + 1}: tab indentation in YAML`);
		}
		if (line.trim() === "" || line.trim().startsWith("#")) continue;
		if (line.trim() === "---") continue;
		const indent = line.match(/^ */)[0].length;
		if (indent % 2 !== 0 && !line.trim().startsWith("- ")) {
			errors.push(`Line ${i + 1}: odd indentation (${indent} spaces)`);
		}
	}
	return errors;
}

export function fileSizeBytes(relPath) {
	return statSync(repoPath(relPath)).size;
}
