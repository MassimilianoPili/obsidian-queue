// Sorgente unica del mini system-prompt e del manifest dei tool, esposti dal plugin:
//  - server REST:  GET /prompt (text)  e  GET /tools (json)
//  - CLI:          tasks prompt / tasks tools

export const AGENT_PROMPT = `# Coda task agenti — "Agent Tasks" (Obsidian)

Coordini il lavoro multi-agente tramite una CODA con MACCHINA A STATI (replica dell'agent-framework),
persistita in SQLite locale ed esposta dal plugin Obsidian su 127.0.0.1. NON c'è auto-dispatch: i
worker fanno claim esplicito del prossimo task pronto.

MACCHINA A STATI (item/task)
  WAITING ──claim──► DISPATCHED ──complete success──► DONE
                              └──complete failed────► FAILED ──retry──► WAITING
  AWAITING_APPROVAL ──approve──► WAITING   |   ──reject──► FAILED
- Un task è claimabile solo se è WAITING E tutte le sue dipendenze (dependsOn) sono DONE (DAG).
- I task con requireApproval partono in AWAITING_APPROVAL: vanno approvati prima di entrare in coda.
- Visibility timeout: un DISPATCHED non completato torna in coda (o FAILED dopo max tentativi).

TOOL (REST, Bearer <API key> tranne /health,/prompt,/tools · equivalenti CLI tra parentesi)
- POST /v1/plans {spec, tasks:[{taskKey,title,workerType,dependsOn,requireApproval,priority}]}  (tasks plan <spec.json>)
- POST /tasks/claim {worker}            → prossimo task pronto, passa a DISPATCHED                 (tasks claim <worker>)
- POST /tasks/{id}/complete {status,result}  status=success|failed                                 (tasks complete <id> success|failed)
- POST /tasks/{id}/retry · /approve · /reject                                                       (tasks retry|approve|reject <id>)
- GET  /plans/{id}            → stato piano + item                                                  (tasks plan-status <id>)
- GET  /plans/{id}/graph?format=mermaid|json                                                        (tasks graph <id>)
- GET  /plans/{id}/events     → SSE eventi (replay via Last-Event-ID)                               (tasks events <id>)
- GET  /health                → {status, tasks, ready}  (no auth)                                   (tasks health)

WORKFLOW WORKER
1. claim un task → 2. esegui il lavoro (per il CONTESTO usa il RAG esposto da Obsidian, vedi sotto)
→ 3. complete success con il risultato, oppure failed con il motivo. Se ti blocchi, lascia che scada
la visibility (verrà ri-messo in coda) invece di fallire a vuoto.

RAG / RETRIEVAL (separato, già esposto da Obsidian)
- Per il contesto/knowledge usa il plugin RAG: GET /search?q=…&k=… sulla sua porta. Questo plugin
  gestisce SOLO la coordinazione dei task, non la ricerca.

GROUNDING
- Cita sempre la fonte (file · sezione) per le affermazioni derivate dalla KB. Non inventare: se gli
  estratti non coprono, dichiaralo nel result del task.`;

export interface AgentTool {
  name: string;
  description: string;
  http: string;
  cli: string;
  params: Record<string, string>;
}

export const AGENT_TOOLS: AgentTool[] = [
  {
    name: "createPlan",
    description: "Crea un piano con i suoi task (DAG di dipendenze) e lo avvia (RUNNING).",
    http: "POST /v1/plans {spec, tasks:[{taskKey,title,workerType,dependsOn,requireApproval,priority}]}",
    cli: "tasks plan <spec.json>",
    params: { spec: "stringa", tasks: "array di task con taskKey/dependsOn" },
  },
  {
    name: "claim",
    description: "Reclama il prossimo task pronto (WAITING con dipendenze DONE) → DISPATCHED.",
    http: "POST /tasks/claim {worker}",
    cli: "tasks claim <worker>",
    params: { worker: "id del worker" },
  },
  {
    name: "complete",
    description: "Chiude un task DISPATCHED: success (→DONE) o failed (→FAILED).",
    http: "POST /tasks/{id}/complete {status, result}",
    cli: "tasks complete <id> success|failed [msg]",
    params: { id: "task id", status: "success|failed", result: "json o messaggio" },
  },
  {
    name: "retry",
    description: "Riporta un task FAILED in WAITING.",
    http: "POST /tasks/{id}/retry",
    cli: "tasks retry <id>",
    params: { id: "task id" },
  },
  {
    name: "approve",
    description: "Approva un task AWAITING_APPROVAL → WAITING.",
    http: "POST /tasks/{id}/approve",
    cli: "tasks approve <id>",
    params: { id: "task id" },
  },
  {
    name: "reject",
    description: "Rifiuta un task AWAITING_APPROVAL → FAILED.",
    http: "POST /tasks/{id}/reject {reason}",
    cli: "tasks reject <id> [reason]",
    params: { id: "task id", reason: "stringa" },
  },
  {
    name: "getPlan",
    description: "Stato del piano con tutti i suoi item.",
    http: "GET /plans/{id}",
    cli: "tasks plan-status <id>",
    params: { id: "plan id" },
  },
  {
    name: "graph",
    description: "DAG del piano in mermaid o json.",
    http: "GET /plans/{id}/graph?format=mermaid|json",
    cli: "tasks graph <id>",
    params: { id: "plan id", format: "mermaid|json" },
  },
  {
    name: "health",
    description: "Stato del server: numero task, ready. Nessuna auth.",
    http: "GET /health",
    cli: "tasks health",
    params: {},
  },
];
