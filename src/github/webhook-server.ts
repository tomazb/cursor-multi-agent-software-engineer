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
  onDiagnostic?: (error: unknown) => void;
}

const SAFE_DELIVERY_ID = /^[A-Za-z0-9._-]+$/;
const safeDiagnostic = (_error: unknown): void => undefined;

function singleHeader(req: IncomingMessage, name: string): string | undefined {
  const distinctValues = req.headersDistinct?.[name];
  if (distinctValues !== undefined) {
    if (distinctValues.length !== 1) return undefined;
    const [value] = distinctValues;
    if (typeof value !== "string" || !value.trim()) return undefined;
    return value;
  }

  const value = req.headers[name];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value;
}

function invalidWebhookHeaders(res: ServerResponse): void {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: false, message: "invalid webhook headers" }));
}

function emitDiagnostic(onDiagnostic: ((error: unknown) => void) | undefined, error: unknown): void {
  try {
    (onDiagnostic ?? safeDiagnostic)(error);
  } catch {
    // Diagnostics must not alter the unauthenticated HTTP response.
  }
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
      const deliveryId = singleHeader(req, "x-github-delivery");
      const eventName = singleHeader(req, "x-github-event");
      const signatureHeader = singleHeader(req, "x-hub-signature-256");
      if (!deliveryId || !eventName || !signatureHeader || !SAFE_DELIVERY_ID.test(deliveryId)) {
        invalidWebhookHeaders(res);
        return;
      }
      const rawBody = await readRawBody(req, maxBodyBytes);
      const result = await options.adapter.handleWebhook({
        deliveryId,
        eventName,
        signatureHeader,
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
      emitDiagnostic(options.onDiagnostic, error);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "internal server error" }));
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
