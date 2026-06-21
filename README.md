# Agent Queue (obsidian-queue)

Coda e **macchina a stati dei task degli agenti** dentro Obsidian. Un meccanismo generico, agnostico
al dominio, per accodare e coordinare il lavoro di più worker/agenti — ispirato all'architettura di un
agent-framework multi-agente, ma **tutto locale**: nessun cloud, nessun broker, nessun servizio esterno.

- **Storage**: un singolo file SQLite via **`node:sqlite`** (Node ≥ 22.5), posseduto da un servizio
  Node **off-process**. Niente binari nativi da spedire.
- **Esposizione**: server **REST** locale (`127.0.0.1`) + **CLI** + **board** Kanban/DAG in Obsidian.
- **Configurazione**: **tutto** ridefinibile da `queue.config.json` (stati, transizioni, ordinamento,
  tipi worker, etichette, default).

> Non serve pubblicare il plugin: si usa in **sideload** (vedi sotto). La directory ufficiale dei
> Community Plugins è opzionale.

## Architettura

```
Renderer (main.js)  ──JSON-lines stdin/stdout──►  task-service.cjs (system node)
   │ board (ItemView Kanban + DAG)                    │ node:sqlite → <plugin>/tasks.db
   │ REST server (server.ts)  ◄── CLI / agenti        │ tabelle: plans, plan_items, plan_item_deps, plan_event
                                                       │ reaper periodico (visibility timeout)
```

Lo SQLite di Obsidian/Electron **non** è `node:sqlite`: per questo lo storage gira in un processo
`node` di sistema separato (stesso pattern off-process del plugin RAG). I worker passano dal REST,
quindi i `claim` si **serializzano** nell'event loop del servizio (niente writer concorrenti).

## Macchina a stati

```
WAITING ──claim──► DISPATCHED ──complete success──► DONE
                            └─ complete failed ─► (auto-retry con backoff) WAITING … ─► DEAD_LETTER (tentativi esauriti)
AWAITING_APPROVAL ──approve──► WAITING   |   ──reject──► FAILED
FAILED | DEAD_LETTER ──retry──► WAITING (redrive manuale, tentativi azzerati)
```

- **DAG**: un task è claimabile solo se è `WAITING`, tutte le sue `dependsOn` sono `DONE`, e il
  backoff è scaduto.
- **Approvazione**: i task con `requireApproval` partono in `AWAITING_APPROVAL`.
- **Auto-retry**: un fallimento con tentativi residui torna in coda dopo backoff esponenziale + jitter
  (`min(base·2^(att-1), cap)`, jitter non-negativo); a tentativi esauriti → `DEAD_LETTER`.
- **Visibility timeout + reaper**: un `DISPATCHED` non completato entro il lease viene rimesso in coda
  (o `DEAD_LETTER`) da un reaper periodico. Per task lunghi usa `heartbeat`.
- **Fencing**: `claim` ritorna un `lease_id`; `complete`/`heartbeat` devono combaciare, così un worker
  il cui lease è scaduto (task ripreso da altri) non chiude il dispatch sbagliato.
- **Event sourcing**: ogni transizione è un evento append-only (`plan_event`, `seq` per replay SSE).

## Configurazione — `queue.config.json`

Generato col default al primo avvio nella cartella del plugin (override del path nelle impostazioni;
pulsante "Rigenera config di default"). **Tutto** è configurabile:

```jsonc
{
  "labels": { "ribbon": "Agent Queue", "viewTitle": "Agent Queue", "columns": [ { "status": "...", "label": "..." } ] },
  "stateMachine": {
    "initial": "WAITING", "approvalState": "AWAITING_APPROVAL", "claimableState": "WAITING",
    "dispatchedState": "DISPATCHED", "successState": "DONE", "failureState": "FAILED",
    "deadLetterState": "DEAD_LETTER", "terminalStates": ["DONE","FAILED","DEAD_LETTER"],
    "transitions": { "WAITING": ["DISPATCHED"], "DISPATCHED": ["DONE","WAITING","FAILED","DEAD_LETTER"], "...": [] }
  },
  "planStates": { "pending": "PENDING", "running": "RUNNING", "completed": "COMPLETED", "failed": "FAILED", "paused": "PAUSED" },
  "workerTypes": ["BE","FE","REVIEW","CONTEXT_MANAGER","..."],
  "ordering": [ { "field": "priority", "dir": "ASC" }, { "field": "ordinal", "dir": "ASC" } ],
  "defaults": { "visibilityTimeoutS": 300, "priority": 5, "maxAttempts": 3,
                "retryBaseS": 5, "retryCapS": 600, "retryJitterFrac": 0.25, "enforceLease": true, "reaperIntervalS": 5 }
}
```

