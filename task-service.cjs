#!/usr/bin/env node
// Servizio off-process del plugin "Agent Tasks": possiede il file .db (node:sqlite) e implementa
// la macchina a stati dei task degli agenti (replica dell'agent-framework su SOL) + una coda
// stile honker (claim = UPDATE...RETURNING con visibility timeout) tutta in SQL.
//
// Perché off-process: lo SQLite di Obsidian/Electron NON è node:sqlite; serve il system node ≥22.5.
// Protocollo: JSON-lines su stdin/stdout. Una riga in = una richiesta {id,cmd,args}; una riga out =
// {id, ok, result} oppure {id, ok:false, error}. All'avvio emette {type:"ready"}. stdout è RISERVATO
// al protocollo: ogni log va su stderr (l'ExperimentalWarning di node:sqlite finisce già su stderr).

"use strict";

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");

// ─── Stati e transizioni ──────────────────────────────────────────────────────
const PlanStatus = { PENDING: "PENDING", RUNNING: "RUNNING", COMPLETED: "COMPLETED", FAILED: "FAILED", PAUSED: "PAUSED" };
const ItemStatus = {
  WAITING: "WAITING",
  DISPATCHED: "DISPATCHED",
  DONE: "DONE",
  FAILED: "FAILED",
  AWAITING_APPROVAL: "AWAITING_APPROVAL",
};

// transizioni LEGITTIME per gli item (qualsiasi altra → errore)
const ITEM_TRANSITIONS = {
  WAITING: ["DISPATCHED"],
  DISPATCHED: ["DONE", "FAILED", "WAITING"], // WAITING = requeue (visibility scaduta)
  AWAITING_APPROVAL: ["WAITING", "FAILED"],
  FAILED: ["WAITING"], // retry
  DONE: [],
};
const TERMINAL = new Set([ItemStatus.DONE, ItemStatus.FAILED]);

