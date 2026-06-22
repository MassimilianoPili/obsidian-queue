// Registry dei comandi: SINGLE SOURCE delle operazioni della coda.
// Da qui si derivano: il routing REST (server.ts) e il manifest dei tool (prompt.ts QUEUE_TOOLS).
// Ogni comando descrive metodo+path REST, auth, tipo di risposta, metadati (per i tool) e un
// adattatore `run` che mappa la richiesta HTTP sulla chiamata tipizzata del TaskServiceClient.

import type { TaskServiceClient } from "./service-client";

export type HttpMethod = "GET" | "POST" | "DELETE";

// contesto di una richiesta passato a run()
export interface CmdCtx {
  params: Record<string, string>; // segmenti :param del path
  query: URLSearchParams;
  body: any;
  req: any;
  res: any;
  server: { streamEvents(req: any, res: any, planId: string): void };
}

// risultato di run(): json da serializzare, testo grezzo, oppure handled=true (risposta già scritta, es. SSE)
export interface CmdResult {
  json?: unknown;
  text?: string;
  handled?: boolean;
}

export interface CommandDef {
  name: string;
  method: HttpMethod;
  path: string; // template con :param, es. "/tasks/:id/complete"
  auth?: boolean; // default true
  tool?: boolean; // se compare nel manifest QUEUE_TOOLS (default true)
  description: string;
  cli: string;
  params: Record<string, string>;
  run: (svc: TaskServiceClient, ctx: CmdCtx) => Promise<CmdResult>;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "health",
    method: "GET",
    path: "/health",
    auth: false,
    description: "Stato del server: numero task, ready. Nessuna auth.",
    cli: "tasks health",
    params: {},
    run: async (svc) => ({ json: await svc.health() }),
  },
  {
    name: "metrics",
    method: "GET",
    path: "/metrics",
    description: "Metriche di coda (Little's law): wip, queueDepth, throughput, avgLeadTimeS, deadLetterCount.",
    cli: "tasks metrics",
    params: {},
    run: async (svc) => ({ json: await svc.metrics() }),
  },
  {
    name: "query",
    method: "POST",
    path: "/query",
    description: "SQL read-only (solo SELECT/WITH) sul DB della coda, per ispezione/verifica.",
    cli: "tasks query <sql> [--limit N]",
    params: { sql: "una SELECT/WITH", limit: "max righe (opz, default 200)" },
    run: async (svc, c) => ({ json: await svc.query({ sql: c.body.sql, limit: c.body.limit }) }),
  },
  {
    name: "createPlan",
    method: "POST",
    path: "/v1/plans",
    description: "Crea un piano con i suoi task (DAG di dipendenze) e lo avvia.",
    cli: "tasks plan <spec.json>",
    params: { spec: "stringa", tasks: "array di task", idempotencyKey: "stringa (opz, dedup)", budget: "oggetto {maxDispatches} (opz)" },
    run: async (svc, c) => ({
      json: await svc.createPlan({
        spec: c.body.spec,
        tasks: c.body.tasks || [],
        idempotencyKey: c.body.idempotencyKey,
        budget: c.body.budget,
      }),
    }),
  },
  {
    name: "listTasks",
    method: "GET",
    path: "/tasks",
    description: "Elenca i task (filtro opzionale per status / plan).",
    cli: "tasks list [status]",
    params: { status: "filtro stato (opz)", planId: "filtro piano (opz)" },
    run: async (svc, c) => ({
      json: await svc.listTasks({
        status: c.query.get("status") || undefined,
        planId: c.query.get("planId") || undefined,
      }),
    }),
  },
  {
    name: "claim",
    method: "POST",
    path: "/tasks/claim",
    description: "Reclama il prossimo task pronto (WAITING, deps DONE, tag compatibili) → DISPATCHED.",
    cli: "tasks claim <worker> [--tags a,b]",
    params: { worker: "id del worker", tags: "array capacità (opz)" },
    run: async (svc, c) => {
      const tags = Array.isArray(c.body.tags) ? c.body.tags : undefined;
      const r = await svc.claimNext({ worker: c.body.worker, planId: c.body.planId, tags });
      return { json: r === null ? { task: null, backpressure: true } : { task: r } };
    },
  },
  {
    name: "complete",
    method: "POST",
    path: "/tasks/:id/complete",
    description: "Chiude un task DISPATCHED: success (→DONE) o failed (→FAILED/retry).",
    cli: "tasks complete <id> success|failed [msg] --lease <id>",
    params: { id: "task id", status: "success|failed", result: "json o messaggio", leaseId: "lease del claim" },
    run: async (svc, c) => ({
      json: await svc.complete({ itemId: c.params.id, status: c.body.status, result: c.body.result, leaseId: c.body.leaseId }),
    }),
  },
  {
    name: "release",
    method: "POST",
    path: "/tasks/:id/release",
    description: "Rimette il task in coda SENZA penalità (attempts-1). Usa quando mancano risorse.",
    cli: "tasks release <id> --lease <id> [--delay N]",
    params: { id: "task id", leaseId: "lease del claim", delayS: "secondi di attesa (opz)", reason: "motivo (opz)" },
    run: async (svc, c) => ({
      json: await svc.release({ itemId: c.params.id, leaseId: c.body.leaseId, delayS: c.body.delayS, reason: c.body.reason }),
    }),
  },
  {
    name: "heartbeat",
    method: "POST",
    path: "/tasks/:id/heartbeat",
    description: "Estende il lease di un task DISPATCHED (per task lunghi).",
    cli: "tasks heartbeat <id> --lease <id>",
    params: { id: "task id", leaseId: "lease del claim" },
    run: async (svc, c) => ({ json: await svc.heartbeat(c.params.id, c.body.leaseId) }),
  },
  {
    name: "retry",
    method: "POST",
    path: "/tasks/:id/retry",
    description: "Redrive manuale: riporta un task FAILED o DEAD_LETTER in WAITING (tentativi azzerati).",
    cli: "tasks retry <id>",
    params: { id: "task id" },
    run: async (svc, c) => ({ json: await svc.retry(c.params.id) }),
  },
  {
    name: "approve",
    method: "POST",
    path: "/tasks/:id/approve",
    description: "Approva un task AWAITING_APPROVAL → WAITING.",
    cli: "tasks approve <id>",
    params: { id: "task id" },
    run: async (svc, c) => ({ json: await svc.approve(c.params.id) }),
  },
  {
    name: "reject",
    method: "POST",
    path: "/tasks/:id/reject",
    description: "Rifiuta un task AWAITING_APPROVAL → FAILED.",
    cli: "tasks reject <id> [reason]",
    params: { id: "task id", reason: "stringa" },
    run: async (svc, c) => ({ json: await svc.reject(c.params.id, c.body.reason) }),
  },
  {
    name: "updateTask",
    method: "POST",
    path: "/tasks/:id/update",
    description: "Modifica i metadati di un task (NON lo stato): title, priority, tags, maxAttempts, workerType.",
    cli: "tasks update <id> [--title T] [--priority N] [--tags a,b] [--max N] [--worker-type X]",
    params: { id: "task id", title: "stringa (opz)", priority: "1-10 (opz)", tags: "array (opz)", maxAttempts: "intero (opz)", workerType: "stringa (opz)" },
    run: async (svc, c) => ({
      json: await svc.updateTask({
        itemId: c.params.id,
        title: c.body.title,
        description: c.body.description,
        priority: c.body.priority,
        tags: c.body.tags,
        maxAttempts: c.body.maxAttempts,
        workerType: c.body.workerType,
      }),
    }),
  },
  {
    name: "moveTask",
    method: "POST",
    path: "/tasks/:id/move",
    description: "Sposta manualmente un task a uno stato: solo transizioni legali della config.",
    cli: "tasks move <id> <toStatus>",
    params: { id: "task id", to: "stato di destinazione" },
    run: async (svc, c) => ({ json: await svc.moveTask({ itemId: c.params.id, to: c.body.to }) }),
  },
  {
    name: "deleteTask",
    method: "DELETE",
    path: "/tasks/:id",
    description: "Elimina un task dalla coda; rimuove anche gli archi DAG che lo referenziano.",
    cli: "tasks delete <id>",
    params: { id: "task id" },
    run: async (svc, c) => ({ json: await svc.deleteTask({ itemId: c.params.id }) }),
  },
  {
    name: "pausePlan",
    method: "POST",
    path: "/plans/:id/pause",
    description: "Mette in pausa un piano (nessun nuovo task viene dispatchato).",
    cli: "tasks pause <planId>",
    params: { id: "plan id" },
    run: async (svc, c) => ({ json: await svc.pausePlan(c.params.id) }),
  },
  {
    name: "resumePlan",
    method: "POST",
    path: "/plans/:id/resume",
    description: "Riprende un piano PAUSED → RUNNING.",
    cli: "tasks resume <planId>",
    params: { id: "plan id" },
    run: async (svc, c) => ({ json: await svc.resumePlan(c.params.id) }),
  },
  {
    name: "eventsSince",
    method: "GET",
    path: "/plans/:id/events-since",
    description: "Eventi del piano dal seq dato (default 0).",
    cli: "tasks events <id> [sinceSeq]",
    params: { id: "plan id", seq: "seq di partenza (query, default 0)" },
    run: async (svc, c) => ({ json: await svc.eventsSince(c.params.id, Number(c.query.get("seq")) || 0) }),
  },
  {
    name: "graph",
    method: "GET",
    path: "/plans/:id/graph",
    description: "DAG del piano in mermaid o json.",
    cli: "tasks graph <id> [format]",
    params: { id: "plan id", format: "mermaid|json (query)" },
    run: async (svc, c) => {
      const format = c.query.get("format") || "mermaid";
      const g = await svc.graph(c.params.id, format);
      if (format === "json") return { json: g };
      return { text: typeof g === "string" ? g : JSON.stringify(g) };
    },
  },
  {
    name: "events",
    method: "GET",
    path: "/plans/:id/events",
    tool: false, // SSE: non un tool RPC
    description: "Stream SSE degli eventi del piano (replay via Last-Event-ID).",
    cli: "—",
    params: { id: "plan id" },
    run: async (_svc, c) => {
      c.server.streamEvents(c.req, c.res, c.params.id);
      return { handled: true };
    },
  },
  {
    name: "getPlan",
    method: "GET",
    path: "/plans/:id",
    description: "Stato del piano con tutti i suoi item.",
    cli: "tasks plan-status <id>",
    params: { id: "plan id" },
    run: async (svc, c) => ({ json: await svc.getPlan(c.params.id) }),
  },
];

