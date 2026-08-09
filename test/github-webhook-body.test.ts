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

test("readRawBody rejects bodies larger than the one MiB default", async () => {
  const stream = Readable.from([Buffer.alloc(DEFAULT_WEBHOOK_MAX_BODY_BYTES + 1)]);
  await assert.rejects(
    () => readRawBody(asIncomingMessage(stream)),
    (error: unknown) => {
      assert.ok(error instanceof WebhookBodyTooLargeError);
      return true;
    },
  );
});
