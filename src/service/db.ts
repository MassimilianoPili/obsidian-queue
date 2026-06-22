// Motore SQLite con coalesce: node:sqlite nativo (Node ≥22.5) o shim sql.js (asm.js, qualsiasi Node).
// L'asm.js è puro JS (niente WASM-BigInt, niente file esterni) → bundlabile e version-agnostic.
import * as fs from "fs";
import type { Db } from "./types";

let DatabaseSync: any = null;
let engine = "node:sqlite";
try {
  // node:sqlite esiste solo col prefisso e solo su Node ≥22.5; su Node vecchio throw → fallback.
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  /* fallback sql.js */
}

export function engineName(): string {
  return engine;
}

export async function initSqlJsFallback(): Promise<void> {
  if (DatabaseSync) return;
  const initSqlJs = require("sql.js/dist/sql-asm.js");
  const SQL = await initSqlJs();
  engine = "sql.js (asm.js)";
  DatabaseSync = class SqlJsDatabaseSync {
    private _path: string;
    private _inMemory: boolean;
    private _inTx: boolean;
    private _db: any;
    constructor(dbPath: string) {
      this._path = dbPath;
      this._inMemory = dbPath === ":memory:";
      this._inTx = false;
      if (!this._inMemory && fs.existsSync(dbPath)) {
        this._db = new SQL.Database(fs.readFileSync(dbPath));
      } else {
        this._db = new SQL.Database();
      }
    }
    exec(sql: string) {
      const up = sql.trim().toUpperCase();
      if (up === "BEGIN" || up.startsWith("BEGIN ")) {
        this._inTx = true;
      } else if (up === "COMMIT" || up.startsWith("COMMIT ")) {
        this._db.exec(sql);
        this._inTx = false;
        this._save();
        return;
      } else if (up === "ROLLBACK" || up.startsWith("ROLLBACK ")) {
        this._inTx = false;
      }
      this._db.exec(sql);
    }
    prepare(sql: string) {
      const self = this;
      return {
        get(...params: any[]) {
          const stmt = self._db.prepare(sql);
          stmt.bind(params);
          const row = stmt.step() ? stmt.getAsObject() : undefined;
          stmt.free();
          return row;
        },
        all(...params: any[]) {
          const stmt = self._db.prepare(sql);
          stmt.bind(params);
          const rows: any[] = [];
          while (stmt.step()) rows.push(stmt.getAsObject());
          stmt.free();
          return rows;
        },
        run(...params: any[]) {
          self._db.run(sql, params);
          if (!self._inTx) self._save();
          return { changes: 0 };
        },
      };
    }
    close() {
      if (!this._inMemory) this._save();
      this._db.close();
    }
    private _save() {
      if (!this._inMemory) fs.writeFileSync(this._path, Buffer.from(this._db.export()));
    }
  };
}

export function openDb(dbPath: string): Db {
  if (!DatabaseSync) throw new Error("motore DB non inizializzato: chiamare initSqlJsFallback() prima");
  return new DatabaseSync(dbPath);
}
