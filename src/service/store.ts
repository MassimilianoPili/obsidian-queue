// Store della coda: macchina a stati + coda stile honker (claim = visibility timeout) in SQL.
// Composizione: apre il DB, inizializza schema/migrazioni, espone l'API dei comandi.
// Gli helper di stato (setItemStatus/depsSatisfied/checkPlanCompletion) condividono il closure
// db/stmt/emit: tenerli qui (anziché classi iniettate) evita ceremony a questa scala.
import { openDb } from "./db";
import { initSchema } from "./schema";
import { now, uuid, str, intIn, backoffSeconds, buildOrderBy } from "./util";
import { EV } from "./constants";
import { renderGraph } from "./mermaid";
import { computeMetrics } from "./metrics";
import { DEFAULTS } from "./config";
import type { QueueConfig, Row } from "./types";

export function createStore(dbPath: string, config: QueueConfig = DEFAULTS) {
  const SM = config.stateMachine;
  const PS = config.planStates;
  const TRANSITIONS = SM.transitions;
  const TERMINAL = new Set(SM.terminalStates);
  const visibilityTimeoutS = config.defaults.visibilityTimeoutS;
  const dflt = config.defaults;

  const db = openDb(dbPath);
  initSchema(db, SM.claimableState);

  const stmt = {
    insPlan: db.prepare("INSERT INTO plans (id, spec, status, created_at, idempotency_key, budget_max_dispatches) VALUES (?,?,?,?,?,?)"),
    setPlanStatus: db.prepare("UPDATE plans SET status=?, completed_at=? WHERE id=?"),
    getPlan: db.prepare("SELECT * FROM plans WHERE id=?"),
    insItem: db.prepare(
      `INSERT INTO plan_items
       (id, plan_id, task_key, ordinal, title, description, worker_type, worker_profile,
        status, priority, require_approval, max_attempts, tags, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ),
    insDep: db.prepare("INSERT OR IGNORE INTO plan_item_deps (plan_id, task_key, depends_on) VALUES (?,?,?)"),
    getItem: db.prepare("SELECT * FROM plan_items WHERE id=?"),
    itemsByPlan: db.prepare("SELECT * FROM plan_items WHERE plan_id=? ORDER BY ordinal"),
    depsByPlan: db.prepare("SELECT task_key, depends_on FROM plan_item_deps WHERE plan_id=?"),
    insEvent: db.prepare("INSERT INTO plan_event (plan_id, item_id, type, payload, occurred_at) VALUES (?,?,?,?,?)"),
    eventsSince: db.prepare("SELECT * FROM plan_event WHERE plan_id=? AND seq>? ORDER BY seq"),
  };

  function emit(planId: string, itemId: string | null, type: string, payload?: any) {
    stmt.insEvent.run(planId, itemId ?? null, type, payload ? JSON.stringify(payload) : null, now());
  }

  function depsSatisfied(planId: string, taskKey: string): boolean {
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
  function setItemStatus(item: Row, next: string, extra: Record<string, any> = {}) {
    const allowed = TRANSITIONS[item.status] || [];
    if (!allowed.includes(next)) {
      throw new Error(`transizione illegale ${item.task_key}: ${item.status} → ${next}`);
    }
    const cols = ["status=?", "updated_at=?"];
    const vals: any[] = [next, now()];
    for (const [k, v] of Object.entries(extra)) {
      if (!UPDATABLE.has(k)) throw new Error(`colonna non aggiornabile: ${k}`);
      cols.push(`${k}=?`);
      vals.push(v);
    }
    vals.push(item.id);
    db.prepare(`UPDATE plan_items SET ${cols.join(", ")} WHERE id=?`).run(...vals);
  }

  function checkPlanCompletion(planId: string) {
    const items = stmt.itemsByPlan.all(planId);
    if (items.length === 0) return;
    if (!items.every((i: Row) => TERMINAL.has(i.status))) return;
    const failed = items.filter((i: Row) => i.status === SM.failureState || i.status === SM.deadLetterState).length;
    const status = failed > 0 ? PS.failed : PS.completed;
    stmt.setPlanStatus.run(status, now(), planId);
    emit(planId, null, EV.PLAN_COMPLETED, { status, itemCount: items.length, failedCount: failed });
  }

  const api = {
    config() {
      return config;
    },

    createPlan({ spec = "", tasks = [], idempotencyKey, budget }: any = {}) {
      if (idempotencyKey) {
        const existing = db.prepare("SELECT id FROM plans WHERE idempotency_key=?").get(idempotencyKey);
        if (existing) return api.getPlan(existing.id);
      }
      const planId = uuid();
      const budgetMax = budget && budget.maxDispatches > 0 ? budget.maxDispatches : null;
      db.exec("BEGIN");
      try {
        stmt.insPlan.run(planId, str(spec, 20000), PS.pending, now(), idempotencyKey ?? null, budgetMax);
        (tasks as any[]).forEach((t, idx) => {
          const status = t.requireApproval ? SM.approvalState : SM.initial;
          const taskKey = str(t.taskKey, 40) || `T-${String(idx + 1).padStart(3, "0")}`;
          const tagsJson = Array.isArray(t.tags) && t.tags.length ? JSON.stringify(t.tags.map(String)) : null;
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
            tagsJson,
            now(),
            now(),
          );
          for (const dep of t.dependsOn ?? []) stmt.insDep.run(planId, taskKey, str(dep, 40));
        });
        stmt.setPlanStatus.run(PS.running, null, planId);
        emit(planId, null, EV.PLAN_STARTED, { spec: str(spec, 500), itemCount: (tasks as any[]).length });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return api.getPlan(planId);
    },

    getPlan(arg: any) {
      const planId = typeof arg === "string" ? arg : arg && arg.planId;
      const plan = stmt.getPlan.get(planId);
      if (!plan) throw new Error(`piano non trovato: ${planId}`);
      plan.items = stmt.itemsByPlan.all(planId);
      return plan;
    },

    listTasks({ planId, status }: any = {}) {
      let sql = "SELECT * FROM plan_items";
      const where: string[] = [];
      const vals: any[] = [];
      if (planId) (where.push("plan_id=?"), vals.push(planId));
      if (status) (where.push("status=?"), vals.push(status));
      if (where.length) sql += " WHERE " + where.join(" AND ");
      sql += " ORDER BY plan_id, ordinal";
      return db.prepare(sql).all(...vals);
    },

    // query SQL read-only per ispezione/verifica (board, CLI). Solo una SELECT/WITH, niente write/DDL.
    query({ sql, limit }: any = {}) {
      const q = String(sql || "").trim().replace(/;\s*$/, "");
      if (!/^(select|with)\b/i.test(q)) throw new Error("solo SELECT/WITH consentito (read-only)");
      if (q.includes(";")) throw new Error("una sola istruzione consentita (niente ';')");
      const cap = intIn(limit, 200, 1, 5000);
      const all = db.prepare(q).all();
      const rows = all.slice(0, cap);
      const columns = rows.length ? Object.keys(rows[0]) : [];
      return { columns, rows, count: rows.length, truncated: all.length > cap };
    },

    // edit dei metadati di un task (NON lo stato: quello passa per la macchina a stati).
    updateTask({ itemId, title, description, priority, tags, maxAttempts, workerType }: any = {}) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      const sets: string[] = [];
      const vals: any[] = [];
      const changed: string[] = [];
      if (title !== undefined) { sets.push("title=?"); vals.push(str(title, 500)); changed.push("title"); }
      if (description !== undefined) { sets.push("description=?"); vals.push(str(description, 20000)); changed.push("description"); }
      if (priority !== undefined) { sets.push("priority=?"); vals.push(intIn(priority, item.priority, 1, 10)); changed.push("priority"); }
      if (maxAttempts !== undefined) { sets.push("max_attempts=?"); vals.push(intIn(maxAttempts, item.max_attempts, 1, 100)); changed.push("max_attempts"); }
      if (workerType !== undefined) { sets.push("worker_type=?"); vals.push(workerType ? str(workerType, 50) : null); changed.push("worker_type"); }
      if (tags !== undefined) {
        const tg = Array.isArray(tags) && tags.length ? JSON.stringify(tags.map(String)) : null;
        sets.push("tags=?"); vals.push(tg); changed.push("tags");
      }
      if (!sets.length) return item;
      sets.push("updated_at=?"); vals.push(now());
      vals.push(itemId);
      db.prepare(`UPDATE plan_items SET ${sets.join(", ")} WHERE id=?`).run(...vals);
      emit(item.plan_id, item.id, EV.TASK_UPDATED, { taskKey: item.task_key, fields: changed });
      return stmt.getItem.get(itemId);
    },

    // spostamento manuale di stato: consentito SOLO se è una transizione legale (config-driven).
    moveTask({ itemId, to }: any = {}) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      const allowed = TRANSITIONS[item.status] || [];
      if (!allowed.includes(to)) throw new Error(`transizione illegale: ${item.status} → ${to}`);
      const extra: Record<string, any> = { claim_expires_at: null, lease_id: null, next_eligible_at: null };
      if (to === SM.dispatchedState) {
        extra.worker = item.worker || "(manuale)";
        extra.attempts = item.attempts + 1;
        extra.claim_expires_at = now() + visibilityTimeoutS;
        extra.lease_id = uuid();
      } else if (to === SM.successState) {
        extra.error = null;
      } else if (to === SM.failureState || to === SM.deadLetterState) {
        extra.error = item.error || "spostato manualmente";
      }
      setItemStatus(item, to, extra);
      emit(item.plan_id, item.id, EV.TASK_MOVED, { taskKey: item.task_key, from: item.status, to });
      if (TERMINAL.has(to)) checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    // elimina un task; rimuove anche gli archi del DAG che lo referenziano → i dipendenti non restano bloccati.
    deleteTask({ itemId }: any = {}) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM plan_item_deps WHERE plan_id=? AND (task_key=? OR depends_on=?)").run(
          item.plan_id, item.task_key, item.task_key,
        );
        db.prepare("DELETE FROM plan_items WHERE id=?").run(itemId);
        emit(item.plan_id, item.id, EV.TASK_DELETED, { taskKey: item.task_key });
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      checkPlanCompletion(item.plan_id);
      return { deleted: true, itemId, taskKey: item.task_key };
    },

    claimNext({ worker, planId, tags }: any = {}) {
      api.sweepExpired();
      const t = now();
      const workerTags = Array.isArray(tags) ? new Set(tags) : null;

      // WIP limit: blocca se già abbastanza task in corso
      if (dflt.maxWip > 0) {
        const wip = db.prepare("SELECT COUNT(*) AS n FROM plan_items WHERE status=?").get(SM.dispatchedState).n;
        if (wip >= dflt.maxWip) return null;
      }

      let sql =
        "SELECT pi.* FROM plan_items pi JOIN plans pl ON pl.id = pi.plan_id WHERE pi.status=? AND pl.status != ? AND (pi.next_eligible_at IS NULL OR pi.next_eligible_at <= ?)";
      const vals: any[] = [SM.claimableState, PS.paused, t];
      if (planId) (sql += " AND pi.plan_id=?"), vals.push(planId);

      // aging: effective priority = priority - floor(age / agingIntervalS)
      const agingS = dflt.agingIntervalS || 0;
      if (agingS > 0) {
        sql += ` ORDER BY (pi.priority - (${t} - pi.created_at) / ${agingS}) ASC, pi.ordinal ASC`;
      } else {
        const ob = buildOrderBy(config.ordering);
        sql += " " + ob.replace(/ORDER BY /, "ORDER BY pi.").replace(/, /g, ", pi.");
      }

      const candidates = db.prepare(sql).all(...vals);
      for (const item of candidates) {
        // tag-routing: task con tags richiede che il worker offra tutti i tag
        if (item.tags) {
          try {
            const required = JSON.parse(item.tags);
            if (required.length > 0) {
              if (!workerTags) continue;
              if (!required.every((tag: string) => workerTags.has(tag))) continue;
            }
          } catch {
            /* tag malformati: skip routing, consenti claim */
          }
        }
        if (!depsSatisfied(item.plan_id, item.task_key)) continue;

        // budget: incrementa dispatch_count e pausa il piano se esaurito
        const plan = stmt.getPlan.get(item.plan_id);
        if (plan && plan.budget_max_dispatches != null) {
          if ((plan.dispatch_count ?? 0) >= plan.budget_max_dispatches) {
            stmt.setPlanStatus.run(PS.paused, null, item.plan_id);
            emit(item.plan_id, null, EV.PLAN_PAUSED_BUDGET, { budget: plan.budget_max_dispatches });
            continue;
          }
          db.prepare("UPDATE plans SET dispatch_count = dispatch_count + 1 WHERE id=?").run(item.plan_id);
        }

        const leaseId = uuid();
        setItemStatus(item, SM.dispatchedState, {
          worker: worker ?? null,
          attempts: item.attempts + 1,
          claim_expires_at: t + visibilityTimeoutS,
          next_eligible_at: null,
          lease_id: leaseId,
        });
        emit(item.plan_id, item.id, EV.TASK_DISPATCHED, { taskKey: item.task_key, worker });
        return stmt.getItem.get(item.id);
      }
      return null;
    },

    complete({ itemId, status, result, leaseId }: any) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      if (TERMINAL.has(item.status)) return stmt.getItem.get(itemId);
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
        emit(item.plan_id, item.id, EV.TASK_COMPLETED, { taskKey: item.task_key, status: SM.successState });
      } else if (item.attempts < item.max_attempts) {
        const delay = backoffSeconds(item.attempts, dflt);
        setItemStatus(item, SM.claimableState, {
          error: str(result ?? "failed", 2000),
          claim_expires_at: null,
          lease_id: null,
          next_eligible_at: now() + delay,
        });
        emit(item.plan_id, item.id, EV.TASK_RETRY_SCHEDULED, {
          taskKey: item.task_key,
          attempt: item.attempts,
          maxAttempts: item.max_attempts,
          retryInS: delay,
        });
      } else {
        setItemStatus(item, DLQ, {
          error: str(result ?? "failed", 2000),
          process_score: 0,
          claim_expires_at: null,
          lease_id: null,
          next_eligible_at: null,
        });
        emit(item.plan_id, item.id, EV.TASK_DEAD_LETTERED, { taskKey: item.task_key, attempts: item.attempts });
      }
      checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    release({ itemId, leaseId, delayS, reason }: any = {}) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      if (item.status !== SM.dispatchedState) throw new Error(`release su task non in corso (${item.status})`);
      if (dflt.enforceLease && item.lease_id && leaseId !== item.lease_id) {
        throw new Error(`lease non valido per ${item.task_key}`);
      }
      const delay = Math.max(0, Number(delayS) || 0);
      setItemStatus(item, SM.claimableState, {
        error: reason ? str(reason, 2000) : item.error,
        attempts: Math.max(0, item.attempts - 1),
        claim_expires_at: null,
        lease_id: null,
        next_eligible_at: delay > 0 ? now() + delay : null,
      });
      emit(item.plan_id, item.id, EV.TASK_RELEASED, { taskKey: item.task_key, delayS: delay, reason: reason ?? null });
      return stmt.getItem.get(itemId);
    },

    retry({ itemId }: any) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, SM.claimableState, {
        error: null,
        attempts: 0,
        claim_expires_at: null,
        next_eligible_at: null,
        lease_id: null,
      });
      emit(item.plan_id, item.id, EV.TASK_RETRIED, { taskKey: item.task_key });
      const plan = stmt.getPlan.get(item.plan_id);
      if (plan && (plan.status === PS.failed || plan.status === PS.completed)) {
        stmt.setPlanStatus.run(PS.running, null, item.plan_id);
      }
      return stmt.getItem.get(itemId);
    },

    approve({ itemId }: any) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, SM.initial);
      emit(item.plan_id, item.id, EV.TASK_APPROVED, { taskKey: item.task_key });
      return stmt.getItem.get(itemId);
    },

    reject({ itemId, reason }: any) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      setItemStatus(item, SM.failureState, { error: str(reason ?? "rejected", 2000) });
      emit(item.plan_id, item.id, EV.TASK_REJECTED, { taskKey: item.task_key, reason: str(reason, 2000) });
      checkPlanCompletion(item.plan_id);
      return stmt.getItem.get(itemId);
    },

    pausePlan({ planId }: any = {}) {
      const plan = stmt.getPlan.get(planId);
      if (!plan) throw new Error(`piano non trovato: ${planId}`);
      stmt.setPlanStatus.run(PS.paused, null, planId);
      emit(planId, null, EV.PLAN_PAUSED, {});
      return stmt.getPlan.get(planId);
    },

    resumePlan({ planId }: any = {}) {
      const plan = stmt.getPlan.get(planId);
      if (!plan) throw new Error(`piano non trovato: ${planId}`);
      stmt.setPlanStatus.run(PS.running, null, planId);
      emit(planId, null, EV.PLAN_RESUMED, {});
      return stmt.getPlan.get(planId);
    },

    metrics() {
      return computeMetrics(db, config);
    },

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
          emit(item.plan_id, item.id, EV.TASK_DEAD_LETTERED, { taskKey: item.task_key, reason: "timeout" });
          checkPlanCompletion(item.plan_id);
        } else {
          const delay = backoffSeconds(item.attempts, dflt);
          setItemStatus(item, SM.claimableState, {
            claim_expires_at: null,
            lease_id: null,
            next_eligible_at: t + delay,
          });
          emit(item.plan_id, item.id, EV.TASK_REQUEUED, { taskKey: item.task_key, reason: "timeout", retryInS: delay });
        }
      }
      return expired.length;
    },

    heartbeat({ itemId, leaseId }: any) {
      const item = stmt.getItem.get(itemId);
      if (!item) throw new Error(`task non trovato: ${itemId}`);
      if (item.status !== SM.dispatchedState) throw new Error(`heartbeat su task non in corso (${item.status})`);
      if (dflt.enforceLease && item.lease_id && leaseId !== item.lease_id) {
        throw new Error(`lease non valido per ${item.task_key}`);
      }
      db.prepare("UPDATE plan_items SET claim_expires_at=?, updated_at=? WHERE id=?").run(now() + visibilityTimeoutS, now(), item.id);
      return stmt.getItem.get(itemId);
    },

    eventsSince({ planId, seq = 0 }: any) {
      return stmt.eventsSince.all(planId, seq);
    },

    graph({ planId, format = "mermaid" }: any) {
      const items = stmt.itemsByPlan.all(planId) as Row[];
      const deps = stmt.depsByPlan.all(planId) as Row[];
      return renderGraph(items, deps, config.statusColors || {}, format);
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
