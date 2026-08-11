import { createHash } from "node:crypto";
import { isSafeGitHubDeliveryId } from "./delivery-id.ts";
import { normalizeGitHubWebhook } from "./normalize.ts";
import { verifyGitHubWebhookSignature } from "./signature.ts";
import {
  MalformedGitHubWebhookError,
  UnsupportedGitHubWebhookError,
  type GitHubInternalEvent,
} from "./types.ts";

export interface WebhookRequest {
  deliveryId: string;
  eventName: string;
  signatureHeader: string | undefined;
  rawBody: string | Buffer;
}

export interface WebhookHandleResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; message?: string };
}

export type PreparedWebhookRequest =
  | { kind: "reject"; result: WebhookHandleResult }
  | {
      kind: "unsupported";
      deliveryId: string;
      eventName: string;
      receivedAt: string;
      rawBodyDigest: string;
    }
  | {
      kind: "event";
      deliveryId: string;
      eventName: string;
      receivedAt: string;
      rawBodyDigest: string;
      event: GitHubInternalEvent;
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Authenticate exact bytes and normalize before the caller may mutate durable state. */
export function prepareWebhookRequest(
  request: WebhookRequest,
  webhookSecret: string,
): PreparedWebhookRequest {
  if (
    typeof request.deliveryId !== "string" ||
    !request.deliveryId.trim() ||
    typeof request.eventName !== "string" ||
    !request.eventName.trim()
  ) {
    return {
      kind: "reject",
      result: {
        status: 400,
        body: { ok: false, message: "missing delivery or event headers" },
      },
    };
  }
  if (!isSafeGitHubDeliveryId(request.deliveryId)) {
    return {
      kind: "reject",
      result: { status: 400, body: { ok: false, message: "invalid delivery id" } },
    };
  }
  const rawBody = typeof request.rawBody === "string"
    ? Buffer.from(request.rawBody, "utf8")
    : request.rawBody;
  if (!verifyGitHubWebhookSignature(webhookSecret, rawBody, request.signatureHeader)) {
    return {
      kind: "reject",
      result: { status: 401, body: { ok: false, message: "invalid signature" } },
    };
  }
  const receivedAt = new Date().toISOString();
  const rawBodyDigest = `sha256:${createHash("sha256").update(rawBody).digest("hex")}`;
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawBody);
  } catch {
    return {
      kind: "reject",
      result: { status: 400, body: { ok: false, message: "invalid UTF-8 body" } },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded) as unknown;
  } catch {
    return {
      kind: "reject",
      result: { status: 400, body: { ok: false, message: "invalid JSON body" } },
    };
  }
  if (!isRecord(parsed)) {
    return {
      kind: "reject",
      result: {
        status: 400,
        body: { ok: false, message: "webhook payload must be a JSON object" },
      },
    };
  }

  try {
    return {
      kind: "event",
      deliveryId: request.deliveryId,
      eventName: request.eventName,
      receivedAt,
      rawBodyDigest,
      event: normalizeGitHubWebhook({
        deliveryId: request.deliveryId,
        eventName: request.eventName,
        payload: parsed,
        receivedAt,
      }),
    };
  } catch (error) {
    if (error instanceof UnsupportedGitHubWebhookError) {
      return {
        kind: "unsupported",
        deliveryId: request.deliveryId,
        eventName: request.eventName,
        receivedAt,
        rawBodyDigest,
      };
    }
    if (error instanceof MalformedGitHubWebhookError) {
      return {
        kind: "reject",
        result: { status: 400, body: { ok: false, message: error.message } },
      };
    }
    throw error;
  }
}
