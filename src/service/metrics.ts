// Metriche di coda (Little's law): WIP, queue depth, throughput, lead/cycle time, dead-letter.
import { now } from "./util";
import type { Db, QueueConfig } from "./types";

export function computeMetrics(db: Db, config: QueueConfig) {
  const SM = config.stateMachine;
  const t = now();
  const byStatus = db.prepare("SELECT status, COUNT(*) AS n FROM plan_items GROUP BY status").all();
  const counts = Object.fromEntries(byStatus.map((r: any) => [r.status, r.n]));
  const wip = counts[SM.dispatchedState] ?? 0;
  const queueDepth = db
    .prepare("SELECT COUNT(*) AS n FROM plan_items WHERE status=? AND (next_eligible_at IS NULL OR next_eligible_at <= ?)")
    .get(SM.claimableState, t).n;
  const dlCount = (counts[SM.deadLetterState] ?? 0) + (counts[SM.failureState] ?? 0);
  const done1m = db
    .prepare("SELECT COUNT(*) AS n FROM plan_items WHERE status IN ('DONE','FAILED','DEAD_LETTER') AND updated_at >= ?")
    .get(t - 60).n;
  const done1h = db
    .prepare("SELECT COUNT(*) AS n FROM plan_items WHERE status IN ('DONE','FAILED','DEAD_LETTER') AND updated_at >= ?")
    .get(t - 3600).n;
  const leadRow = db
    .prepare("SELECT AVG(updated_at - created_at) AS v FROM plan_items WHERE status IN ('DONE','FAILED','DEAD_LETTER')")
    .get();
  const cycleRow = db
    .prepare("SELECT AVG(updated_at - created_at) AS v FROM plan_items WHERE status IN ('DONE','FAILED','DEAD_LETTER') AND attempts > 0")
    .get();
  const oldestRow = db
    .prepare("SELECT MIN(created_at) AS v FROM plan_items WHERE status=? AND (next_eligible_at IS NULL OR next_eligible_at <= ?)")
    .get(SM.claimableState, t);
  return {
    wip,
    queueDepth,
    throughput1m: done1m,
    throughput1h: done1h,
    avgLeadTimeS: leadRow?.v ?? null,
    avgCycleTimeS: cycleRow?.v ?? null,
    oldestWaitingAgeS: oldestRow?.v != null ? t - oldestRow.v : null,
    deadLetterCount: dlCount,
    statusCounts: counts,
  };
}
