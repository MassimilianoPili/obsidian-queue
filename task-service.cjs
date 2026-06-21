#!/usr/bin/env node
// Servizio off-process del plugin "Agent Queue": possiede il file .db (node:sqlite) e implementa
// la macchina a stati dei task degli agenti + una coda stile honker (claim = UPDATE...RETURNING
// con visibility timeout) tutta in SQL.
//
// TUTTO è configurabile da un queue.config.json (stati, transizioni, stato iniziale/claimable/
// dispatched/terminale/approval/success/failure, tipi worker, etichette, default). Il path della
// config è passato come 3° argomento (argv[3]); in assenza si usano i DEFAULTS.
//
// Perché off-process: lo SQLite di Obsidian/Electron NON è node:sqlite; serve il system node ≥22.5.
// Protocollo: JSON-lines su stdin/stdout. {id,cmd,args} → {id,ok,result} | {id,ok:false,error}.
// stdout è RISERVATO al protocollo: ogni log va su stderr.

"use strict";

const { DatabaseSync } = require("node:sqlite");
const crypto = require("node:crypto");
const fs = require("node:fs");

// ─── Config di default (sovrascrivibile interamente da queue.config.json) ──────
const DEFAULTS = {
  labels: {
    ribbon: "Agent Queue",
    viewTitle: "Agent Queue",
    columns: [
      { status: "AWAITING_APPROVAL", label: "In approvazione" },
      { status: "WAITING", label: "In coda" },
      { status: "DISPATCHED", label: "In corso" },
      { status: "DONE", label: "Completati" },
      { status: "FAILED", label: "Falliti" },
      { status: "DEAD_LETTER", label: "Dead-letter" },
    ],
  },
  stateMachine: {
    initial: "WAITING",
    approvalState: "AWAITING_APPROVAL",
    claimableState: "WAITING",
    dispatchedState: "DISPATCHED",
    successState: "DONE",
    failureState: "FAILED",
    deadLetterState: "DEAD_LETTER", // tentativi esauriti → terminale, redrive manuale
    terminalStates: ["DONE", "FAILED", "DEAD_LETTER"],
    transitions: {
      WAITING: ["DISPATCHED"],
      DISPATCHED: ["DONE", "WAITING", "FAILED", "DEAD_LETTER"], // WAITING = auto-retry con backoff
      AWAITING_APPROVAL: ["WAITING", "FAILED"],
      FAILED: ["WAITING"], // retry manuale
      DEAD_LETTER: ["WAITING"], // redrive manuale
      DONE: [],
    },
  },
  planStates: { pending: "PENDING", running: "RUNNING", completed: "COMPLETED", failed: "FAILED", paused: "PAUSED" },
  workerTypes: ["BE", "FE", "AI_TASK", "CONTRACT", "REVIEW", "CONTEXT_MANAGER", "SCHEMA_MANAGER", "HOOK_MANAGER"],
  // ordine con cui claimNext sceglie il prossimo task pronto (campi da allowlist, dir ASC|DESC)
  ordering: [
    { field: "priority", dir: "ASC" },
    { field: "ordinal", dir: "ASC" },
  ],
  defaults: {
    visibilityTimeoutS: 300, // lease del claim
    priority: 5,
    maxAttempts: 3,
    retryBaseS: 5, // backoff esponenziale: base * 2^(attempt-1)
    retryCapS: 600, // cap del backoff
    retryJitterFrac: 0.25, // jitter ∈ [1-frac, 1] (mai negativo)
    enforceLease: true, // fencing: complete/heartbeat richiedono il lease_id del claim
    reaperIntervalS: 5, // ogni quanto il servizio fa lo sweep dei DISPATCHED scaduti
  },
};

// campi ammessi nell'ORDER BY (no input grezzo in SQL)
const ORDER_FIELDS = new Set(["priority", "ordinal", "created_at", "updated_at", "attempts", "task_key"]);
function buildOrderBy(ordering) {
  const parts = (ordering || [])
    .filter((o) => o && ORDER_FIELDS.has(o.field))
    .map((o) => `${o.field} ${String(o.dir).toUpperCase() === "DESC" ? "DESC" : "ASC"}`);
  return "ORDER BY " + (parts.length ? parts.join(", ") : "priority ASC, ordinal ASC");
}

