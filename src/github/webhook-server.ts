import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GitHubAppAdapter } from "./adapter.ts";

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface WebhookServerOptions {
  adapter: GitHubAppAdapter;
  host?: string;
  port?: number;
  path?: string;
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  const webhookPath = options.path ?? "/github/webhook";
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== webhookPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "not found" }));
        return;
      }
      const rawBody = await readRawBody(req);
      const result = await options.adapter.handleWebhook({
        deliveryId: String(req.headers["x-github-delivery"] ?? ""),
        eventName: String(req.headers["x-github-event"] ?? ""),
        signatureHeader:
          typeof req.headers["x-hub-signature-256"] === "string"
            ? req.headers["x-hub-signature-256"]
            : undefined,
        rawBody,
      });
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
}

export async function listenWebhookServer(
  options: WebhookServerOptions,
): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const server = createWebhookServer(options);
  await new Promise<void>((resolve, reject) => {
    server.listen(port, host, () => resolve());
    server.once("error", reject);
  });
  return { server, url: `http://${host}:${port}${options.path ?? "/github/webhook"}` };
}
