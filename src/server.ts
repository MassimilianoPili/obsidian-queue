// Server REST locale (127.0.0.1) del plugin Agent Queue. Stessa coda della UI, interrogabile da
// Claude/CLI/altri agenti. Opt-in dalle impostazioni.
// Sicurezza (loopback, dati privati): NIENTE CORS; validazione Host (anti DNS-rebinding); body cap +
// timeout; API key Bearer richiesta su tutto tranne gli endpoint di discovery.
import type AgentTasksPlugin from "./main";
import { QUEUE_PROMPT, QUEUE_TOOLS } from "./prompt";
import { resolveCommand } from "./commands";

const BODY_CAP = 1_000_000;
const REQ_TIMEOUT_MS = 15_000;

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    let d = "";
    let total = 0;
    req.on("data", (c: any) => {
      total += c.length;
      if (total > BODY_CAP) {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return resolve({});
      }
      d += c;
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(d || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

export class TasksServer {
  private server: any = null;
  private port = 0;

  constructor(private plugin: AgentTasksPlugin) {}

  get running() {
    return this.server !== null;
  }
  get boundPort() {
    return this.port;
  }

  start(port: number, apiKey: string) {
    this.stop();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const http = require("http");
    this.port = port;
    const hostOk = new RegExp(`^(127\\.0\\.0\\.1|localhost|\\[::1\\]):${port}$`);

    this.server = http.createServer(async (req: any, res: any) => {
      req.setTimeout(REQ_TIMEOUT_MS);
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      try {
        if (!hostOk.test((req.headers["host"] || "").toString())) {
          return send(403, { error: "forbidden host" });
        }
        const url = new URL(req.url, "http://localhost");
        const parts = url.pathname.split("/").filter(Boolean); // es. ["plans","<id>","graph"]

        const svc = this.plugin.svc;
        if (!svc) return send(503, { error: "servizio non pronto" });

        // ── discovery meta (manifest/testo, nessuna auth) ──
        if (req.method === "GET" && url.pathname === "/tools") return send(200, { tools: QUEUE_TOOLS });
        if (req.method === "GET" && url.pathname === "/prompt") {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(QUEUE_PROMPT);
          return;
        }

        // ── routing dal registry dei comandi (single source) ──
        const match = resolveCommand(req.method, parts);
        if (!match) return send(404, { error: "not found" });
        if (match.def.auth !== false && apiKey) {
          if ((req.headers["authorization"] || "") !== `Bearer ${apiKey}`) {
            return send(401, { error: "unauthorized" });
          }
        }
        const body = req.method === "POST" ? await readBody(req) : {};
        const result = await match.def.run(svc, {
          params: match.params,
          query: url.searchParams,
          body,
          req,
          res,
          server: this,
        });
        if (result.handled) return; // risposta già scritta (es. SSE)
        if (result.text !== undefined) {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(result.text);
          return;
        }
        return send(200, result.json);
      } catch (e: any) {
        send(500, { error: String(e?.message || e) });
      }
    });

    this.server.on("error", (e: any) => {
      console.error("Task Queue server error", e);
      this.server = null;
    });
    this.server.listen(port, "127.0.0.1");
  }

  // SSE: poll degli eventi del piano, invio incrementale per seq. Replay via Last-Event-ID.
  // pubblico: invocato dal registry dei comandi (commands.ts).
  streamEvents(req: any, res: any, planId: string) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    let lastSeq = Number(req.headers["last-event-id"]) || 0;
    let closed = false;
    const tick = async () => {
      if (closed) return;
      try {
        const events = await this.plugin.svc.eventsSince(planId, lastSeq);
        for (const ev of events) {
          lastSeq = ev.seq;
          res.write(`id: ${ev.seq}\n`);
          res.write(`event: ${ev.type}\n`);
          res.write(`data: ${JSON.stringify(ev)}\n\n`);
        }
      } catch {
        /* il piano potrebbe non esistere ancora */
      }
    };
    const iv = setInterval(tick, 1000);
    void tick();
    req.on("close", () => {
      closed = true;
      clearInterval(iv);
    });
  }

  stop() {
    if (this.server) {
      try {
        this.server.close();
      } catch {
        /* ignore */
      }
      this.server = null;
    }
  }
}
