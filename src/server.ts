// Server REST locale (127.0.0.1) del plugin Agent Queue. Stessa coda della UI, interrogabile da
// Claude/CLI/altri agenti. Opt-in dalle impostazioni.
// Sicurezza (loopback, dati privati): NIENTE CORS; validazione Host (anti DNS-rebinding); body cap +
// timeout; API key Bearer richiesta su tutto tranne gli endpoint di discovery.
import type AgentTasksPlugin from "./main";
import { AGENT_PROMPT, AGENT_TOOLS } from "./prompt";

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

        const noAuth = url.pathname === "/health" || url.pathname === "/prompt" || url.pathname === "/tools";
        if (apiKey && !noAuth) {
          if ((req.headers["authorization"] || "") !== `Bearer ${apiKey}`) {
            return send(401, { error: "unauthorized" });
          }
        }
        const svc = this.plugin.svc;
        if (!svc) return send(503, { error: "servizio non pronto" });

        // ── discovery ──
        if (url.pathname === "/health") return send(200, await svc.health());
        if (url.pathname === "/tools") return send(200, { tools: AGENT_TOOLS });
        if (url.pathname === "/prompt") {
          res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(AGENT_PROMPT);
          return;
        }

        // ── plans ──
        if (parts[0] === "v1" && parts[1] === "plans" && req.method === "POST") {
          const body = await readBody(req);
          return send(200, await svc.createPlan({ spec: body.spec, tasks: body.tasks || [] }));
        }
        // lista task (filtro opzionale per status / plan)
        if (parts[0] === "tasks" && !parts[1] && req.method === "GET") {
          const status = url.searchParams.get("status") || undefined;
          const planId = url.searchParams.get("planId") || undefined;
          return send(200, await svc.listTasks({ status, planId }));
        }

        if (parts[0] === "plans" && parts[1] && req.method === "GET") {
          const planId = parts[1];
          if (parts[2] === "events-since") {
            const seq = Number(url.searchParams.get("seq")) || 0;
            return send(200, await svc.eventsSince(planId, seq));
          }
          if (parts[2] === "graph") {
            const format = url.searchParams.get("format") || "mermaid";
            const g = await svc.graph(planId, format);
            if (format === "json") return send(200, g);
            res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
            res.end(typeof g === "string" ? g : JSON.stringify(g));
            return;
          }
          if (parts[2] === "events") {
            return this.streamEvents(req, res, planId);
          }
          return send(200, await svc.getPlan(planId));
        }

        // ── tasks ──
        if (parts[0] === "tasks" && parts[1] === "claim" && req.method === "POST") {
          const body = await readBody(req);
          return send(200, { task: await svc.claimNext({ worker: body.worker, planId: body.planId }) });
        }
        if (parts[0] === "tasks" && parts[1] && parts[2] && req.method === "POST") {
          const itemId = parts[1];
          const body = await readBody(req);
          if (parts[2] === "complete") return send(200, await svc.complete({ itemId, status: body.status, result: body.result }));
          if (parts[2] === "retry") return send(200, await svc.retry(itemId));
          if (parts[2] === "approve") return send(200, await svc.approve(itemId));
          if (parts[2] === "reject") return send(200, await svc.reject(itemId, body.reason));
        }

        send(404, { error: "not found" });
      } catch (e: any) {
        send(500, { error: String(e?.message || e) });
      }
    });

    this.server.on("error", (e: any) => {
      console.error("Agent Queue server error", e);
      this.server = null;
    });
    this.server.listen(port, "127.0.0.1");
  }

  // SSE: poll degli eventi del piano, invio incrementale per seq. Replay via Last-Event-ID.
  private streamEvents(req: any, res: any, planId: string) {
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
