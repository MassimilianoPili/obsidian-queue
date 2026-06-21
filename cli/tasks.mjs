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

const VERSION = "0.1.0";
const usage = `tasks — CLI della coda task del plugin Obsidian "Agent Tasks"  v${VERSION}

USO
  tasks <comando> [opzioni]

COMANDI
  plan <spec.json>            Crea un piano da file JSON {spec, tasks:[...]} e lo avvia.
  list [status]               Elenca i task (opz. filtra per status: WAITING/DISPATCHED/DONE/FAILED/AWAITING_APPROVAL).
  claim <worker>              Reclama il prossimo task pronto (→ DISPATCHED). Ritorna anche lease_id.
  complete <id> <ok> [msg]    Chiude un task: ok = success|failed. Usa --lease <id> (fencing).
  heartbeat <id> --lease <id> Estende il lease di un task in corso (task lunghi).
  retry <id>                  Redrive da FAILED/DEAD_LETTER → WAITING (tentativi azzerati).
  approve <id>                AWAITING_APPROVAL → WAITING.
  reject <id> [reason]        AWAITING_APPROVAL → FAILED.
  plan-status <id>            Stato del piano + item.
  graph <id> [format]         DAG del piano (mermaid|json, default mermaid).
  events <id> [sinceSeq]      Eventi del piano dal seq dato (default 0).
  health                      Stato del server.
  prompt                      Mini system-prompt per un agente.
  tools                       Manifest tool (JSON).
  help | -h | --help          Questo aiuto.
  version | --version         Versione.

OPZIONI
  --lease <id>                Lease id (da 'claim') per complete/heartbeat (fencing).
  --port N                    Porta del server REST (default 8766).
  --key <bearer>              API key Bearer.
  --data <path>               Legge porta+key dal data.json del plugin.

CONFIG (precedenza: flag > env > file)
  env:   TASKS_PORT  TASKS_KEY  TASKS_DATA

ESEMPI
  tasks plan piano.json --data "$TASKS_DATA"
  tasks list WAITING --data "$TASKS_DATA"
  tasks claim worker-1 --data "$TASKS_DATA"
  tasks complete <id> success '{"files":3}' --data "$TASKS_DATA"`;

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
  async claim() {
    const [worker] = positionals();
    if (!worker) die("manca il worker: tasks claim <worker>");
    out(await call("/tasks/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worker }),
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
