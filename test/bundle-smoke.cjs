"use strict";
// Smoke del BUNDLE (../task-service.cjs) — assert plain, gira su QUALSIASI Node (anche 14).
// Serve a validare il motore sql.js (asm.js) e la persistenza, dove node:test non arriva.
// Uso: npm run build && node test/bundle-smoke.cjs
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createStore, _initSqlJsFallback, DEFAULTS } = require("../task-service.cjs");

let ok = 0, fail = 0;
function check(cond, msg) {
  if (cond) { ok++; } else { fail++; process.stdout.write(`  ✗ ${msg}\n`); }
}

(async () => {
  await _initSqlJsFallback();

  // 1) end-to-end in memoria
  const s = createStore(":memory:", DEFAULTS);
  const p = s.createPlan({ spec: "smoke", tasks: [
    { taskKey: "A", title: "a", tags: ["gpu"] },
    { taskKey: "B", title: "b", dependsOn: ["A"] },
  ]});
  check(p.items.length === 2, "createPlan: 2 task");
  const c = s.claimNext({ worker: "w", tags: ["gpu"] });
  check(c && c.task_key === "A", "claim con tag → A");
  check(s.claimNext({ worker: "w" }) === null, "B bloccato da dep");
  s.complete({ itemId: c.id, status: "success", leaseId: c.lease_id });
  check(s.claimNext({ worker: "w" }).task_key === "B", "A DONE → B claimabile");
  check(s.query({ sql: "SELECT COUNT(*) AS n FROM plan_items" }).rows[0].n === 2, "query read-only");

  // 2) persistenza su file (lo shim deve scrivere il .db)
  const dbf = path.join(os.tmpdir(), `qsmoke_${Date.now()}.db`);
  const s1 = createStore(dbf, DEFAULTS);
  s1.createPlan({ spec: "persist", tasks: [{ taskKey: "X", title: "x" }] });
  s1.close();
  const s2 = createStore(dbf, DEFAULTS);
  check(s2.health().tasks === 1, "persistenza cross-store (file riletto)");
  s2.close();
  try { fs.unlinkSync(dbf); } catch { /* ignore */ }

  process.stdout.write(`bundle-smoke: ${ok} ok, ${fail} fail\n`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
