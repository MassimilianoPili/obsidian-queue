// Tipi condivisi del servizio coda. QueueConfig è lo stesso del plugin (type-only import: erased).
import type { QueueConfig } from "../config";
export type { QueueConfig };

// API minima di un motore SQLite (node:sqlite nativo o shim sql.js): stesse firme.
export interface PreparedStmt {
  get(...params: any[]): any;
  all(...params: any[]): any[];
  run(...params: any[]): { changes: number };
}
export interface Db {
  exec(sql: string): void;
  prepare(sql: string): PreparedStmt;
  close(): void;
}

export type Row = Record<string, any>;
