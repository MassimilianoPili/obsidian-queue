import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

// Obsidian fornisce questi a runtime: vanno esternalizzati.
const external = [
  "obsidian", "electron",
  "@codemirror/autocomplete", "@codemirror/collab", "@codemirror/commands",
  "@codemirror/language", "@codemirror/lint", "@codemirror/search",
  "@codemirror/state", "@codemirror/view",
  "@lezer/common", "@lezer/highlight", "@lezer/lr",
  "node:fs", "node:path", "node:os", "node:crypto", "node:http", "node:child_process",
];

const opts = {
  entryPoints: ["src/main.ts"],
  bundle: true,
  external,
  format: "cjs",
  target: "es2020",
  platform: "node",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
};

// NB: task-service.cjs NON va bundlato: è uno script Node plain, eseguito off-process col system
// node (usa node:sqlite integrato). Si spedisce così com'è accanto a main.js.
if (prod) {
  await esbuild.build(opts);
} else {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log("watching main.js…");
}
