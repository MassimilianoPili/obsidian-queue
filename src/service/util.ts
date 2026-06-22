// Utility pure del servizio: tempo, id, sanitizzazione input, backoff, ORDER BY allowlist.
import { randomUUID } from "crypto";

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
export function uuid(): string {
  return randomUUID();
}
export function str(v: any, max = 2000): string {
  if (v == null) return "";
  return String(v).slice(0, max);
}
export function intIn(v: any, def: number, lo: number, hi: number): number {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}
// backoff esponenziale con jitter: min(base*2^(att-1), cap) * (1 - frac*rnd)
export function backoffSeconds(attempt: number, d: any): number {
  const base = d.retryBaseS ?? 5;
  const cap = d.retryCapS ?? 600;
  const frac = d.retryJitterFrac ?? 0.25;
  const delay = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  const jittered = delay * (1 - frac * Math.random());
  return Math.max(1, Math.round(jittered));
}

// campi ammessi nell'ORDER BY (no input grezzo in SQL)
const ORDER_FIELDS = new Set(["priority", "ordinal", "created_at", "updated_at", "attempts", "task_key"]);
export function buildOrderBy(ordering: Array<{ field: string; dir: string }>): string {
  const parts = (ordering || [])
    .filter((o) => o && ORDER_FIELDS.has(o.field))
    .map((o) => `${o.field} ${String(o.dir).toUpperCase() === "DESC" ? "DESC" : "ASC"}`);
  return "ORDER BY " + (parts.length ? parts.join(", ") : "priority ASC, ordinal ASC");
}
