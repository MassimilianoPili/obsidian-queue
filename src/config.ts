// Config totalmente esterna del plugin: un queue.config.json letto sia dalla UI (qui) sia dal
// servizio off-process (task-service.cjs, che ha una copia speculare dei default come fallback).
// main.ts garantisce che il file esista prima di avviare il servizio, così UI e servizio leggono
// la STESSA configurazione.

export interface ColumnDef {
  status: string;
  label: string;
}
export interface OrderDef {
  field: string; // priority | ordinal | created_at | updated_at | attempts | task_key
  dir: "ASC" | "DESC";
}
export interface QueueConfig {
  labels: { ribbon: string; viewTitle: string; columns: ColumnDef[] };
  stateMachine: {
    initial: string;
    approvalState: string;
    claimableState: string;
    dispatchedState: string;
    successState: string;
    failureState: string;
    deadLetterState: string;
    terminalStates: string[];
    transitions: Record<string, string[]>;
  };
  planStates: { pending: string; running: string; completed: string; failed: string; paused: string };
  workerTypes: string[];
  ordering: OrderDef[];
  defaults: {
    visibilityTimeoutS: number;
    priority: number;
    maxAttempts: number;
    retryBaseS: number;
    retryCapS: number;
    retryJitterFrac: number;
    enforceLease: boolean;
    reaperIntervalS: number;
  };
}

export const DEFAULT_CONFIG: QueueConfig = {
  labels: {
    ribbon: "Agent Queue",
    viewTitle: "Agent Queue",
    columns: [
      { status: "AWAITING_APPROVAL", label: "In approvazione" },
      { status: "WAITING", label: "In coda" },
      { status: "DISPATCHED", label: "In corso" },
      { status: "DONE", label: "Completati" },
      { status: "FAILED", label: "Falliti" },
      { status: "DEAD_LETTER", label: "Dead-letter" },
    ],
  },
  stateMachine: {
    initial: "WAITING",
    approvalState: "AWAITING_APPROVAL",
    claimableState: "WAITING",
    dispatchedState: "DISPATCHED",
    successState: "DONE",
    failureState: "FAILED",
    deadLetterState: "DEAD_LETTER",
    terminalStates: ["DONE", "FAILED", "DEAD_LETTER"],
    transitions: {
      WAITING: ["DISPATCHED"],
      DISPATCHED: ["DONE", "WAITING", "FAILED", "DEAD_LETTER"],
      AWAITING_APPROVAL: ["WAITING", "FAILED"],
      FAILED: ["WAITING"],
      DEAD_LETTER: ["WAITING"],
      DONE: [],
    },
  },
  planStates: { pending: "PENDING", running: "RUNNING", completed: "COMPLETED", failed: "FAILED", paused: "PAUSED" },
  workerTypes: ["BE", "FE", "AI_TASK", "CONTRACT", "REVIEW", "CONTEXT_MANAGER", "SCHEMA_MANAGER", "HOOK_MANAGER"],
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
  },
};

function isObj(x: any): boolean {
  return x && typeof x === "object" && !Array.isArray(x);
}
function deepMerge(base: any, over: any): any {
  if (!isObj(over)) return base;
  const out: any = Array.isArray(base) ? [...base] : { ...base };
  for (const k of Object.keys(over)) {
    out[k] = isObj(base[k]) && isObj(over[k]) ? deepMerge(base[k], over[k]) : over[k];
  }
  return out;
}

// crea il file di default se assente, poi legge e fonde con i default (campi mancanti = default)
export function ensureConfig(path: string): QueueConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  try {
    if (!fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return deepMerge(DEFAULT_CONFIG, JSON.parse(fs.readFileSync(path, "utf8")));
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeDefaultConfig(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  fs.writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2));
}
