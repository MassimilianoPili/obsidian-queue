"use strict";
// Logica di configurazione CONDIVISA tra plugin (config.ts) e servizio (task-service.cjs).
// Single source: schema canonico `states[]` + derivazione di stateMachine/labels.columns/statusColors.
// CJS apposta: caricabile da Node a runtime (servizio + test) e bundlabile da esbuild per entrambi i target.

const DEFAULT_CANONICAL = {
  labels: { ribbon: "Task Queue", viewTitle: "Task Queue" },
  states: [
    { type: "AWAITING_APPROVAL", order: 1, label: "In approvazione", color: "#d6a400", transitions: ["WAITING", "FAILED"], role: "approval" },
    { type: "WAITING", order: 2, label: "In coda", color: "#3b82f6", transitions: ["DISPATCHED"], role: "claimable", initial: true },
    { type: "DISPATCHED", order: 3, label: "In corso", color: "#a855f7", transitions: ["DONE", "WAITING", "FAILED", "DEAD_LETTER"], role: "dispatched" },
    { type: "DONE", order: 4, label: "Completati", color: "#22c55e", transitions: [], role: "success", terminal: true },
    { type: "FAILED", order: 5, label: "Falliti", color: "#ef4444", transitions: ["WAITING"], role: "failure", terminal: true },
    { type: "DEAD_LETTER", order: 6, label: "Dead-letter", color: "#991b1b", transitions: ["WAITING"], role: "deadLetter", terminal: true },
  ],
  planStates: { pending: "PENDING", running: "RUNNING", completed: "COMPLETED", failed: "FAILED", paused: "PAUSED" },
  taskTypes: ["CONTEXT", "ARCH", "BE", "FE", "DEV", "QA", "DOC", "REVIEW", "OPS"],
  ordering: [
    { field: "priority", dir: "ASC" },
    { field: "ordinal", dir: "ASC" },
  ],
  defaults: {
    visibilityTimeoutS: 300,
    priority: 5,
    maxAttempts: 3,
    retryBaseS: 5,
    retryCapS: 600,
    retryJitterFrac: 0.25,
    enforceLease: true,
    reaperIntervalS: 5,
    maxWip: 0, // 0 = off; limit globale dei task DISPATCHED in contemporanea
    agingIntervalS: 0, // 0 = off; ogni N secondi la priorità effettiva scende di 1
  },
};

const ROLE_TO_POINTER = {
  approval: "approvalState",
  claimable: "claimableState",
  dispatched: "dispatchedState",
  success: "successState",
  failure: "failureState",
  deadLetter: "deadLetterState",
};

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

// deriva stateMachine + labels.columns + statusColors dalla lista `states` (ordinata per `order`).
function deriveFromStates(c) {
  const states = c.states;
  if (!Array.isArray(states) || !states.length) return c; // legacy: niente da derivare
  const sorted = [...states].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const sm = (c.stateMachine = c.stateMachine || {});
  const transitions = {};
  const terminal = [];
  for (const s of states) {
    if (!s || !s.type) continue;
    transitions[s.type] = Array.isArray(s.transitions) ? s.transitions : [];
    if (s.terminal) terminal.push(s.type);
    if (s.role && ROLE_TO_POINTER[s.role]) sm[ROLE_TO_POINTER[s.role]] = s.type;
    if (s.initial) sm.initial = s.type;
  }
  sm.transitions = transitions;
  sm.terminalStates = terminal;
  if (!sm.initial) sm.initial = sm.claimableState;
  c.labels = c.labels || {};
  c.labels.columns = sorted.map((s) => ({ status: s.type, label: s.label || s.type }));
  c.statusColors = {};
  for (const s of states) if (s.color) c.statusColors[s.type] = s.color;
  return c;
}

// un file è "legacy" se non usa il nuovo schema `states` ma ha le vecchie strutture esplicite
function isLegacy(json) {
  return !json.states && !!(json.stateMachine || (json.labels && json.labels.columns) || json.statusColors);
}

// config di default completa (canonica + derivata)
function buildDefaults() {
  return deriveFromStates(JSON.parse(JSON.stringify(DEFAULT_CANONICAL)));
}

// fonde un config letto da file coi default e normalizza (deriva dal nuovo schema o passa il legacy).
function normalize(json, defaults) {
  if (isLegacy(json)) {
    const legacyDefault = { ...defaults };
    delete legacyDefault.states;
    return deepMerge(legacyDefault, json);
  }
  return deriveFromStates(deepMerge(defaults, json));
}

module.exports = { DEFAULT_CANONICAL, deepMerge, deriveFromStates, isLegacy, buildDefaults, normalize };
