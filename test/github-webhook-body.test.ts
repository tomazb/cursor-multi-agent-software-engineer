import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import {
  DEFAULT_WEBHOOK_MAX_BODY_BYTES,
  readRawBody,
  WebhookBodyTooLargeError,
} from "../src/github/webhook-server.ts";

function asIncomingMessage(stream: Readable): IncomingMessage {
  return stream as unknown as IncomingMessage;
}

test("readRawBody accepts bodies under the limit", async () => {
  const stream = Readable.from([Buffer.from("ok")]);
  const body = await readRawBody(asIncomingMessage(stream), 1024);
  assert.equal(body, "ok");
});

test("readRawBody rejects oversized bodies", async () => {
  const stream = Readable.from([Buffer.from("0123456789abcdef")]);
  await assert.rejects(
    () => readRawBody(asIncomingMessage(stream), 8),
    (error: unknown) => {
      assert.ok(error instanceof WebhookBodyTooLargeError);
      return true;
    },
  );
  assert.ok(DEFAULT_WEBHOOK_MAX_BODY_BYTES >= 1024);
});
