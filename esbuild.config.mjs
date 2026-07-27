import esbuild from "esbuild";
import builtins from "builtin-modules";

// Obsidian loads a single file, so everything bundles into main.js at the
// plugin root. `obsidian`, electron and node builtins are supplied by the host
// and must stay external — bundling them yields a plugin that won't load.
const production = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: ["obsidian", "electron", ...builtins],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	minify: production,
	outfile: "main.js",
});

if (production) {
	await context.rebuild();
	process.exit(0);
}
await context.watch();
