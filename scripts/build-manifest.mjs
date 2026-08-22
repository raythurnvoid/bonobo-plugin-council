#!/usr/bin/env node
// Rebuilds bonobo.plugin.json's files[] inventory, package.json's version, and dist/bonobo.plugin.json.
//
// Every file under dist/frontend/ is read from disk and becomes one files[] entry with its content type,
// byte size, and sha256. Nothing is carried over from the old inventory, so a newly emitted asset can
// never be left out of it. Paths are relative to the repository root, which is how the app fetches them
// from GitHub at publish time. The rest of the manifest is the source of truth and is kept as written,
// then rewritten as tab-indented JSON. package.json's version is synced from the manifest with a string
// splice, so that file keeps its exact formatting. When a file is already in sync the run writes nothing.
//
// Usage: pnpm build:manifest

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { extname, dirname, join, relative, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const frontendRoot = join(repoRoot, "dist/frontend");
// These five mirror the host's own publish limits so a build fails here instead of at publish time.
// Keep them equal to MAX_FILES, MAX_FILE_BYTES, plugins_MAX_ARTIFACT_BYTES, and MAX_LINE_LENGTH in the
// app's packages/app/shared/plugins.ts, and to REVIEW_BUNDLE_MAX_BYTES in packages/app/convex/plugins.ts.
const MAX_FILES = 64;
const MAX_FILE_BYTES = 900_000;
const MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const MAX_REVIEW_BYTES = 900_000;
const REVIEW_LINE_ADVICE_LENGTH = 1_000;

// Keep reviewable extensions aligned with the host reviewer in convex/plugins.ts.
const CONTENT_TYPE_BY_EXTENSION = new Map([
	[".cjs", "application/javascript"],
	[".css", "text/css"],
	[".gif", "image/gif"],
	[".htm", "text/html"],
	[".html", "text/html"],
	[".ico", "image/x-icon"],
	[".jpeg", "image/jpeg"],
	[".jpg", "image/jpeg"],
	[".js", "application/javascript"],
	[".json", "application/json"],
	[".md", "text/markdown"],
	[".mjs", "application/javascript"],
	[".png", "image/png"],
	[".svg", "image/svg+xml"],
	[".txt", "text/plain"],
	[".wasm", "application/wasm"],
	[".webp", "image/webp"],
	[".woff", "font/woff"],
	[".woff2", "font/woff2"],
]);

const REVIEWABLE_EXTENSIONS = new Set([".cjs", ".css", ".htm", ".html", ".js", ".json", ".md", ".mjs", ".svg", ".txt"]);
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function fail(message) {
	console.error(`build-manifest: ${message}`);
	process.exit(1);
}

function readText(relativePath) {
	try {
		return readFileSync(join(repoRoot, relativePath), "utf8");
	} catch {
		fail(`Cannot read "${relativePath}"`);
	}
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Replaces the raw JSON value (string or number) of the first `"key": <value>` found inside the object
// that starts at the first match of anchorPattern and ends at the next "}". Only the value bytes change;
// everything else in the file is kept as it was.
function replaceJsonValue(text, anchorPattern, key, rawValue, context) {
	const anchorMatch = anchorPattern.exec(text);
	if (!anchorMatch) {
		fail(`Cannot find ${context}`);
	}
	const objectEnd = text.indexOf("}", anchorMatch.index) + 1;
	const valuePattern = new RegExp(`("${escapeRegExp(key)}"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|-?\\d+)`);
	const valueMatch = valuePattern.exec(text.slice(anchorMatch.index, objectEnd));
	if (!valueMatch) {
		fail(`Cannot find "${key}" in ${context}`);
	}
	const valueStart = anchorMatch.index + valueMatch.index + valueMatch[1].length;
	return text.slice(0, valueStart) + rawValue + text.slice(valueStart + valueMatch[2].length);
}

function writeIfChanged(relativePath, originalText, updatedText) {
	if (updatedText === originalText) {
		console.log(`build-manifest: "${relativePath}" already in sync`);
		return;
	}
	writeFileSync(join(repoRoot, relativePath), updatedText);
	console.log(`build-manifest: updated "${relativePath}"`);
}

function collectFiles(directory) {
	const paths = [];
	let entries;
	try {
		entries = readdirSync(directory, { withFileTypes: true });
	} catch {
		fail('Cannot read "dist/frontend"');
	}
	for (const entry of entries) {
		const absolutePath = join(directory, entry.name);
		if (entry.isDirectory()) {
			paths.push(...collectFiles(absolutePath));
		} else if (entry.isFile()) {
			paths.push(`dist/frontend/${relative(frontendRoot, absolutePath).split(sep).join("/")}`);
		}
	}
	return paths;
}

const originalManifestText = readText("bonobo.plugin.json");
let manifest;
try {
	manifest = JSON.parse(originalManifestText);
} catch {
	fail('Cannot parse "bonobo.plugin.json"');
}
for (const key of ["name", "displayName", "version", "description"]) {
	if (typeof manifest[key] !== "string" || manifest[key] === "") {
		fail(`bonobo.plugin.json is missing "${key}"`);
	}
}
if (!Array.isArray(manifest.files)) {
	fail('bonobo.plugin.json has no "files" array');
}

const emittedPaths = collectFiles(frontendRoot).sort();
if (emittedPaths.length > MAX_FILES) {
	fail(`Frontend emits ${emittedPaths.length} files; the manifest limit is ${MAX_FILES}`);
}

const oldFilesByPath = new Map();
for (const file of manifest.files) {
	if (typeof file?.path !== "string" || typeof file.contentType !== "string") {
		fail("bonobo.plugin.json has an invalid files[] entry");
	}
	oldFilesByPath.set(file.path, file);
}

let artifactBytes = 0;
let reviewBytes = 0;
const inventory = emittedPaths.map((path) => {
	const extension = extname(path).toLowerCase();
	const contentType = CONTENT_TYPE_BY_EXTENSION.get(extension);
	if (!contentType) {
		fail(`Unknown emitted file extension for "${path}"`);
	}
	const oldFile = oldFilesByPath.get(path);
	if (oldFile && oldFile.contentType !== contentType) {
		fail(`Manifest MIME mismatch for "${path}": expected ${contentType}, found ${oldFile.contentType}`);
	}

	const bytes = readFileSync(join(repoRoot, path));
	if (bytes.byteLength > MAX_FILE_BYTES) {
		fail(`Manifest file exceeds ${MAX_FILE_BYTES} bytes: "${path}"`);
	}
	artifactBytes += bytes.byteLength;

	if (REVIEWABLE_EXTENSIONS.has(extension)) {
		let source;
		try {
			source = fatalUtf8Decoder.decode(bytes);
		} catch {
			fail(`Reviewable file is not valid UTF-8: "${path}"`);
		}
		reviewBytes += bytes.byteLength;
		const longestLine = source.split(/\r?\n/u).reduce((longest, line) => Math.max(longest, line.length), 0);
		if (longestLine > REVIEW_LINE_ADVICE_LENGTH) {
			console.warn(
				`build-manifest: review advice: "${path}" has a ${longestLine}-character line; this does not block the build`,
			);
		}
	}

	return {
		path,
		sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		bytes: bytes.byteLength,
		contentType,
	};
});

if (artifactBytes > MAX_ARTIFACT_BYTES) {
	fail(`Artifact is ${artifactBytes} bytes; the manifest limit is ${MAX_ARTIFACT_BYTES}`);
}
if (reviewBytes > MAX_REVIEW_BYTES) {
	fail(`Reviewable text is ${reviewBytes} bytes; the review limit is ${MAX_REVIEW_BYTES}`);
}

const inventoryPaths = new Set(inventory.map((file) => file.path));
for (const page of [...(manifest.pages ?? []), ...(manifest.fileViews ?? [])]) {
	if (typeof page?.entry !== "string" || !inventoryPaths.has(page.entry)) {
		fail(`Manifest entry is missing from the generated inventory: "${page?.entry ?? "unknown"}"`);
	}
}
if (manifest.backend && (typeof manifest.backend.entry !== "string" || !inventoryPaths.has(manifest.backend.entry))) {
	fail(`Manifest entry is missing from the generated inventory: "${manifest.backend.entry ?? "unknown"}"`);
}

manifest.files = inventory;
const manifestText = `${JSON.stringify(manifest, null, "\t")}\n`;
writeIfChanged("bonobo.plugin.json", originalManifestText, manifestText);

const originalPackageJsonText = readText("package.json");
const packageJsonText = replaceJsonValue(
	originalPackageJsonText,
	/^\{/,
	"version",
	JSON.stringify(manifest.version),
	'the top-level object of "package.json"',
);
writeIfChanged("package.json", originalPackageJsonText, packageJsonText);

// dist/bonobo.plugin.json is a byte-copy of the final root manifest. It is the file the app fetches at
// publish time, so it must never drift from the root one.
let originalDistManifestText = null;
try {
	originalDistManifestText = readFileSync(join(repoRoot, "dist/bonobo.plugin.json"), "utf8");
} catch {
	// The first build creates this publishing copy.
}
writeIfChanged("dist/bonobo.plugin.json", originalDistManifestText, manifestText);
