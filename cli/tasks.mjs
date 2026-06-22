#!/usr/bin/env node
// CLI per la coda task del plugin Obsidian "Agent Tasks": parla col server REST locale.
// Richiede Obsidian aperto col plugin attivo e "server REST" abilitato (default ON).
//
// Config (porta + API key), in ordine di precedenza:
//   1) flag:  --port 8766 --key <bearer>
//   2) env:   TASKS_PORT, TASKS_KEY
//   3) file:  --data <path/to/data.json>  oppure env TASKS_DATA  (legge serverPort/serverApiKey)
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function flag(name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : def;
}
function positionals() {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("-")) {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

function config() {
  let port = flag("--port", process.env.TASKS_PORT);
  let key = flag("--key", process.env.TASKS_KEY);
  const data = flag("--data", process.env.TASKS_DATA);
  if ((!port || !key) && data) {
    try {
      const d = JSON.parse(readFileSync(data, "utf8"));
      port = port || d.serverPort;
      key = key || d.serverApiKey;
    } catch (e) {
      die(`impossibile leggere data.json (${data}): ${e.message}`);
    }
  }
  return { port: Number(port) || 8766, key: key || "" };
}

function die(msg, code = 1) {
  process.stderr.write(`tasks: ${msg}\n`);
  process.exit(code);
}

async function call(path, init = {}) {
  const { port, key } = config();
  const headers = { ...(init.headers || {}) };
  if (key) headers["Authorization"] = `Bearer ${key}`;
  const url = `http://127.0.0.1:${port}${path}`;
  let res;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    die(`server non raggiungibile su ${url} — Obsidian aperto e server REST abilitato? (${e.message})`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) die(`HTTP ${res.status}: ${json.error || text}`, 2);
  return json;
}
async function callText(path) {
  const { port, key } = config();
  const r = await fetch(`http://127.0.0.1:${port}${path}`, key ? { headers: { Authorization: `Bearer ${key}` } } : {}).catch(
    () => null,
  );
  if (!r || !r.ok) die(`impossibile ottenere ${path} dal server`);
  return r.text();
}
function out(o) {
  process.stdout.write((typeof o === "string" ? o : JSON.stringify(o, null, 2)) + "\n");
}

const VERSION = "0.2.0";
const usage = `tasks — CLI della coda task del plugin Obsidian "Task Queue"  v${VERSION}

USO
  tasks <comando> [opzioni]

COMANDI
  plan <spec.json>               Crea un piano da file JSON {spec, tasks:[...], idempotencyKey?, budget?} e lo avvia.
  list [status]                  Elenca i task (opz. filtra per status: WAITING/DISPATCHED/DONE/FAILED/AWAITING_APPROVAL).
  query <sql> [--limit N]        SQL read-only (solo SELECT/WITH) per ispezione/verifica del DB.
  update <id> [opts]             Modifica i metadati di un task: --title --priority --tags a,b --max N --worker-type X.
  move <id> <toStatus>           Sposta manualmente un task a uno stato (solo transizioni legali della config).
  delete <id>                    Elimina un task dalla coda (rimuove anche gli archi DAG che lo referenziano).
  claim <worker> [--tags a,b]    Reclama il prossimo task pronto (→ DISPATCHED). Ritorna anche lease_id.
  complete <id> <ok> [msg]       Chiude un task: ok = success|failed. Usa --lease <id> (fencing).
  release <id> --lease <id>      Rimette in coda senza penalità (manca contesto/risorse). --delay N (secondi).
  heartbeat <id> --lease <id>    Estende il lease di un task in corso (task lunghi).
  retry <id>                     Redrive da FAILED/DEAD_LETTER → WAITING (tentativi azzerati).
  approve <id>                   AWAITING_APPROVAL → WAITING.
  reject <id> [reason]           AWAITING_APPROVAL → FAILED.
  pause <planId>                 Mette in pausa un piano (nessun nuovo dispatch).
  resume <planId>                Riprende un piano PAUSED.
  metrics                        Metriche di coda: wip, queueDepth, throughput, deadLetterCount.
  plan-status <id>               Stato del piano + item.
  graph <id> [format]            DAG del piano (mermaid|json, default mermaid).
  events <id> [sinceSeq]         Eventi del piano dal seq dato (default 0).
  health                         Stato del server.
  prompt                         System-prompt per un worker.
  tools                          Manifest tool (JSON).
  help | -h | --help             Questo aiuto.
  version | --version            Versione.

OPZIONI
  --lease <id>                   Lease id (da 'claim') per complete/release/heartbeat (fencing).
  --delay N                      Secondi di backoff per 'release' (default 0).
  --tags a,b,c                   Capacità del worker per 'claim' (tag routing).
  --port N                       Porta del server REST (default 8766).
  --key <bearer>                 API key Bearer.
  --data <path>                  Legge porta+key dal data.json del plugin.

CONFIG (precedenza: flag > env > file)
  env:   TASKS_PORT  TASKS_KEY  TASKS_DATA

ESEMPI
  tasks plan piano.json --data "$TASKS_DATA"
  tasks list WAITING --data "$TASKS_DATA"
  tasks claim worker-1 --tags gpu,fast --data "$TASKS_DATA"
  tasks complete <id> success '{"files":3}' --lease <lid> --data "$TASKS_DATA"
  tasks release <id> --lease <lid> --delay 30 --data "$TASKS_DATA"
  tasks metrics --data "$TASKS_DATA"`;

const run = {
  async plan() {
    const [file] = positionals();
    if (!file) die("manca il file: tasks plan <spec.json>");
    let spec;
    try {
      spec = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      die(`json non valido (${file}): ${e.message}`);
    }
    const j = await call("/v1/plans", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ spec: spec.spec || "", tasks: spec.tasks || [] }),
    });
    out(j);
  },
  async list() {
    const [status] = positionals();
    const qs = status ? `?status=${encodeURIComponent(status)}` : "";
    out(await call(`/tasks${qs}`));
  },
  async query() {
    const [sql] = positionals();
    if (!sql) die("uso: tasks query <sql> [--limit N]");
    out(await call("/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sql, limit: Number(flag("--limit")) || undefined }),
    }));
  },
  async update() {
    const [id] = positionals();
    if (!id) die("uso: tasks update <id> [--title T] [--priority N] [--tags a,b] [--max N] [--worker-type X]");
    const tagsRaw = flag("--tags");
    const patch = {};
    if (flag("--title") !== undefined) patch.title = flag("--title");
    if (flag("--priority") !== undefined) patch.priority = Number(flag("--priority"));
    if (flag("--max") !== undefined) patch.maxAttempts = Number(flag("--max"));
    if (flag("--worker-type") !== undefined) patch.workerType = flag("--worker-type");
    if (tagsRaw !== undefined) patch.tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
    out(await call(`/tasks/${id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }));
  },
  async move() {
    const [id, to] = positionals();
    if (!id || !to) die("uso: tasks move <id> <toStatus>");
    out(await call(`/tasks/${id}/move`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to }),
    }));
  },
  async delete() {
    const [id] = positionals();
    if (!id) die("uso: tasks delete <id>");
    out(await call(`/tasks/${id}`, { method: "DELETE" }));
  },
  async claim() {
    const [worker] = positionals();
    if (!worker) die("manca il worker: tasks claim <worker>");
    const tagsRaw = flag("--tags");
    const tags = tagsRaw ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
    out(await call("/tasks/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker, ...(tags ? { tags } : {}) }),
    }));
  },
  async complete() {
    const [id, ok, msg] = positionals();
    if (!id || !ok) die("uso: tasks complete <id> success|failed [msg] [--lease <leaseId>]");
    let result = msg;
    try {
      result = msg ? JSON.parse(msg) : undefined;
    } catch {
      /* lascia stringa */
    }
    out(await call(`/tasks/${id}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: ok, result, leaseId: flag("--lease") }),
    }));
  },
  async heartbeat() {
    const [id] = positionals();
    if (!id) die("uso: tasks heartbeat <id> [--lease <leaseId>]");
    out(await call(`/tasks/${id}/heartbeat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId: flag("--lease") }),
    }));
  },
  async release() {
    const [id] = positionals();
    if (!id) die("uso: tasks release <id> --lease <leaseId> [--delay N]");
    out(await call(`/tasks/${id}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leaseId: flag("--lease"), delayS: Number(flag("--delay", "0")) || 0 }),
    }));
  },
  async pause() {
    const [id] = positionals();
    if (!id) die("manca il planId: tasks pause <planId>");
    out(await call(`/plans/${id}/pause`, { method: "POST" }));
  },
  async resume() {
    const [id] = positionals();
    if (!id) die("manca il planId: tasks resume <planId>");
    out(await call(`/plans/${id}/resume`, { method: "POST" }));
  },
  async metrics() {
    out(await call("/metrics"));
  },
  async retry() {
    const [id] = positionals();
    if (!id) die("manca l'id");
    out(await call(`/tasks/${id}/retry`, { method: "POST" }));
  },
  async approve() {
    const [id] = positionals();
    if (!id) die("manca l'id");
    out(await call(`/tasks/${id}/approve`, { method: "POST" }));
  },
  async reject() {
    const [id, reason] = positionals();
    if (!id) die("manca l'id");
    out(await call(`/tasks/${id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason }),
    }));
  },
  async "plan-status"() {
    const [id] = positionals();
    if (!id) die("manca il plan id");
    out(await call(`/plans/${id}`));
  },
  async graph() {
    const [id, format] = positionals();
    if (!id) die("manca il plan id");
    out(await callText(`/plans/${id}/graph?format=${format || "mermaid"}`));
  },
  async events() {
    const [id, since] = positionals();
    if (!id) die("manca il plan id");
    out(await call(`/plans/${id}/events-since?seq=${since || 0}`));
  },
  async health() {
    out(await call("/health"));
  },
  async prompt() {
    out(await callText("/prompt"));
  },
  async tools() {
    const j = await call("/tools");
    out(j.tools ?? j);
  },
  version() {
    out("tasks " + VERSION);
  },
  help() {
    out(usage);
  },
};

if (cmd === "version" || argv.includes("--version")) {
  out("tasks " + VERSION);
  process.exit(0);
}
if (!cmd || cmd === "help" || argv.includes("-h") || argv.includes("--help") || !run[cmd]) {
  out(usage);
  process.exit(cmd && !run[cmd] ? 1 : 0);
}
run[cmd]();
