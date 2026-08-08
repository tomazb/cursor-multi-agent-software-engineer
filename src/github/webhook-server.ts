import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GitHubAppAdapter } from "./adapter.ts";

/** Default max raw webhook body size (1 MiB). */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1_048_576;

export class WebhookBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Webhook body exceeds limit of ${maxBytes} bytes`);
    this.name = "WebhookBodyTooLargeError";
  }
}

export async function readRawBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new WebhookBodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export interface WebhookServerOptions {
  adapter: GitHubAppAdapter;
  host?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  const webhookPath = options.path ?? "/github/webhook";
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_WEBHOOK_MAX_BODY_BYTES;
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== webhookPath) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "not found" }));
        return;
      }
      const rawBody = await readRawBody(req, maxBodyBytes);
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
      if (error instanceof WebhookBodyTooLargeError) {
        req.resume();
        res.writeHead(413, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: error.message }));
        return;
      }
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
