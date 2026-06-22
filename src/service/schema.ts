// Schema SQL + migrazioni idempotenti. Lo stato `claimableState` (validato) entra nell'indice parziale.
import type { Db } from "./types";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  spec TEXT,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  idempotency_key TEXT,
  budget_max_dispatches INTEGER,
  dispatch_count INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS plan_items (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  task_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  title TEXT,
  description TEXT,
  worker_type TEXT,
  worker_profile TEXT,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  require_approval INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  error TEXT,
  worker TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  claim_expires_at INTEGER,
  next_eligible_at INTEGER,
  lease_id TEXT,
  tags TEXT,
  review_score REAL,
  process_score REAL,
  aggregated_reward REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_plan ON plan_items(plan_id);
CREATE TABLE IF NOT EXISTS plan_item_deps (
  plan_id TEXT NOT NULL,
  task_key TEXT NOT NULL,
  depends_on TEXT NOT NULL,
  PRIMARY KEY (plan_id, task_key, depends_on)
);
CREATE TABLE IF NOT EXISTS plan_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id TEXT NOT NULL,
  item_id TEXT,
  type TEXT NOT NULL,
  payload TEXT,
  occurred_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_plan ON plan_event(plan_id, seq);
`;

// inizializza lo schema + migra DB pre-esistenti (aggiunge colonne mancanti). claimableState già validato.
export function initSchema(db: Db, claimableState: string): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const cols = new Set(db.prepare("PRAGMA table_info(plan_items)").all().map((c: any) => c.name));
  if (!cols.has("next_eligible_at")) db.exec("ALTER TABLE plan_items ADD COLUMN next_eligible_at INTEGER");
  if (!cols.has("lease_id")) db.exec("ALTER TABLE plan_items ADD COLUMN lease_id TEXT");
  if (!cols.has("tags")) db.exec("ALTER TABLE plan_items ADD COLUMN tags TEXT");
  const pcols = new Set(db.prepare("PRAGMA table_info(plans)").all().map((c: any) => c.name));
  if (!pcols.has("idempotency_key")) db.exec("ALTER TABLE plans ADD COLUMN idempotency_key TEXT");
  if (!pcols.has("budget_max_dispatches")) db.exec("ALTER TABLE plans ADD COLUMN budget_max_dispatches INTEGER");
  if (!pcols.has("dispatch_count")) db.exec("ALTER TABLE plans ADD COLUMN dispatch_count INTEGER NOT NULL DEFAULT 0");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_plans_ikey ON plans(idempotency_key) WHERE idempotency_key IS NOT NULL");
  db.exec(`CREATE INDEX IF NOT EXISTS idx_items_claimable ON plan_items(plan_id, priority, ordinal) WHERE status = '${claimableState}';`);
}
