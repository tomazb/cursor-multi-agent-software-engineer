import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GitHubAppAdapter } from "./adapter.ts";
import { isSafeGitHubDeliveryId } from "./delivery-id.ts";

/** Default max raw webhook body size (1 MiB). */
export const DEFAULT_WEBHOOK_MAX_BODY_BYTES = 1_048_576;
/** Leaves two seconds for GitHub to receive the response before its ten-second cutoff. */
export const DEFAULT_WEBHOOK_INGRESS_TIMEOUT_MS = 8_000;

export class WebhookBodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Webhook body exceeds limit of ${maxBytes} bytes`);
    this.name = "WebhookBodyTooLargeError";
  }
}

export class WebhookIngressDeadlineError extends Error {
  readonly code: "GITHUB_WEBHOOK_INGRESS_NOT_STARTED" | "GITHUB_WEBHOOK_INGRESS_OUTCOME_UNKNOWN";
  readonly handoffStarted: boolean;
  readonly deliveryId: string | undefined;
  readonly eventName: string | undefined;
  readonly attempt = 0;

  constructor(
    handoffStarted: boolean,
    context: { deliveryId?: string; eventName?: string } = {},
  ) {
    super("GitHub webhook ingress deadline exceeded");
    this.name = "WebhookIngressDeadlineError";
    this.handoffStarted = handoffStarted;
    this.code = handoffStarted
      ? "GITHUB_WEBHOOK_INGRESS_OUTCOME_UNKNOWN"
      : "GITHUB_WEBHOOK_INGRESS_NOT_STARTED";
    this.deliveryId = context.deliveryId;
    this.eventName = context.eventName;
  }
}

export async function readRawBody(
  req: IncomingMessage,
  maxBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES,
): Promise<string> {
  return (await readRawBodyBytes(req, maxBytes)).toString("utf8");
}

export async function readRawBodyBytes(
  req: IncomingMessage,
  maxBytes = DEFAULT_WEBHOOK_MAX_BODY_BYTES,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw new WebhookBodyTooLargeError(maxBytes);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export interface WebhookServerOptions {
  adapter: GitHubAppAdapter;
  host?: string;
  port?: number;
  path?: string;
  maxBodyBytes?: number;
  ingressTimeoutMs?: number;
  onDiagnostic?: (error: unknown) => void;
  /** Deterministic listener-start seam for tests. */
  listenServer?: (
    server: Server,
    port: number,
    host: string,
    onListening: () => void,
  ) => void;
}

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
  const ingressTimeoutMs = options.ingressTimeoutMs ?? DEFAULT_WEBHOOK_INGRESS_TIMEOUT_MS;
  if (!Number.isInteger(ingressTimeoutMs) || ingressTimeoutMs < 1 || ingressTimeoutMs >= 10_000) {
    throw new Error("GitHub webhook ingress timeout must be below ten seconds");
  }
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let bodyAborted = false;
    try {
      if (req.method !== "POST" || (req.url ?? "").split("?")[0] !== webhookPath) {
        req.resume();
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, message: "not found" }));
        return;
      }
      const deliveryId = singleHeader(req, "x-github-delivery");
      const eventName = singleHeader(req, "x-github-event");
      const signatureHeader = singleHeader(req, "x-hub-signature-256");
      if (!deliveryId || !eventName || !signatureHeader || !isSafeGitHubDeliveryId(deliveryId)) {
        req.resume();
        invalidWebhookHeaders(res);
        return;
      }
      let timedOut = false;
      let handoffStarted = false;
      const ingress = (async () => {
        const rawBody = await readRawBodyBytes(req, maxBodyBytes);
        handoffStarted = true;
        return options.adapter.handleWebhook({
          deliveryId,
          eventName,
          signatureHeader,
          rawBody,
        });
      })();
      void ingress.catch((error) => {
        if (timedOut && !bodyAborted) emitDiagnostic(options.onDiagnostic, error);
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        ingress,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(new WebhookIngressDeadlineError(handoffStarted, { deliveryId, eventName }));
          }, ingressTimeoutMs);
          timer.unref();
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
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
      if (error instanceof WebhookIngressDeadlineError) {
        if (!error.handoffStarted) {
          bodyAborted = true;
          req.destroy();
        }
        emitDiagnostic(options.onDiagnostic, error);
        if (!res.headersSent) {
          res.writeHead(503, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, message: "durable webhook handoff unavailable" }));
        } else if (!res.writableEnded) {
          res.end();
        }
        return;
      }
      emitDiagnostic(options.onDiagnostic, error);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, message: "internal server error" }));
    }
  });
  server.requestTimeout = ingressTimeoutMs;
  server.on("error", (error) => emitDiagnostic(options.onDiagnostic, error));
  return server;
}

export async function listenWebhookServer(
  options: WebhookServerOptions,
): Promise<{ server: Server; url: string }> {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const server = createWebhookServer(options);
  await new Promise<void>((resolve, reject) => {
    const startupError = (error: Error) => reject(error);
    server.once("error", startupError);
    const onListening = () => {
      server.off("error", startupError);
      resolve();
    };
    if (options.listenServer) options.listenServer(server, port, host, onListening);
    else server.listen(port, host, onListening);
  });
  return { server, url: `http://${host}:${port}${options.path ?? "/github/webhook"}` };
}
