// Suite del servizio coda — node:test (Node ≥18). Gira contro il BUNDLE (../task-service.cjs),
// che è TS bundlato: i moduli sorgente in src/service/ non sono caricabili da Node raw.
// `npm test` fa la build prima. Per il motore sql.js (Node vecchio) vedi test/bundle-smoke.cjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createStore, DEFAULTS, _initSqlJsFallback } = require("../task-service.cjs");
await _initSqlJsFallback();

// config di test: timeout/backoff minimi, reaper disattivato
function cfg(extra = {}) {
  const c = JSON.parse(JSON.stringify(DEFAULTS));
  Object.assign(
    c.defaults,
    { visibilityTimeoutS: 3, maxAttempts: 2, retryBaseS: 1, retryCapS: 10, retryJitterFrac: 0, reaperIntervalS: 9999, maxWip: 0, agingIntervalS: 0 },
    extra,
  );
  return c;
}

test("idempotencyKey: dedup dei piani", () => {
  const s = createStore(":memory:", cfg());
  const p1 = s.createPlan({ spec: "dedup", idempotencyKey: "k1", tasks: [{ taskKey: "T1", title: "uno" }] });
  const p2 = s.createPlan({ spec: "dedup2", idempotencyKey: "k1", tasks: [{ taskKey: "T2", title: "due" }] });
  assert.equal(p1.id, p2.id, "stessa key → stesso piano");
  assert.equal(s.listTasks({}).filter((t) => t.plan_id === p1.id).length, 1, "nessun task duplicato");
});

test("tag-routing: il worker deve offrire tutti i tag del task", () => {
  const s = createStore(":memory:", cfg());
  s.createPlan({ spec: "tags", tasks: [{ taskKey: "T-notag", title: "no tag" }, { taskKey: "T-tagged", title: "tag", tags: ["gpu", "fast"] }] });
  assert.equal(s.claimNext({ worker: "w", tags: [] })?.task_key, "T-notag", "worker senza tag prende il task senza tag");
  assert.equal(s.claimNext({ worker: "w", tags: [] }), null, "worker senza tag NON prende il task con tag");
  assert.equal(s.claimNext({ worker: "w", tags: ["gpu", "fast", "x"] })?.task_key, "T-tagged", "superset di tag → claim ok");

  const s2 = createStore(":memory:", cfg());
  s2.createPlan({ spec: "t2", tasks: [{ taskKey: "GF", title: "gf", tags: ["gpu", "fast"] }] });
  assert.equal(s2.claimNext({ worker: "w", tags: ["gpu"] }), null, "subset di tag → niente claim");
});

test("release/defer: torna in coda senza penalità + fencing", () => {
  const s = createStore(":memory:", cfg());
  s.createPlan({ spec: "rel", tasks: [{ taskKey: "R1", title: "r1" }] });
  const c = s.claimNext({ worker: "w" });
  assert.ok(c, "claim ok");
  const r = s.release({ itemId: c.id, leaseId: c.lease_id, delayS: 0 });
  assert.equal(r.id, c.id, "ritorna l'item aggiornato");
  const t = s.listTasks({}).find((x) => x.id === c.id);
  assert.equal(t.status, "WAITING", "tornato WAITING");
  assert.equal(t.attempts, Math.max(0, c.attempts - 1), "attempts decrementato");
  assert.equal(t.lease_id, null, "lease azzerato");
  const c2 = s.claimNext({ worker: "w" });
  assert.throws(() => s.release({ itemId: c2.id, leaseId: "sbagliato" }), "lease errato → eccezione");
});

test("WIP limit: backpressure quando maxWip raggiunto", () => {
  const s = createStore(":memory:", cfg({ maxWip: 1 }));
  s.createPlan({ spec: "wip", tasks: [{ taskKey: "A", title: "a" }, { taskKey: "B", title: "b" }] });
  const c1 = s.claimNext({ worker: "w" });
  assert.ok(c1, "primo claim ok");
  assert.equal(s.claimNext({ worker: "w" }), null, "secondo claim bloccato");
  s.complete({ itemId: c1.id, status: "success", leaseId: c1.lease_id });
  assert.ok(s.claimNext({ worker: "w" }), "liberato il WIP → claim ok");
});

test("priority: la priorità più bassa vince (senza aging)", () => {
  const s = createStore(":memory:", cfg());
  s.createPlan({ spec: "prio", tasks: [{ taskKey: "HI", title: "hi", priority: 1 }, { taskKey: "LO", title: "lo", priority: 9 }] });
  assert.equal(s.claimNext({ worker: "w" }).task_key, "HI");
});

test("pause/resume: PAUSED blocca il dispatch", () => {
  const s = createStore(":memory:", cfg());
  const p = s.createPlan({ spec: "pz", tasks: [{ taskKey: "P1", title: "p" }] });
  s.pausePlan({ planId: p.id });
  assert.equal(s.claimNext({ worker: "w" }), null, "PAUSED → niente claim");
  s.resumePlan({ planId: p.id });
  assert.equal(s.claimNext({ worker: "w" })?.plan_id, p.id, "resume → claim ok");
});

