#!/usr/bin/env node
// Orchestratore di prova — stile agent-framework, MA tutto LOCALE su llm-wiki:
//   • coda + macchina a stati  →  plugin Agent Tasks (REST :8766)
//   • grounding / retrieval     →  plugin RAG di Obsidian (REST :8765)
// Nessun SOL, nessun LLM esterno: i worker "ragionano" sintetizzando i chunk reali della KB.
//
// Flusso: decompose(spec) → createPlan → worker pool (claim → RAG search → complete) →
//         approvazione REVIEW (quality gate) → plan COMPLETED → report finale.
//
// Uso: node orchestrator.mjs
import { readFileSync } from "node:fs";

const VAULT = "C:/NoCloud/Progetti/DC/llm-wiki/.obsidian/plugins";
const TASKS = cfg(`${VAULT}/obsidian-agent-tasks/data.json`, 8766);
const RAG = cfg(`${VAULT}/obsidian-rag/data.json`, 8765);

function cfg(dataPath, defPort) {
  try {
    const d = JSON.parse(readFileSync(dataPath, "utf8"));
    return { port: d.serverPort || defPort, key: d.serverApiKey || "" };
  } catch {
    return { port: defPort, key: "" };
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(svc, path, init = {}) {
  const headers = { ...(init.headers || {}) };
  if (svc.key) headers["Authorization"] = `Bearer ${svc.key}`;
  const res = await fetch(`http://127.0.0.1:${svc.port}${path}`, { ...init, headers });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}
const post = (svc, path, body) =>
  api(svc, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

// ── 1. Orchestratore: decompone una specifica in un DAG di task ────────────────
function decompose(spec) {
  // decomposizione deterministica (in AF la farebbe il Planner AI): CONTEXT → domain workers → REVIEW
  // decomposizione di esempio, NEUTRA rispetto al dominio: il plugin accoda task e basta.
  return {
    spec,
    tasks: [
      { taskKey: "CT-001", title: "Raccogli il contesto dalla knowledge base", workerType: "CONTEXT_MANAGER" },
      { taskKey: "BE-001", title: "Implementa il modulo A", workerType: "BE", dependsOn: ["CT-001"] },
      { taskKey: "BE-002", title: "Implementa il modulo B", workerType: "BE", dependsOn: ["CT-001"] },
      { taskKey: "BE-003", title: "Implementa il modulo C", workerType: "BE", dependsOn: ["CT-001"] },
      { taskKey: "RV-001", title: "Review finale e quality gate", workerType: "REVIEW", dependsOn: ["BE-001", "BE-002", "BE-003"], requireApproval: true },
    ],
  };
}

// ── worker: per ogni task interroga il RAG e produce un risultato grounded ──────
async function ragSearch(query, k = 5) {
  const j = await api(RAG, `/search?q=${encodeURIComponent(query)}&k=${k}`);
  return j.results || [];
}
function citationsOf(hits) {
  return hits.map((h) => h.sourceFile + (h.headerPath ? ` · ${h.headerPath}` : ""));
}

async function runWorker(name, planId, log) {
  while (true) {
    const plan = await api(TASKS, `/plans/${planId}`);
    if (plan.status === "COMPLETED" || plan.status === "FAILED") return;

    const { task } = await post(TASKS, "/tasks/claim", { worker: name });
    if (!task) {
      await sleep(250);
      continue;
    }

    if (task.worker_type === "REVIEW") {
      // review worker: legge i risultati a monte, calcola un reviewScore = copertura citazioni
      const items = (await api(TASKS, `/plans/${planId}`)).items.filter((i) => i.task_key.startsWith("BE-"));
      const withCit = items.filter((i) => {
        try {
          return (JSON.parse(i.result || "{}").citations || []).length > 0;
        } catch {
          return false;
        }
      });
      const score = items.length ? withCit.length / items.length : 0;
      const approved = score >= 0.99;
      log(`  [${name}] REVIEW ${task.task_key}: ${withCit.length}/${items.length} task con citazioni → score ${score.toFixed(2)} ${approved ? "APPROVATO" : "BLOCCATO"}`);
      await post(TASKS, `/tasks/${task.id}/complete`, { status: approved ? "success" : "failed", result: { reviewScore: score, approved } });
      continue;
    }

    // worker di dominio: grounding sul RAG
    const hits = await ragSearch(task.title, 5);
    const cit = citationsOf(hits);
    const top = hits[0];
    const summary = top ? String(top.content).replace(/^\[File:[^\n]*\n/, "").trim().slice(0, 160) : "(nessun estratto)";
    log(`  [${name}] ${task.task_key} "${task.title.slice(0, 40)}…" → ${hits.length} chunk, ${cit.length} citazioni`);
    await post(TASKS, `/tasks/${task.id}/complete`, { status: "success", result: { summary, citations: cit, chunks: hits.length } });
    await sleep(50);
  }
}

// ── approver / quality gate: approva la REVIEW quando le dipendenze sono DONE ───
async function approver(planId, log) {
  while (true) {
    const plan = await api(TASKS, `/plans/${planId}`);
    if (plan.status === "COMPLETED" || plan.status === "FAILED") return;
    const rv = plan.items.find((i) => i.status === "AWAITING_APPROVAL");
    if (rv) {
      const deps = plan.items.filter((i) => i.task_key.startsWith("BE-"));
      if (deps.every((d) => d.status === "DONE")) {
        log(`  [gate] dipendenze di ${rv.task_key} tutte DONE → approve`);
        await post(TASKS, `/tasks/${rv.id}/approve`, {});
      }
    }
    await sleep(300);
  }
}

async function main() {
  const log = (s) => console.log(s);
  log(`ORCHESTRATORE LOCALE (llm-wiki) — coda :${TASKS.port} · RAG :${RAG.port}`);

  const health = await api(TASKS, "/health");
  const rh = await api(RAG, "/health");
  log(`health: tasks ready=${health.ready} · RAG ready=${rh.ready} (${rh.chunks} chunk)\n`);

  const spec = "Esempio: implementa una funzionalità con contesto, tre moduli e una review finale";
  const plan = await post(TASKS, "/v1/plans", decompose(spec));
  log(`PIANO ${plan.id.slice(0, 8)} creato (${plan.items.length} task), spec: «${spec}»\n`);

  log("ESECUZIONE (3 worker + quality gate):");
  const planId = plan.id;
  const stop = { v: false };
  const appr = approver(planId, log);
  await Promise.all([runWorker("be-1", planId, log), runWorker("be-2", planId, log), runWorker("be-3", planId, log)]);
  stop.v = true;
  await appr;

  // ── report finale ──
  const final = await api(TASKS, `/plans/${planId}`);
  const events = await api(TASKS, `/plans/${planId}/events-since?seq=0`);
  log(`\nPIANO → ${final.status}`);
  let totCit = 0;
  for (const i of final.items) {
    let cit = 0;
    try {
      cit = (JSON.parse(i.result || "{}").citations || []).length;
    } catch {}
    totCit += cit;
    log(`  ${i.task_key.padEnd(7)} ${i.status.padEnd(10)} score=${i.process_score ?? "-"} citazioni=${cit}`);
  }
  log(`\nQUALITY GATE: ${totCit} citazioni totali · ${events.length} eventi · ${final.items.filter((i) => i.status === "DONE").length}/${final.items.length} task DONE`);
  log(`EVENTI: ${events.map((e) => e.type).join(" ")}`);
}

main().catch((e) => {
  console.error("orchestratore:", e.message);
  process.exit(1);
});
