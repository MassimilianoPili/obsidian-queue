// Config totalmente esterna del plugin: un queue.config.json letto sia dalla UI (qui) sia dal
// servizio off-process (task-service.cjs, che ha una copia speculare della normalizzazione).
//
// SCHEMA CANONICO: ogni stato è definito UNA volta in `states` (label, color, transitions, role,
// terminal, initial) e `order` dà l'ordine delle colonne. Da qui si DERIVANO le strutture interne
// che il motore e la board già usano (stateMachine, labels.columns, statusColors) → niente drift.
// Back-compat: i config vecchi (con labels.columns/statusColors/stateMachine e senza `states`)
// continuano a caricarsi invariati.

export interface ColumnDef {
  status: string;
  label: string;
}
export interface OrderDef {
  field: string; // priority | ordinal | created_at | updated_at | attempts | task_key
  dir: "ASC" | "DESC";
}
export type StateRole = "approval" | "claimable" | "dispatched" | "success" | "failure" | "deadLetter";
export interface StateDef {
  type: string; // nome dello stato (es. "WAITING")
  order: number; // posizione della colonna
  label: string;
  color: string; // hex (#rrggbb): accento board + nodo DAG
  transitions: string[]; // stati raggiungibili (genera i pulsanti "Sposta →")
  role?: StateRole; // ruolo semantico per il motore
  terminal?: boolean; // stato terminale
  initial?: boolean; // stato iniziale dei task senza approvazione
}
export interface QueueConfig {
  labels: { ribbon: string; viewTitle: string; columns: ColumnDef[] };
  states: StateDef[];
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
  taskTypes: string[];
  statusColors: Record<string, string>; // derivato da states[].color
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
    maxWip: number;
    agingIntervalS: number;
  };
}

// logica canonica/derivazione condivisa col servizio (config-core.cjs) → niente duplicazione.
interface ConfigCore {
  DEFAULT_CANONICAL: any;
  buildDefaults(): QueueConfig;
  normalize(json: any, defaults: QueueConfig): QueueConfig;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core: ConfigCore = require("./config-core.cjs");

export const DEFAULT_CONFIG: QueueConfig = core.buildDefaults();

// crea il file di default (schema canonico) se assente, poi legge, fonde e normalizza
export function ensureConfig(path: string): QueueConfig {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  try {
    if (!fs.existsSync(path)) fs.writeFileSync(path, JSON.stringify(core.DEFAULT_CANONICAL, null, 2));
    return core.normalize(JSON.parse(fs.readFileSync(path, "utf8")), DEFAULT_CONFIG);
  } catch {
    return DEFAULT_CONFIG;
  }
}

export function writeDefaultConfig(path: string): void {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const fs = require("fs");
  fs.writeFileSync(path, JSON.stringify(core.DEFAULT_CANONICAL, null, 2));
}