function isObj(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(base, over) {
  if (!isObj(over)) return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}
// i nomi di stato finiscono in un indice SQL: validali (defense-in-depth)
const STATE_RE = /^[A-Z_][A-Z0-9_]*$/;
function assertState(s, where) {
  if (typeof s !== "string" || !STATE_RE.test(s)) throw new Error(`stato non valido (${where}): ${JSON.stringify(s)}`);
  return s;
}
function validateConfig(c) {
  const sm = c.stateMachine;
  ["initial", "approvalState", "claimableState", "dispatchedState", "successState", "failureState"].forEach((k) =>
    assertState(sm[k], `stateMachine.${k}`),
  );
  if (sm.deadLetterState) assertState(sm.deadLetterState, "stateMachine.deadLetterState");
  (sm.terminalStates || []).forEach((s) => assertState(s, "terminalStates"));
  for (const [from, tos] of Object.entries(sm.transitions || {})) {
    assertState(from, "transitions.from");
    (tos || []).forEach((t) => assertState(t, `transitions[${from}]`));
  }
  Object.values(c.planStates || {}).forEach((s) => assertState(s, "planStates"));
  return c;
}
function loadConfig(p) {
  if (!p) return DEFAULTS;
  try {
    return validateConfig(deepMerge(DEFAULTS, JSON.parse(fs.readFileSync(p, "utf8"))));
  } catch (e) {
    process.stderr.write(`[task-service] config non valida (${p}): ${e.message} — uso i default\n`);
    return DEFAULTS;
  }
}

function now() {
  return Math.floor(Date.now() / 1000);
}
function uuid() {
  return crypto.randomUUID();
}
function str(v, max = 2000) {
  if (v == null) return "";
  return String(v).slice(0, max);
}
function intIn(v, def, lo, hi) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
function mermaidLabel(v) {
  return str(v, 80).replace(/["\[\]{}()<>|]/g, " ").replace(/\s+/g, " ").trim();
}
function mermaidId(v) {
  return str(v, 40).replace(/[^A-Za-z0-9_]/g, "_") || "n";
}
// backoff esponenziale con jitter non-negativo: delay = min(base*2^(att-1), cap), poi *[1-frac, 1]
function backoffSeconds(attempt, d) {
  const base = d.retryBaseS ?? 5;
  const cap = d.retryCapS ?? 600;
  const frac = d.retryJitterFrac ?? 0.25;
  const delay = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jittered = delay * (1 - frac * Math.random()); // ∈ (delay*(1-frac), delay], mai nel passato
  return Math.max(1, Math.round(jittered));
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
  next_eligible_at INTEGER,
  lease_id TEXT,
  review_score REAL,
  process_score REAL,
  aggregated_reward REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_plan ON plan_items(plan_id);
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

function createStore(dbPath, config = DEFAULTS) {
  const SM = config.stateMachine;
  const PS = config.planStates;
  const TRANSITIONS = SM.transitions;
  const TERMINAL = new Set(SM.terminalStates);
  const visibilityTimeoutS = config.defaults.visibilityTimeoutS;
  const dflt = config.defaults;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  // migration idempotente per DB pre-esistenti: aggiungi le colonne nuove se mancano
  {
    const cols = new Set(db.prepare("PRAGMA table_info(plan_items)").all().map((c) => c.name));
    if (!cols.has("next_eligible_at")) db.exec("ALTER TABLE plan_items ADD COLUMN next_eligible_at INTEGER");
    if (!cols.has("lease_id")) db.exec("ALTER TABLE plan_items ADD COLUMN lease_id TEXT");
  }
  // indice parziale sugli item claimabili: il nome stato è validato (STATE_RE) → safe nell'SQL
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_items_claimable ON plan_items(plan_id, priority, ordinal) WHERE status = '${SM.claimableState}';`,
  );

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

  function depsSatisfied(planId, taskKey) {
    const deps = db.prepare("SELECT depends_on FROM plan_item_deps WHERE plan_id=? AND task_key=?").all(planId, taskKey);
    if (deps.length === 0) return true;
    for (const d of deps) {
      const row = db.prepare("SELECT status FROM plan_items WHERE plan_id=? AND task_key=?").get(planId, d.depends_on);
      if (!row || row.status !== SM.successState) return false;
    }
    return true;
  }

  const UPDATABLE = new Set([
    "worker", "attempts", "claim_expires_at", "next_eligible_at", "lease_id", "result", "error", "process_score",
  ]);
  function setItemStatus(item, next, extra = {}) {
    const allowed = TRANSITIONS[item.status] || [];
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

  function checkPlanCompletion(planId) {
    const items = stmt.itemsByPlan.all(planId);
    if (items.length === 0) return;
    if (!items.every((i) => TERMINAL.has(i.status))) return;
    // un task FAILED o DEAD_LETTER rende il piano FAILED
    const failed = items.filter((i) => i.status === SM.failureState || i.status === SM.deadLetterState).length;
    const status = failed > 0 ? PS.failed : PS.completed;
    stmt.setPlanStatus.run(status, now(), planId);
    emit(planId, null, "PLAN_COMPLETED", { status, itemCount: items.length, failedCount: failed });
  }

  const api = {
    config() {
      return config;
    },

    createPlan({ spec = "", tasks = [] }) {
      const planId = uuid();
      db.exec("BEGIN");
      try {
        stmt.insPlan.run(planId, str(spec, 20000), PS.pending, now());
        tasks.forEach((t, idx) => {
          const status = t.requireApproval ? SM.approvalState : SM.initial;
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
            intIn(t.priority, dflt.priority, 1, 10),
            t.requireApproval ? 1 : 0,
            intIn(t.maxAttempts, dflt.maxAttempts, 1, 100),
            now(),
            now(),
          );
          for (const dep of t.dependsOn ?? []) stmt.insDep.run(planId, taskKey, str(dep, 40));
        });
        stmt.setPlanStatus.run(PS.running, null, planId);
        emit(planId, null, "PLAN_STARTED", { spec: str(spec, 500), itemCount: tasks.length });
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

    claimNext({ worker, planId } = {}) {
      api.sweepExpired();
      const t = now();
      // claimabile = stato claimable E backoff scaduto (next_eligible_at nullo o passato)
      let sql = "SELECT * FROM plan_items WHERE status=? AND (next_eligible_at IS NULL OR next_eligible_at <= ?)";
      const vals = [SM.claimableState, t];
      if (planId) (sql += " AND plan_id=?"), vals.push(planId);
      sql += " " + buildOrderBy(config.ordering);
      const candidates = db.prepare(sql).all(...vals);
      for (const item of candidates) {
        if (!depsSatisfied(item.plan_id, item.task_key)) continue;
        const leaseId = uuid(); // fencing token: lo restituiamo, complete/heartbeat devono combaciare
        setItemStatus(item, SM.dispatchedState, {
          worker: worker ?? null,
          attempts: item.attempts + 1,
          claim_expires_at: t + visibilityTimeoutS,
          next_eligible_at: null,
          lease_id: leaseId,
        });
        emit(item.plan_id, item.id, "TASK_DISPATCHED", { taskKey: item.task_key, worker });
        return stmt.getItem.get(item.id);
      }
      return null;
    },

    complete({ itemId, status, result, leaseId }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      if (TERMINAL.has(item.status)) return stmt.getItem.get(itemId); // idempotency guard
      // fencing: un worker il cui lease è scaduto (task ripreso da altri) non può chiudere il dispatch
      if (dflt.enforceLease && item.lease_id && leaseId !== item.lease_id) {
        throw new Error(`lease non valido per ${item.task_key}: dispatch ripreso (worker stantio)`);
      }
      const DLQ = SM.deadLetterState || SM.failureState;
      const ok = status === "success" || status === true;
      if (ok) {
        setItemStatus(item, SM.successState, {
          result: str(JSON.stringify(result ?? null), 100000),
          error: null,
          process_score: Math.max(0, 1 - 0.25 * (item.attempts - 1)),
          claim_expires_at: null,
          next_eligible_at: null,
          lease_id: null,
        });
        emit(item.plan_id, item.id, "TASK_COMPLETED", { taskKey: item.task_key, status: SM.successState });
      } else if (item.attempts < item.max_attempts) {
        // auto-retry: torna claimable dopo backoff esponenziale + jitter
        const delay = backoffSeconds(item.attempts, dflt);
        setItemStatus(item, SM.claimableState, {
          error: str(result ?? "failed", 2000),
          claim_expires_at: null,
          lease_id: null,
          next_eligible_at: now() + delay,
        });
        emit(item.plan_id, item.id, "TASK_RETRY_SCHEDULED", {
          taskKey: item.task_key,
          attempt: item.attempts,
          maxAttempts: item.max_attempts,
          retryInS: delay,
        });
      } else {
        // tentativi esauriti → dead-letter (terminale, redrive manuale)
        setItemStatus(item, DLQ, {
          error: str(result ?? "failed", 2000),
          process_score: 0,
          claim_expires_at: null,
          lease_id: null,
          next_eligible_at: null,
        });
        emit(item.plan_id, item.id, "TASK_DEAD_LETTERED", { taskKey: item.task_key, attempts: item.attempts });
      }
      checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    retry({ itemId }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      // redrive manuale (da FAILED o DEAD_LETTER): tentativi azzerati, subito claimabile
      setItemStatus(item, SM.claimableState, {
        error: null,
        attempts: 0,
        claim_expires_at: null,
        next_eligible_at: null,
        lease_id: null,
      });
      emit(item.plan_id, item.id, "TASK_RETRIED", { taskKey: item.task_key });
      const plan = stmt.getPlan.get(item.plan_id);
      if (plan && (plan.status === PS.failed || plan.status === PS.completed)) {
        stmt.setPlanStatus.run(PS.running, null, item.plan_id);
      }
      return stmt.getItem.get(itemId);
    },

    approve({ itemId }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, SM.initial);
      emit(item.plan_id, item.id, "TASK_APPROVED", { taskKey: item.task_key });
      return stmt.getItem.get(itemId);
    },

    reject({ itemId, reason }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, SM.failureState, { error: str(reason ?? "rejected", 2000) });
      emit(item.plan_id, item.id, "TASK_REJECTED", { taskKey: item.task_key, reason: str(reason, 2000) });
      checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    // reaper: i DISPATCHED con lease scaduto (worker morto) tornano in coda con backoff, o vanno in dead-letter
    sweepExpired() {
      const t = now();
      const DLQ = SM.deadLetterState || SM.failureState;
      const expired = db
        .prepare("SELECT * FROM plan_items WHERE status=? AND claim_expires_at IS NOT NULL AND claim_expires_at < ?")
        .all(SM.dispatchedState, t);
      for (const item of expired) {
        if (item.attempts >= item.max_attempts) {
          setItemStatus(item, DLQ, {
            error: "visibility timeout: tentativi esauriti",
            process_score: 0,
            claim_expires_at: null,
            lease_id: null,
          });
          emit(item.plan_id, item.id, "TASK_DEAD_LETTERED", { taskKey: item.task_key, reason: "timeout" });
          checkPlanCompletion(item.plan_id);
        } else {
          const delay = backoffSeconds(item.attempts, dflt);
          setItemStatus(item, SM.claimableState, {
            claim_expires_at: null,
            lease_id: null,
            next_eligible_at: t + delay,
          });
          emit(item.plan_id, item.id, "TASK_REQUEUED", { taskKey: item.task_key, reason: "timeout", retryInS: delay });
        }
      }
      return expired.length;
    },

    // estende il lease di un task in corso (per task lunghi); richiede il lease_id del claim
    heartbeat({ itemId, leaseId }) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      if (item.status !== SM.dispatchedState) throw new Error(`heartbeat su task non in corso (${item.status})`);
      if (dflt.enforceLease && item.lease_id && leaseId !== item.lease_id) {
        throw new Error(`lease non valido per ${item.task_key}`);
      }
      // non è un cambio di stato: aggiorno solo il deadline del lease
      db.prepare("UPDATE plan_items SET claim_expires_at=?, updated_at=? WHERE id=?").run(now() + visibilityTimeoutS, now(), item.id);
      return stmt.getItem.get(itemId);
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

module.exports = { createStore, loadConfig, DEFAULTS };

// ─── Loop JSON-lines (solo se eseguito direttamente) ──────────────────────────
if (require.main === module) {
  const dbPath = process.argv[2] || process.env.TASKS_DB || "tasks.db";
  const configPath = process.argv[3] || process.env.TASKS_CONFIG || "";
  const cfg = loadConfig(configPath);
  const store = createStore(dbPath, cfg);
  const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  process.stderr.write(`[task-service] db=${dbPath} config=${configPath || "(default)"}\n`);

  // reaper periodico: requeue/dead-letter dei DISPATCHED con lease scaduto (worker morti)
  const reaperS = (cfg.defaults && cfg.defaults.reaperIntervalS) || 5;
  const reaper = setInterval(() => {
    try {
      const n = store.sweepExpired();
      if (n) process.stderr.write(`[task-service] reaper: ${n} task scaduti gestiti\n`);
    } catch (e) {
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
