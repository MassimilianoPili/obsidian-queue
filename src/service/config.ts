// Config del servizio: default + validazione + load da file. La logica canonica/derivazione è
// condivisa col plugin via config-core.cjs (single source). Qui si aggiunge la validazione SQL-safe.
import * as fs from "fs";
import type { QueueConfig } from "../config";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cfgCore = require("../config-core.cjs");

export const DEFAULTS: QueueConfig = cfgCore.buildDefaults();

// i nomi di stato finiscono in indici/SQL: validali (defense-in-depth)
const STATE_RE = /^[A-Z_][A-Z0-9_]*$/;
function assertState(s: any, where: string): string {
  if (typeof s !== "string" || !STATE_RE.test(s)) throw new Error(`stato non valido (${where}): ${JSON.stringify(s)}`);
  return s;
}

export function validateConfig(c: any): QueueConfig {
  const sm = c.stateMachine;
  ["initial", "approvalState", "claimableState", "dispatchedState", "successState", "failureState"].forEach((k) =>
    assertState(sm[k], `stateMachine.${k}`),
  );
  if (sm.deadLetterState) assertState(sm.deadLetterState, "stateMachine.deadLetterState");
  (sm.terminalStates || []).forEach((s: any) => assertState(s, "terminalStates"));
  for (const [from, tos] of Object.entries<any>(sm.transitions || {})) {
    assertState(from, "transitions.from");
    (tos || []).forEach((t: any) => assertState(t, `transitions[${from}]`));
  }
  Object.values(c.planStates || {}).forEach((s: any) => assertState(s, "planStates"));
  return c as QueueConfig;
}

export function loadConfig(p: string): QueueConfig {
  if (!p) return DEFAULTS;
  try {
    return validateConfig(cfgCore.normalize(JSON.parse(fs.readFileSync(p, "utf8")), DEFAULTS));
  } catch (e: any) {
    process.stderr.write(`[task-service] config non valida (${p}): ${e.message} — uso i default\n`);
    return DEFAULTS;
  }
}
