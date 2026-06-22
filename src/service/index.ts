#!/usr/bin/env node
// Entry del servizio off-process "Task Queue". Compone i moduli ed espone:
//  - l'API (createStore/loadConfig/DEFAULTS/initSqlJsFallback) per test e import.
//  - il loop JSON-lines su stdin/stdout quando eseguito direttamente (bundle).
// Protocollo: {id,cmd,args} → {id,ok,result} | {id,ok:false,error}. stdout RISERVATO al protocollo.
// Node ≥22.5: node:sqlite nativo. Altrimenti: sql.js asm.js (bundlato). Vedi db.ts.
"use strict";

import { initSqlJsFallback, engineName } from "./db";
import { loadConfig, DEFAULTS } from "./config";
import { createStore } from "./store";

// retro-compat con i nomi storici importati altrove/dai test
const _initSqlJsFallback = initSqlJsFallback;

export { createStore, loadConfig, DEFAULTS, _initSqlJsFallback, initSqlJsFallback };

if (require.main === module) {
  (async () => {
    await initSqlJsFallback();
    const dbPath = process.argv[2] || process.env.TASKS_DB || "tasks.db";
    const configPath = process.argv[3] || process.env.TASKS_CONFIG || "";
    const cfg = loadConfig(configPath);
    const store: any = createStore(dbPath, cfg);
    const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");
    process.stderr.write(`[task-service] db=${dbPath} config=${configPath || "(default)"} engine=${engineName()}\n`);

    const reaperS = (cfg.defaults && cfg.defaults.reaperIntervalS) || 5;
    const reaper = setInterval(() => {
      try {
        const n = store.sweepExpired();
        if (n) process.stderr.write(`[task-service] reaper: ${n} task scaduti gestiti\n`);
      } catch (e: any) {
        process.stderr.write(`[task-service] reaper error: ${(e && e.message) || e}\n`);
      }
    }, reaperS * 1000);
    if (reaper.unref) reaper.unref();

    out({ type: "ready" });

    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let req: any;
        try {
          req = JSON.parse(line);
        } catch {
          out({ ok: false, error: "json non valido" });
          continue;
        }
        const { id, cmd, args } = req;
        try {
          const fn = store[cmd];
          if (typeof fn !== "function") throw new Error(`comando sconosciuto: ${cmd}`);
          const result = fn.call(store, args || {});
          out({ id, ok: true, result });
        } catch (e: any) {
          out({ id, ok: false, error: String((e && e.message) || e) });
        }
      }
    });
    process.stdin.on("end", () => process.exit(0));
  })().catch((e: any) => {
    process.stderr.write(`[task-service] errore fatale: ${(e && e.message) || e}\n`);
    process.exit(1);
  });
}
