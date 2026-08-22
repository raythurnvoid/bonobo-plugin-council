// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const scriptSource = readFileSync(new URL("./build-manifest.mjs", import.meta.url), "utf8");
const fixtureRoots: string[] = [];

type FixtureFile = { path: string; body: string | Uint8Array };
type ManifestFile = { path: string; contentType: string };

function create_fixture(files: FixtureFile[], manifestFiles: ManifestFile[] = []) {
	const root = mkdtempSync(join(tmpdir(), "council-build-manifest-"));
	fixtureRoots.push(root);
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts/build-manifest.mjs"), scriptSource);
	for (const file of files) {
		const absolutePath = join(root, file.path);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, file.body);
	}
	writeFileSync(
		join(root, "bonobo.plugin.json"),
		`${JSON.stringify(
			{
				schemaVersion: 1,
				name: "council-test",
				displayName: "Council test",
				version: "1.2.3",
				description: "Build fixture",
				pages: [{ id: "council", title: "Council", entry: "dist/frontend/index.html" }],
				fileViews: [],
				files: manifestFiles.map((file) => ({ ...file, sha256: "sha256:old", bytes: 1 })),
			},
			null,
			"\t",
		)}\n`,
	);
	writeFileSync(join(root, "package.json"), '{\n\t"name": "fixture",\n\t"version": "0.0.0"\n}\n');
	return root;
}

function run_build(root: string) {
	return spawnSync(process.execPath, [join(root, "scripts/build-manifest.mjs")], {
		cwd: root,
		encoding: "utf8",
	});
}

function read_manifest(root: string) {
	return JSON.parse(readFileSync(join(root, "bonobo.plugin.json"), "utf8")) as {
		files: Array<{ path: string; contentType: string; bytes: number; sha256: string }>;
	};
}

afterEach(() => {
	for (const root of fixtureRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe("build-manifest command", () => {
	test("discovers a new emitted file and sorts the full inventory", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/assets/z.js", body: "export const z = 1;" },
			{ path: "dist/frontend/assets/a.css", body: "body {}" },
		]);

		const result = run_build(root);
		expect(result.status, result.stderr).toBe(0);
		expect(read_manifest(root).files.map((file) => file.path)).toEqual([
			"dist/frontend/assets/a.css",
			"dist/frontend/assets/z.js",
			"dist/frontend/index.html",
		]);
	});

	test("removes an inventory file that the frontend no longer emits", () => {
		const root = create_fixture(
			[{ path: "dist/frontend/index.html", body: "<main></main>" }],
			[
				{ path: "dist/frontend/index.html", contentType: "text/html" },
				{ path: "dist/frontend/removed.css", contentType: "text/css" },
			],
		);

		const result = run_build(root);
		expect(result.status, result.stderr).toBe(0);
		expect(read_manifest(root).files.map((file) => file.path)).toEqual(["dist/frontend/index.html"]);
	});

	test("keeps a binary asset out of UTF-8 review and assigns its canonical MIME", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/pixel.png", body: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff]) },
		]);

		const result = run_build(root);
		expect(result.status, result.stderr).toBe(0);
		expect(read_manifest(root).files.find((file) => file.path.endsWith("pixel.png"))?.contentType).toBe("image/png");
	});

	test("refuses a MIME that disagrees with the emitted file extension", () => {
		const root = create_fixture(
			[{ path: "dist/frontend/index.html", body: "<main></main>" }],
			[{ path: "dist/frontend/index.html", contentType: "application/javascript" }],
		);

		const result = run_build(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Manifest MIME mismatch");
	});

	test("refuses invalid UTF-8 in reviewable text", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/app.js", body: new Uint8Array([0xc3, 0x28]) },
		]);

		const result = run_build(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("not valid UTF-8");
	});

	test("accepts 64 files and refuses 65", () => {
		const files = Array.from({ length: 65 }, (_, index) => ({
			path: index === 0 ? "dist/frontend/index.html" : `dist/frontend/file-${String(index).padStart(2, "0")}.txt`,
			body: index === 0 ? "<main></main>" : "ok",
		}));
		const acceptedRoot = create_fixture(files.slice(0, 64));
		const refusedRoot = create_fixture(files);

		const accepted = run_build(acceptedRoot);
		expect(accepted.status, accepted.stderr).toBe(0);
		expect(read_manifest(acceptedRoot).files).toHaveLength(64);
		const refused = run_build(refusedRoot);
		expect(refused.status).toBe(1);
		expect(refused.stderr).toContain("emits 65 files");
	});

	test("refuses combined reviewable text above 900000 bytes", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/a.txt", body: "a".repeat(450_000) },
			{ path: "dist/frontend/b.txt", body: "b".repeat(450_000) },
		]);

		const result = run_build(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Reviewable text is");
	});

	test("reports long lines as advice without blocking the build", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/long.txt", body: "a".repeat(1_001) },
		]);

		const result = run_build(root);
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toContain("review advice");
	});

	test("refuses unknown emitted extensions", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/data.unknown", body: "opaque" },
		]);

		const result = run_build(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Unknown emitted file extension");
	});

	test("refuses a page entry missing from the generated inventory", () => {
		const root = create_fixture([{ path: "dist/frontend/app.js", body: "export const app = true;" }]);

		const result = run_build(root);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Manifest entry is missing from the generated inventory");
	});

	test("a second manifest rebuild is byte-stable", () => {
		const root = create_fixture([
			{ path: "dist/frontend/index.html", body: "<main></main>" },
			{ path: "dist/frontend/assets/app.js", body: "export const app = true;" },
		]);

		const first = run_build(root);
		expect(first.status, first.stderr).toBe(0);
		const filesAfterFirst = ["bonobo.plugin.json", "package.json", "dist/bonobo.plugin.json"].map((path) =>
			readFileSync(join(root, path), "utf8"),
		);
		const second = run_build(root);
		expect(second.status, second.stderr).toBe(0);
		expect(
			["bonobo.plugin.json", "package.json", "dist/bonobo.plugin.json"].map((path) =>
				readFileSync(join(root, path), "utf8"),
			),
		).toEqual(filesAfterFirst);
	});
});