I nomi di stato sono validati (allowlist) prima di entrare nelle query; i campi di `ordering` sono su
allowlist. Puoi ridefinire interamente la tua macchina a stati (es. `TODO/DOING/SHIPPED/KO`).

## REST API (`127.0.0.1`, opt-in)

Auth Bearer su tutto tranne gli endpoint di discovery. Validazione Host (anti DNS-rebinding), body cap, timeout.

| Metodo | Path | Auth | Note |
|---|---|---|---|
| GET | `/health` | no | stato + conteggi |
| GET | `/prompt` | no | mini system-prompt per un agente |
| GET | `/tools` | no | manifest tool (JSON) |
| POST | `/v1/plans` | sì | crea piano + task, avvia |
| GET | `/plans/{id}` | sì | piano + item |
| GET | `/plans/{id}/graph?format=mermaid\|json` | sì | DAG |
| GET | `/plans/{id}/events` | sì | SSE (replay via `Last-Event-ID`) |
| GET | `/tasks?status=&planId=` | sì | lista task |
| POST | `/tasks/claim` `{worker}` | sì | → DISPATCHED, ritorna `lease_id` |
| POST | `/tasks/{id}/complete` `{status,result,leaseId}` | sì | success\|failed |
| POST | `/tasks/{id}/heartbeat` `{leaseId}` | sì | estende il lease |
| POST | `/tasks/{id}/retry` · `/approve` · `/reject` | sì | transizioni manuali |

## CLI

```
tasks plan <spec.json>            crea ed avvia un piano
tasks list [status]               elenca i task
tasks claim <worker>              reclama il prossimo (ritorna lease_id)
tasks complete <id> success|failed [msg] --lease <id>
tasks heartbeat <id> --lease <id>
tasks retry|approve|reject <id>
tasks plan-status <id> | graph <id> | events <id> | health | prompt | tools
```

Config (precedenza flag > env > file): `--port/--key/--data`, `TASKS_PORT/TASKS_KEY/TASKS_DATA`,
oppure `--data <…/obsidian-queue/data.json>`.

## Board

Comando "Agent Queue: Apri board" o icona ribbon. Colonne per stato (dalla config), card con
worker/tentativi/score/countdown-retry, pulsanti Approva/Rifiuta/Riprova, DAG mermaid per piano,
refresh live.

## Esempio: orchestratore locale

`examples/orchestrator.mjs` mostra un orchestratore stile agent-framework **interamente locale**:
decompone una spec in un DAG, più worker fanno `claim` dalla coda e si fondano su un endpoint RAG
locale per il contesto, una review fa da quality gate. Neutro rispetto al dominio.

## Sideload

Copia in `<vault>/.obsidian/plugins/obsidian-queue/`: `main.js`, `manifest.json`, `styles.css`,
`task-service.cjs`, `tasks.mjs`. Abilita "Agent Queue" in Impostazioni → Plugin della community.
`data.json` (porta/API key) e `queue.config.json` (default) vengono creati al primo avvio.

## Sviluppo

```
npm install
npm run build      # esbuild → main.js (CJS). task-service.cjs è plain, non bundlato.
npx tsc --noEmit   # typecheck
```

## Requisiti

- Obsidian desktop (il plugin è `isDesktopOnly`: usa `child_process` + system node).
- **Node ≥ 22.5** nel PATH (per `node:sqlite`). `node:sqlite` è experimental: stampa un warning su
  stderr (innocuo, silenziato col flag `NODE_NO_WARNINGS`).

## Licenza

MIT
