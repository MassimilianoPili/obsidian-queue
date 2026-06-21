// Client del servizio off-process (task-service.cjs). Parla col system node via JSON-lines su
// stdin/stdout. Protocollo: richiesta {id, cmd, args} → risposta {id, ok, result} | {id, ok:false, error}.
// Il servizio emette {type:"ready"} all'avvio. stderr → log.

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
type LogFn = (level: "info" | "warn" | "error", msg: string) => void;

export class TaskServiceClient {
  private proc: any = null;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private buf = "";

  constructor(
    private nodePath: string,
    private serviceScript: string,
    private dbPath: string,
    private log: LogFn = () => {},
  ) {}

  get running() {
    return this.proc !== null;
  }

  private async ensure(): Promise<void> {
    if (this.proc && this.readyPromise) return this.readyPromise;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cp = require("child_process");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");
    if (!this.serviceScript) throw new Error("serviceScript non impostato");
    const cwd = path.dirname(this.serviceScript);
    this.proc = cp.spawn(this.nodePath, [this.serviceScript, this.dbPath], {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, NODE_NO_WARNINGS: "1" }, // silenzia l'ExperimentalWarning di node:sqlite
    });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      const failAll = (err: Error) => {
        reject(err);
        for (const p of this.pending.values()) p.reject(err);
        this.pending.clear();
      };
      this.proc.on("error", (e: any) =>
        failAll(new Error(`spawn «${this.nodePath}» fallito (${e?.message || e}) — Node ≥22.5 nel PATH?`)),
      );
      this.proc.on("exit", (c: any) => {
        this.proc = null;
        this.readyPromise = null;
        failAll(new Error(`servizio uscito (code ${c})`));
      });
      setTimeout(() => reject(new Error("servizio: timeout avvio (10s)")), 10000);
    });
    this.proc.stdout.on("data", (d: any) => this.onData(String(d)));
    this.proc.stderr.on("data", (d: any) => {
      const s = String(d).trim();
      if (s) this.log("info", `service: ${s}`);
    });
    return this.readyPromise;
  }

  private onData(s: string) {
    this.buf += s;
    let i;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.type === "ready") {
        this.readyResolve?.();
        continue;
      }
      const p = this.pending.get(m.id);
      if (!p) continue;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new Error(m.error || "errore servizio"));
    }
  }

  async request(cmd: string, args: any = {}): Promise<any> {
    await this.ensure();
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, cmd, args }) + "\n");
    });
  }

  // convenienze tipizzate
  createPlan(args: { spec?: string; tasks: any[] }) {
    return this.request("createPlan", args);
  }
  getPlan(planId: string) {
    return this.request("getPlan", { planId });
  }
  listTasks(args: { planId?: string; status?: string } = {}) {
    return this.request("listTasks", args);
  }
  claimNext(args: { worker?: string; planId?: string } = {}) {
    return this.request("claimNext", args);
  }
  complete(args: { itemId: string; status: string; result?: any }) {
    return this.request("complete", args);
  }
  retry(itemId: string) {
    return this.request("retry", { itemId });
  }
  approve(itemId: string) {
    return this.request("approve", { itemId });
  }
  reject(itemId: string, reason?: string) {
    return this.request("reject", { itemId, reason });
  }
  graph(planId: string, format = "mermaid") {
    return this.request("graph", { planId, format });
  }
  eventsSince(planId: string, seq = 0) {
    return this.request("eventsSince", { planId, seq });
  }
  health() {
    return this.request("health", {});
  }

  dispose() {
    try {
      this.proc?.kill();
    } catch {
      /* ignore */
    }
    this.proc = null;
    this.readyPromise = null;
    this.pending.clear();
  }
}
