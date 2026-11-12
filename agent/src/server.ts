// Small HTTP API for the dashboard + static file server for dashboard/index.html.
// npm run agent  →  http://localhost:8787
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { askBudi, brain } from "./budi.js";
import { assertRestrictedKey } from "./wallet.js";
import { morseInjection, runScenario, scenarios } from "./scenarios.js";
import { EXPLORER_TX, ids, NETWORK, view, type LogEntry, type Policy } from "./near.js";

const PORT = Number(process.env.PORT ?? 8787);
const keyInfo = await assertRestrictedKey();
console.log(`Budi's key ${keyInfo.publicKey} is limited to ${keyInfo.receiver} → [${keyInfo.methods.join(", ")}]`);

// Serialize chain writes from the UI so nonces never collide.
let queue: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
};

async function body(req: IncomingMessage): Promise<Record<string, string>> {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function send(res: ServerResponse, status: number, data: unknown, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(type === "application/json" ? JSON.stringify(data) : (data as string));
}

const routes: Record<string, (req: IncomingMessage) => Promise<unknown>> = {
  "GET /api/state": async () => {
    const [policy, logs, held] = await Promise.all([
      view<Policy>("get_policy"),
      view<LogEntry[]>("get_logs", { from: 0, limit: 100 }),
      view<LogEntry[]>("get_held"),
    ]);
    return { network: NETWORK, ids: { ...ids }, brain, key: keyInfo, explorer: EXPLORER_TX, policy, logs, held };
  },
  "GET /api/scenarios": async () => ({ scenarios: scenarios.map(({ id, title, kind }) => ({ id, title, kind })), injection: morseInjection() }),
  "POST /api/chat": async (req) => {
    const { message } = await body(req);
    if (!message) throw new Error("message is required");
    return serial(() => askBudi(message));
  },
  "POST /api/scenario": async (req) => {
    const { id } = await body(req);
    return serial(() => runScenario(id));
  },
};

createServer(async (req, res) => {
  const path = (req.url ?? "/").split("?")[0];
  if (req.method === "GET" && (path === "/" || path === "/index.html")) {
    return send(res, 200, readFileSync(new URL("../../dashboard/index.html", import.meta.url), "utf8"), "text/html; charset=utf-8");
  }
  const handler = routes[`${req.method} ${path}`];
  if (!handler) return send(res, 404, { error: "not found" });
  try {
    send(res, 200, await handler(req));
  } catch (e) {
    send(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Trickproof dashboard: http://localhost:${PORT}  (brain: ${brain})`));
