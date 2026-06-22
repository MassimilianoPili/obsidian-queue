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

if (prod) {
  await esbuild.build(opts);

  // Bundla task-service.cjs con sql.js + WASM inclusi (fallback per Node < 22.5).
  // .wasm caricato come Buffer via binary loader → nessun file esterno da distribuire.
  // node:sqlite resta external (caricato nativamente se disponibile via try/catch).
  // target es2019: floor SINTATTICO generico, non legato a una versione di Node specifica.
  // Transpila ||= (ES2021), ??/?. (ES2020) e ogni sintassi moderna (incluso sql.js bundlato)
  // a JS che qualsiasi Node moderno-ish capisce. Version-agnostic, non tarato sulla macchina.
  // Fallback = sql.js asm.js (puro JS, niente WASM) → nessun file esterno, gira su ogni Node.
  await esbuild.build({
    entryPoints: ["src/service/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2019",
    outfile: "task-service.cjs",
    external: ["fs", "path", "crypto", "readline", "node:fs", "node:path", "node:crypto", "node:readline", "node:sqlite"],
    logLevel: "info",
    minify: true,
  });
  console.log("task-service.cjs bundlato con sql.js (asm.js, puro JS) incorporato — target es2019.");
} else {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log("watching main.js…");
}