function now() {
  return Math.floor(Date.now() / 1000);
}
function uuid() {
  return crypto.randomUUID();
}
// sanificazione input: forza stringa e cap di lunghezza (evita payload abnormi)
function str(v, max = 2000) {
  if (v == null) return "";
  return String(v).slice(0, max);
}
function intIn(v, def, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
// label sicura per il testo mermaid (no virgolette/parentesi/newline che romperebbero il diagramma)
function mermaidLabel(v) {
  return str(v, 80).replace(/["\[\]{}()<>|]/g, " ").replace(/\s+/g, " ").trim();
}
// id nodo mermaid sicuro: solo alfanumerico e underscore
function mermaidId(v) {
  return str(v, 40).replace(/[^A-Za-z0-9_]/g, "_") || "n";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  spec TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE TABLE IF NOT EXISTS plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  worker_type TEXT,
  worker_profile TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  require_approval INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  worker TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claim_expires_at INTEGER,
  review_score REAL,
  process_score REAL,
  aggregated_reward REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_plan ON plan_items(plan_id);
-- indice parziale stile honker: solo gli item "in coda" (claimabili)
CREATE INDEX IF NOT EXISTS idx_items_waiting ON plan_items(plan_id, priority, ordinal) WHERE status = 'WAITING';
CREATE TABLE IF NOT EXISTS plan_item_deps (
  plan_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (plan_id, task_key, depends_on)
);
CREATE TABLE IF NOT EXISTS plan_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  item_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_plan ON plan_event(plan_id, seq);
`;

function createStore(dbPath, opts = {}) {
  const visibilityTimeoutS = opts.visibilityTimeoutS ?? 300;
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const stmt = {
    insPlan: db.prepare("INSERT INTO plans (id, spec, status, created_at) VALUES (?,?,?,?)"),
    setPlanStatus: db.prepare("UPDATE plans SET status=?, completed_at=? WHERE id=?"),
    getPlan: db.prepare("SELECT * FROM plans WHERE id=?"),
    insItem: db.prepare(
      `INSERT INTO plan_items
       (id, plan_id, task_key, ordinal, title, description, worker_type, worker_profile,
        status, priority, require_approval, max_attempts, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    insDep: db.prepare("INSERT OR IGNORE INTO plan_item_deps (plan_id, task_key, depends_on) VALUES (?,?,?)"),
    getItem: db.prepare("SELECT * FROM plan_items WHERE id=?"),
    itemsByPlan: db.prepare("SELECT * FROM plan_items WHERE plan_id=? ORDER BY ordinal"),
    depsByPlan: db.prepare("SELECT task_key, depends_on FROM plan_item_deps WHERE plan_id=?"),
    insEvent: db.prepare("INSERT INTO plan_event (plan_id, item_id, type, payload, occurred_at) VALUES (?,?,?,?,?)"),
    eventsSince: db.prepare("SELECT * FROM plan_event WHERE plan_id=? AND seq>? ORDER BY seq"),
  };

  function emit(planId, itemId, type, payload) {
    stmt.insEvent.run(planId, itemId ?? null, type, payload ? JSON.stringify(payload) : null, now());
  }

  // tutte le dipendenze (task_key) dell'item sono DONE?
  function depsSatisfied(planId, taskKey) {
    const deps = db.prepare("SELECT depends_on FROM plan_item_deps WHERE plan_id=? AND task_key=?").all(planId, taskKey);
    if (deps.length === 0) return true;
    for (const d of deps) {
      const row = db.prepare("SELECT status FROM plan_items WHERE plan_id=? AND task_key=?").get(planId, d.depends_on);
      if (!row || row.status !== ItemStatus.DONE) return false;
    }
    return true;
  }

  // colonne aggiornabili da setItemStatus: allowlist (i nomi colonna finiscono in SQL, mai input utente)
  const UPDATABLE = new Set(["worker", "attempts", "claim_expires_at", "result", "error", "process_score"]);

  function setItemStatus(item, next, extra = {}) {
    const allowed = ITEM_TRANSITIONS[item.status] || [];
    if (!allowed.includes(next)) {
      throw new Error(`transizione illegale ${item.task_key}: ${item.status} → ${next}`);
    }
    const cols = ["status=?", "updated_at=?"];
    const vals = [next, now()];
    for (const [k, v] of Object.entries(extra)) {
      if (!UPDATABLE.has(k)) throw new Error(`colonna non aggiornabile: ${k}`);
      cols.push(`${k}=?`);
      vals.push(v);
    }
    vals.push(item.id);
    db.prepare(`UPDATE plan_items SET ${cols.join(", ")} WHERE id=?`).run(...vals);
  }

  // se tutti gli item sono terminali → chiudi il piano (FAILED se almeno uno FAILED, altrimenti COMPLETED)
  function checkPlanCompletion(planId) {
    const items = stmt.itemsByPlan.all(planId);
    if (items.length === 0) return;
    const allTerminal = items.every((i) => TERMINAL.has(i.status));
    if (!allTerminal) return;
    const failed = items.filter((i) => i.status === ItemStatus.FAILED).length;
    const status = failed > 0 ? PlanStatus.FAILED : PlanStatus.COMPLETED;
    stmt.setPlanStatus.run(status, now(), planId);
    emit(planId, null, "PLAN_COMPLETED", { status, itemCount: items.length, failedCount: failed });
  }

  const api = {
    createPlan({ spec = "", tasks = [] }) {
      const planId = uuid();
      db.exec("BEGIN");
      try {
        stmt.insPlan.run(planId, spec, PlanStatus.PENDING, now());
        tasks.forEach((t, idx) => {
          const status = t.requireApproval ? ItemStatus.AWAITING_APPROVAL : ItemStatus.WAITING;
          const taskKey = str(t.taskKey, 40) || `T-${String(idx + 1).padStart(3, "0")}`;
          stmt.insItem.run(
            uuid(),
            planId,
            taskKey,
            intIn(t.ordinal, idx, 0, 1e6),
            str(t.title, 500),
            str(t.description, 20000),
            t.workerType ? str(t.workerType, 50) : null,
            t.workerProfile ? str(t.workerProfile, 50) : null,
            status,
            intIn(t.priority, 5, 1, 10),
            t.requireApproval ? 1 : 0,
            intIn(t.maxAttempts, 3, 1, 100),
            now(),
            now(),
          );
          for (const dep of t.dependsOn ?? []) stmt.insDep.run(planId, taskKey, str(dep, 40));
        });
        stmt.setPlanStatus.run(PlanStatus.RUNNING, null, planId);
        emit(planId, null, "PLAN_STARTED", { spec, itemCount: tasks.length });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return api.getPlan(planId);
    },

    getPlan(arg) {
      const planId = typeof arg === "string" ? arg : arg && arg.planId;
      const plan = stmt.getPlan.get(planId);
      if (!plan) throw new Error(`piano non trovato: ${planId}`);
      plan.items = stmt.itemsByPlan.all(planId);
      return plan;
    },

    listTasks({ planId, status } = {}) {
      let sql = "SELECT * FROM plan_items";
      const where = [];
      const vals = [];
      if (planId) (where.push("plan_id=?"), vals.push(planId));
      if (status) (where.push("status=?"), vals.push(status));
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY plan_id, ordinal";
      return db.prepare(sql).all(...vals);
    },

    // prossimo task pronto (WAITING + deps DONE), priorità poi ordinal → DISPATCHED
    claimNext({ worker, planId } = {}) {
      api.sweepExpired();
      let sql = "SELECT * FROM plan_items WHERE status='WAITING'";
      const vals = [];
      if (planId) (sql += " AND plan_id=?"), vals.push(planId);
      sql += " ORDER BY priority ASC, ordinal ASC";
      const candidates = db.prepare(sql).all(...vals);
      for (const item of candidates) {
        if (!depsSatisfied(item.plan_id, item.task_key)) continue;
        setItemStatus(item, ItemStatus.DISPATCHED, {
          worker: worker ?? null,
          attempts: item.attempts + 1,
          claim_expires_at: now() + visibilityTimeoutS,
        });
        emit(item.plan_id, item.id, "TASK_DISPATCHED", { taskKey: item.task_key, worker });
        return stmt.getItem.get(item.id);
      }
      return null;
    },

    complete({ itemId, status, result }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      if (TERMINAL.has(item.status)) return stmt.getItem.get(itemId); // idempotency guard
      const ok = status === "success" || status === true;
      const next = ok ? ItemStatus.DONE : ItemStatus.FAILED;
      // process score deterministico: 1 al primo tentativo, decresce coi retry
      const processScore = ok ? Math.max(0, 1 - 0.25 * (item.attempts - 1)) : 0;
      setItemStatus(item, next, {
        result: ok ? str(JSON.stringify(result ?? null), 100000) : null,
        error: ok ? null : str(result ?? "failed", 2000),
        process_score: processScore,
        claim_expires_at: null,
      });
      emit(item.plan_id, item.id, ok ? "TASK_COMPLETED" : "TASK_FAILED", { taskKey: item.task_key, status: next });
      checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    retry({ itemId }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, ItemStatus.WAITING, { error: null, claim_expires_at: null });
      emit(item.plan_id, item.id, "TASK_RETRIED", { taskKey: item.task_key });
      // se il piano era FAILED, riportalo RUNNING
      const plan = stmt.getPlan.get(item.plan_id);
      if (plan && (plan.status === PlanStatus.FAILED || plan.status === PlanStatus.COMPLETED)) {
        stmt.setPlanStatus.run(PlanStatus.RUNNING, null, item.plan_id);
      }
      return stmt.getItem.get(itemId);
    },

    approve({ itemId }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, ItemStatus.WAITING);
      emit(item.plan_id, item.id, "TASK_APPROVED", { taskKey: item.task_key });
      return stmt.getItem.get(itemId);
    },

    reject({ itemId, reason }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, ItemStatus.FAILED, { error: str(reason ?? "rejected", 2000) });
      emit(item.plan_id, item.id, "TASK_REJECTED", { taskKey: item.task_key, reason: str(reason, 2000) });
      checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    // requeue dei DISPATCHED con visibility scaduta (worker morto)
    sweepExpired() {
      const t = now();
      const expired = db
        .prepare("SELECT * FROM plan_items WHERE status='DISPATCHED' AND claim_expires_at IS NOT NULL AND claim_expires_at < ?")
        .all(t);
      for (const item of expired) {
        if (item.attempts >= item.max_attempts) {
          setItemStatus(item, ItemStatus.FAILED, { error: "max attempts exceeded (visibility timeout)", claim_expires_at: null });
          emit(item.plan_id, item.id, "TASK_FAILED", { taskKey: item.task_key, reason: "timeout" });
          checkPlanCompletion(item.plan_id);
        } else {
          setItemStatus(item, ItemStatus.WAITING, { claim_expires_at: null });
          emit(item.plan_id, item.id, "TASK_REQUEUED", { taskKey: item.task_key });
        }
      }
      return expired.length;
    },

    eventsSince({ planId, seq = 0 }) {
      return stmt.eventsSince.all(planId, seq);
    },

    graph({ planId, format = "mermaid" }) {
      const items = stmt.itemsByPlan.all(planId);
      const deps = stmt.depsByPlan.all(planId);
      if (format === "json") return { items, deps };
      const lines = ["graph TD"];
      for (const i of items)
        lines.push(`  ${mermaidId(i.task_key)}["${mermaidLabel(i.task_key + ": " + (i.title || "") + " (" + i.status + ")")}"]`);
      for (const d of deps) lines.push(`  ${mermaidId(d.depends_on)} --> ${mermaidId(d.task_key)}`);
      return lines.join("\n");
    },

    health() {
      const tasks = db.prepare("SELECT COUNT(*) AS n FROM plan_items").get().n;
      const plans = db.prepare("SELECT COUNT(*) AS n FROM plans").get().n;
      return { status: "ok", db: dbPath, plans, tasks, ready: true };
    },

    close() {
      db.close();
    },
  };

  return api;
}

module.exports = { createStore, PlanStatus, ItemStatus };

// ─── Loop JSON-lines (solo se eseguito direttamente) ──────────────────────────
if (require.main === module) {
  const dbPath = process.argv[2] || process.env.TASKS_DB || "tasks.db";
  const store = createStore(dbPath);
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  process.stderr.write(`[task-service] db=${dbPath}\n`);
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
      let req;
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
      } catch (e) {
        out({ id, ok: false, error: String((e && e.message) || e) });
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