export interface QueueTool {
  name: string;
  description: string;
  http: string;
  cli: string;
  params: Record<string, string>;
}

// manifest dei tool derivato dal registry (esclude i comandi con tool:false)
export function deriveTools(): QueueTool[] {
  return COMMANDS.filter((c) => c.tool !== false).map((c) => ({
    name: c.name,
    description: c.description,
    http: `${c.method} ${c.path}`,
    cli: c.cli,
    params: c.params,
  }));
}

// matcher di path: confronta un template (/a/:id/b) coi segmenti della richiesta.
export function matchPath(template: string, parts: string[]): Record<string, string> | null {
  const tparts = template.split("/").filter(Boolean);
  if (tparts.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < tparts.length; i++) {
    if (tparts[i].startsWith(":")) params[tparts[i].slice(1)] = decodeURIComponent(parts[i]);
    else if (tparts[i] !== parts[i]) return null;
  }
  return params;
}

// risolve metodo+segmenti al comando giusto. Ordina i template più "letterali" prima
// (meno :param) così le route specifiche battono quelle parametriche a parità di segmenti.
const RESOLVED = [...COMMANDS].sort(
  (a, b) => (a.path.split("/:").length - 1) - (b.path.split("/:").length - 1),
);
export function resolveCommand(method: string, parts: string[]): { def: CommandDef; params: Record<string, string> } | null {
  for (const def of RESOLVED) {
    if (def.method !== method) continue;
    const params = matchPath(def.path, parts);
    if (params) return { def, params };
  }
  return null;
}
