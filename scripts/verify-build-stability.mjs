import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";

const root = fileURLToPath(new URL("..", import.meta.url));
const pnpmPath = process.env.npm_execpath;
if (!pnpmPath) {
	throw new Error("Run this check through pnpm so it can start the package build.");
}

function run_build() {
	const result = spawnSync(process.execPath, [pnpmPath, "run", "build"], { cwd: root, stdio: "inherit" });
	if (result.status !== 0) {
		throw new Error(`Council build failed with exit code ${result.status ?? "unknown"}`);
	}
}

// scripts/build-manifest.mjs has its own copy of this walk, but that script does all its work at
// module top level. Importing anything from it would run a manifest build as a side effect, so this
// check keeps its own copy.
function collect_files(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			files.push(...collect_files(path));
		} else {
			files.push(path);
		}
	}
	return files;
}

function snapshot() {
	const paths = [join(root, "bonobo.plugin.json"), join(root, "package.json"), ...collect_files(join(root, "dist"))];
	return new Map(
		paths.sort().map((path) => [relative(root, path), createHash("sha256").update(readFileSync(path)).digest("hex")]),
	);
}

// Fingerprint the release files as they sit on disk, before the first build overwrites them. Two
// fresh builds only prove that the build repeats itself. They can both agree while the files on
// disk were built from older sources.
// This check reads the working tree with `readFileSync`. It never asks git anything, so it cannot
// say whether the files on disk are the committed ones. The release checklist in README.md checks
// that separately with `git status` after the commit, because the publisher reads the files from
// GitHub at the pinned commit.
const onDisk = snapshot();
run_build();
const first = snapshot();
run_build();
const second = snapshot();
// Check the build against itself first. When the build does not repeat itself, comparing the files
// that were on disk to one of its runs says nothing.
if (JSON.stringify([...first]) !== JSON.stringify([...second])) {
	throw new Error("Council's second full build changed release bytes.");
}
if (JSON.stringify([...onDisk]) !== JSON.stringify([...first])) {
	throw new Error("Council's release files on disk are stale: a full build changed them. Keep the rebuilt files.");
}
console.log(
	`Council full build is byte-stable across ${second.size} release files, and the files that were on disk match it.`,
);
