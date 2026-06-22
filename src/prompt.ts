// Sorgente unica del mini system-prompt e del manifest dei tool, esposti dal plugin:
//  - server REST:  GET /prompt (text)  e  GET /tools (json)
//  - CLI:          tasks prompt / tasks tools

import { deriveTools } from "./commands";
export type { QueueTool } from "./commands";
export const QUEUE_PROMPT = `# Task Queue (Obsidian)

Coda generica con MACCHINA A STATI persistita in SQLite locale ed esposta dal plugin Obsidian su
127.0.0.1. NON c'è auto-dispatch: i worker fanno claim esplicito del prossimo task pronto.

MACCHINA A STATI (task)
  WAITING ──claim──► DISPATCHED ──complete success──► DONE
                              └──complete failed──► (auto-retry con backoff) WAITING … ──► DEAD_LETTER (tentativi esauriti)
  AWAITING_APPROVAL ──approve──► WAITING   |   ──reject──► FAILED
  FAILED|DEAD_LETTER ──retry──► WAITING (redrive manuale, tentativi azzerati)
- Un task è claimabile solo se è WAITING E tutte le dipendenze (dependsOn) sono DONE (DAG) E il backoff è scaduto.
- I task con requireApproval partono in AWAITING_APPROVAL: vanno approvati prima di entrare in coda.
- FENCING: 'claim' ritorna un lease_id; passalo a 'complete', 'heartbeat' e 'release'. Se il tuo
  lease è scaduto (task ripreso da un altro worker) il complete viene rifiutato — non insistere.
- TAG ROUTING: il claim accetta 'tags' (capacità del worker); un task viene assegnato solo se il
  worker offre tutti i tag richiesti dal task. Task senza tag = claimabile da chiunque.
- VISIBILITY TIMEOUT: un DISPATCHED non completato torna in coda (auto-retry); per task lunghi
  manda 'heartbeat' per estendere il lease. Esauriti i tentativi → DEAD_LETTER.
- RELEASE: rimette il task in coda SENZA penalità (attempts-1); usa per "ho bisogno di risorse
  non ancora disponibili" invece di fallire o aspettare il timeout.
- WIP LIMIT: se maxWip>0 e ci sono già maxWip task DISPATCHED, claim ritorna null (backpressure).
- PAUSE/RESUME: un piano PAUSED non eroga nuovi task finché non viene ripreso.

TOOL (REST, Bearer <API key> tranne /health,/prompt,/tools · equivalenti CLI tra parentesi)
- POST /v1/plans {spec, tasks:[{taskKey,title,workerType,tags,dependsOn,requireApproval,priority}], idempotencyKey, budget:{maxDispatches}}  (tasks plan <spec.json>)
- POST /tasks/claim {worker, tags?}                → task pronto, → DISPATCHED, ritorna lease_id  (tasks claim <worker> [--tags a,b])
- POST /tasks/{id}/complete {status,result,leaseId}  status=success|failed                        (tasks complete <id> success|failed --lease <id>)
- POST /tasks/{id}/release  {leaseId,delayS?,reason?}  → WAITING senza penalità                  (tasks release <id> --lease <id> [--delay N])
- POST /tasks/{id}/heartbeat {leaseId}             → estende il lease (task lunghi)                (tasks heartbeat <id> --lease <id>)
- POST /tasks/{id}/retry · /approve · /reject                                                      (tasks retry|approve|reject <id>)
- POST /tasks/{id}/update {title?,priority?,tags?,maxAttempts?,workerType?}  → edit metadati        (tasks update <id> [opts])
- POST /tasks/{id}/move {to}                       → sposta a uno stato (solo transizioni legali)    (tasks move <id> <toStatus>)
- DELETE /tasks/{id}                               → elimina il task (+ archi DAG che lo referenziano) (tasks delete <id>)
- POST /plans/{id}/pause · /resume                                                                 (tasks pause|resume <planId>)
- POST /query {sql, limit?}                        → SQL read-only (SELECT/WITH) per verifica        (tasks query <sql>)
- GET  /metrics                                    → Little's law + WIP + throughput (auth)        (tasks metrics)
- GET  /plans/{id}                                 → stato piano + item                            (tasks plan-status <id>)
- GET  /plans/{id}/graph?format=mermaid|json                                                       (tasks graph <id>)
- GET  /plans/{id}/events                          → SSE eventi (replay via Last-Event-ID)         (tasks events <id>)
- GET  /health                                     → {status, tasks, ready}  (no auth)             (tasks health)

WORKFLOW WORKER
1. claim un task (con i tuoi tags se richiesti) → 2. esegui il lavoro → 3. complete success con
il risultato, oppure failed con il motivo. Se ti mancano risorse: usa 'release' (non failed) per
rimettere il task in coda senza perdere un tentativo. Per task lunghi: manda heartbeat periodici.`;

// QUEUE_TOOLS è derivato dal registry dei comandi (single source).
export const QUEUE_TOOLS = deriveTools();

// back-compat: alcuni moduli importano i vecchi nomi
export const AGENT_PROMPT = QUEUE_PROMPT;
export const AGENT_TOOLS = QUEUE_TOOLS;
