import { readFile, writeFile } from "node:fs/promises";

const RELEASE_ASSETS = ["dist/frontend/assets/index.js", "dist/frontend/assets/index.css"];

for (const path of RELEASE_ASSETS) {
	const source = await readFile(path, "utf8");
	const stripped = source.replace(/[\t ]+$/gmu, "");
	if (stripped !== source) {
		// Prettier keeps whitespace-only lines inside some Vite-generated dependency comments.
		await writeFile(path, stripped);
	}
}