test("budget: superato maxDispatches il piano va in PAUSED", () => {
  const s = createStore(":memory:", cfg());
  const p = s.createPlan({ spec: "bud", budget: { maxDispatches: 1 }, tasks: [{ taskKey: "B1", title: "b1" }, { taskKey: "B2", title: "b2" }] });
  const c1 = s.claimNext({ worker: "w" });
  assert.ok(c1, "primo dispatch ok");
  s.complete({ itemId: c1.id, status: "success", leaseId: c1.lease_id });
  assert.equal(s.claimNext({ worker: "w" }), null, "budget esaurito → niente claim");
  assert.equal(s.getPlan(p.id).status, "PAUSED", "piano PAUSED per budget");
});

test("metrics: campi di Little's law presenti e coerenti", () => {
  const s = createStore(":memory:", cfg());
  s.createPlan({ spec: "m", tasks: [{ taskKey: "M1", title: "m1" }, { taskKey: "M2", title: "m2" }] });
  s.claimNext({ worker: "w" });
  const m = s.metrics();
  assert.equal(m.wip, 1, "wip = 1");
  assert.ok(m.queueDepth >= 1, "queueDepth >= 1");
  assert.equal(typeof m.throughput1m, "number");
  assert.equal(typeof m.deadLetterCount, "number");
});

test("DAG: deps bloccano il claim finché la dipendenza non è DONE", () => {
  const s = createStore(":memory:", cfg());
  s.createPlan({ spec: "dag", tasks: [{ taskKey: "A", title: "a" }, { taskKey: "B", title: "b", dependsOn: ["A"] }] });
  const a = s.claimNext({ worker: "w" });
  assert.equal(a.task_key, "A", "prima A");
  assert.equal(s.claimNext({ worker: "w" }), null, "B bloccato da dep");
  s.complete({ itemId: a.id, status: "success", leaseId: a.lease_id });
  assert.equal(s.claimNext({ worker: "w" }).task_key, "B", "A DONE → B claimabile");
});

test("query: read-only consente SELECT e rifiuta il resto", () => {
  const s = createStore(":memory:", cfg());
  s.createPlan({ spec: "q", tasks: [{ taskKey: "Q1", title: "q1", priority: 3 }] });
  const r = s.query({ sql: "SELECT task_key, priority FROM plan_items" });
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].priority, 3);
  assert.throws(() => s.query({ sql: "DELETE FROM plan_items" }), "no write");
  assert.throws(() => s.query({ sql: "SELECT 1; DROP TABLE plans" }), "no statement multipli");
});

test("updateTask: modifica i metadati, non lo stato", () => {
  const s = createStore(":memory:", cfg());
  const p = s.createPlan({ spec: "u", tasks: [{ taskKey: "U1", title: "vecchio", priority: 5 }] });
  const id = p.items[0].id;
  const r = s.updateTask({ itemId: id, title: "nuovo", priority: 1, tags: ["x", "y"], workerType: "DEV" });
  assert.equal(r.title, "nuovo");
  assert.equal(r.priority, 1);
  assert.equal(r.worker_type, "DEV");
  assert.deepEqual(JSON.parse(r.tags), ["x", "y"]);
  assert.equal(r.status, "WAITING", "stato invariato");
});

test("moveTask: consente transizioni legali e rifiuta le illegali", () => {
  const s = createStore(":memory:", cfg());
  const p = s.createPlan({ spec: "mv", tasks: [{ taskKey: "M", title: "m" }] });
  const id = p.items[0].id;
  const c = s.claimNext({ worker: "w" });
  assert.equal(c.status, "DISPATCHED");
  assert.equal(s.moveTask({ itemId: id, to: "DONE" }).status, "DONE", "DISPATCHED→DONE legale");
  assert.throws(() => s.moveTask({ itemId: id, to: "WAITING" }), "DONE→WAITING illegale");
});

test("deleteTask: rimuove il task e sblocca i dipendenti (cleanup DAG)", () => {
  const s = createStore(":memory:", cfg());
  const p = s.createPlan({ spec: "del", tasks: [{ taskKey: "A", title: "a" }, { taskKey: "B", title: "b", dependsOn: ["A"] }] });
  const a = p.items.find((i) => i.task_key === "A");
  assert.equal(s.claimNext({ worker: "w" }).task_key, "A", "B bloccato finché A esiste e non è DONE");
  s.deleteTask({ itemId: a.id });
  assert.equal(s.claimNext({ worker: "w" }).task_key, "B", "eliminata A → B sbloccato");
  assert.throws(() => s.deleteTask({ itemId: "inesistente" }), "delete di id inesistente → eccezione");
});
