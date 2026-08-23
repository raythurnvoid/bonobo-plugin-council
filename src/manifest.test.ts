// @vitest-environment node
// The default happy-dom environment rewrites import.meta.url to an http URL, which breaks the
// file reads below; this test only touches the filesystem, so it runs under node.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { COUNCIL_SERVICE_ORIGIN } from "./council-api";

/**
 * Guard the manifest against the host's `plugins_validate_manifest` rules this plugin depends on
 * (packages/app/shared/plugins.ts). The checks mirror the documented limits rather than importing
 * the validator, because the plugin repository builds standalone.
 */

const manifest = JSON.parse(readFileSync(new URL("../bonobo.plugin.json", import.meta.url), "utf8")) as {
	schemaVersion: number;
	name: string;
	displayName: string;
	version: string;
	description: string;
	compatibility: { bonoboPluginRuntime: string };
	configuration?: { description: string; defaultYaml: string } | null;
	events: unknown[];
	pages: { id: string; title: string; entry: string; navItem?: { label: string; icon?: string } }[];
	capabilities: string[];
	outboundOrigins: string[];
	uiOutboundOrigins: string[];
	files: { path: string; sha256: string; bytes: number; contentType: string }[];
};

describe("bonobo.plugin.json", () => {
	test("names the plugin exactly as the deployed COUNCIL_PLUGIN_NAME expects", () => {
		// The Convex service-grant exchange is bound to this exact name.
		expect(manifest.name).toBe("council");
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.compatibility.bonoboPluginRuntime).toBe("1");
		expect(manifest.version).toBe("0.2.0");
		expect(manifest.displayName.length).toBeLessThanOrEqual(80);
		expect(manifest.description.length).toBeLessThanOrEqual(2000);
	});

	test("declares one nav page whose entry is a listed text/html file", () => {
		expect(manifest.pages).toHaveLength(1);
		const page = manifest.pages[0]!;
		expect(page.id).toMatch(/^[a-z0-9][a-z0-9-]{0,63}$/);
		expect(page.navItem?.label.length).toBeLessThanOrEqual(40);
		const entry = manifest.files.find((file) => file.path === page.entry);
		expect(entry?.contentType).toBe("text/html");
	});

	test("declares the exact capability set the Council exchange requires", () => {
		// plugin.service.connect requires plugin.data.read or workspace.files.write, and
		// ui.outbound.fetch requires UI outbound origins — both directions are publish rejections.
		expect([...manifest.capabilities].sort()).toEqual([
			"plugin.data.read",
			"plugin.data.write",
			"plugin.service.connect",
			"ui.outbound.fetch",
			"workspace.files.create-read-only",
			"workspace.files.write",
		]);
	});

	test("keeps each capability explained in the reviewable bundle", () => {
		const frontendJavaScript = manifest.files.find((file) => file.contentType === "application/javascript")!;
		const source = readFileSync(new URL(`../${frontendJavaScript.path}`, import.meta.url), "utf8");

		// The publisher reviews only shipped files. Keep the service-side permissions next to the
		// Worker request so the source-bound review can account for every consent line.
		for (const capability of manifest.capabilities) {
			expect(source).toContain(`\`${capability}\``);
		}
	});

	test("allows the page to reach exactly the Council service origin", () => {
		expect(manifest.uiOutboundOrigins).toEqual([COUNCIL_SERVICE_ORIGIN]);
		// No backend worker ships, so backend egress consents to nothing.
		expect(manifest.outboundOrigins).toEqual([]);
	});

	test("does not declare a destination-folder configuration", () => {
		// The Worker pins the destination at open from the service grant. A YAML folder would
		// look like a member-owned setting and would not reach the Worker.
		expect(manifest.configuration ?? null).toBeNull();
	});

	test("lists only dist/ files inside the documented size caps", () => {
		expect(manifest.files.length).toBeLessThanOrEqual(64);
		let total = 0;
		for (const file of manifest.files) {
			expect(file.path.startsWith("dist/")).toBe(true);
			expect(file.sha256).toMatch(/^sha256:[a-f0-9]{64}$/);
			expect(file.bytes).toBeLessThanOrEqual(900_000);
			total += file.bytes;
		}
		expect(total).toBeLessThanOrEqual(16 * 1024 * 1024);
	});

	test("lists every emitted frontend file once in sorted order", () => {
		const collect = (directory: URL): string[] =>
			readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
				const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, directory);
				return entry.isDirectory() ? collect(child) : [child.pathname.split("/dist/frontend/")[1]!];
			});
		const emitted = collect(new URL("../dist/frontend/", import.meta.url))
			.map((path) => `dist/frontend/${decodeURIComponent(path)}`)
			.sort();

		expect(manifest.files.map((file) => file.path)).toEqual(emitted);
		expect(new Set(manifest.files.map((file) => file.path)).size).toBe(manifest.files.length);
	});

	test("matches the built dist bytes exactly, including the dist manifest copy", () => {
		// Publishing verifies these hashes against the fetched files; a stale dist would publish
		// old code under a new version.
		for (const file of manifest.files) {
			const bytes = readFileSync(new URL(`../${file.path}`, import.meta.url));
			expect(file.bytes).toBe(bytes.byteLength);
			expect(file.sha256).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
		}
		const distManifest = readFileSync(new URL("../dist/bonobo.plugin.json", import.meta.url), "utf8");
		const rootManifest = readFileSync(new URL("../bonobo.plugin.json", import.meta.url), "utf8");
		expect(distManifest).toBe(rootManifest);
	});
});
