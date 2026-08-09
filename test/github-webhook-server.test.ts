import assert from "node:assert/strict";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  GitHubAppAdapter,
  WebhookHandleResult,
  WebhookRequest,
} from "../src/github/adapter.ts";
import { createWebhookServer, type WebhookServerOptions } from "../src/github/webhook-server.ts";

interface HttpResponse {
  status: number;
  body: string;
}

interface RecordingAdapter {
  adapter: GitHubAppAdapter;
  calls: WebhookRequest[];
}

function recordingAdapter(result: WebhookHandleResult = { status: 200, body: { ok: true } }): RecordingAdapter {
  const calls: WebhookRequest[] = [];
  return {
    adapter: {
      async handleWebhook(input: WebhookRequest): Promise<WebhookHandleResult> {
        calls.push(input);
        return result;
      },
    } as GitHubAppAdapter,
    calls,
  };
}

function defaultDistinctHeaders(headers: IncomingHttpHeaders): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(headers).flatMap(([name, value]) =>
      value === undefined ? [] : [[name, Array.isArray(value) ? value : [value]]],
    ),
  );
}

function dispatchWebhook(
  options: WebhookServerOptions,
  headers: IncomingHttpHeaders,
  headersDistinct = defaultDistinctHeaders(headers),
  body = "{}",
): Promise<HttpResponse> {
  const server = createWebhookServer(options);
  const request = Object.assign(Readable.from([Buffer.from(body)]), {
    method: "POST",
    url: "/github/webhook",
    headers,
    headersDistinct,
  }) as IncomingMessage;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("webhook response timed out")), 1_000);
    let status = 0;
    const chunks: Buffer[] = [];
    const response = {
      writeHead(statusCode: number) {
        status = statusCode;
        return this;
      },
      end(chunk?: string | Buffer) {
        clearTimeout(timeout);
        if (chunk !== undefined) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        resolve({ status, body: Buffer.concat(chunks).toString("utf8") });
      },
    } as unknown as ServerResponse;

    server.emit("request", request, response);
  });
}

const validHeaders = {
  "x-github-delivery": "delivery-1",
  "x-github-event": "push",
  "x-hub-signature-256": "sha256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

test("webhook rejects a missing delivery header before adapter dispatch", async () => {
  const fake = recordingAdapter();
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    { "x-github-event": "push", "x-hub-signature-256": validHeaders["x-hub-signature-256"] },
  );

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }));
  assert.deepEqual(fake.calls, []);
});

test("webhook rejects a missing event header before adapter dispatch", async () => {
  const fake = recordingAdapter();
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    { "x-github-delivery": "delivery-1", "x-hub-signature-256": validHeaders["x-hub-signature-256"] },
  );

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }));
  assert.deepEqual(fake.calls, []);
});

test("webhook rejects empty required headers before adapter dispatch", async () => {
  for (const header of ["x-github-delivery", "x-github-event", "x-hub-signature-256"] as const) {
    const fake = recordingAdapter();
    const response = await dispatchWebhook({ adapter: fake.adapter }, { ...validHeaders, [header]: "" });

    assert.equal(response.status, 400, header);
    assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }), header);
    assert.deepEqual(fake.calls, [], header);
  }
});

test("webhook rejects repeated delivery and event headers before adapter dispatch", async () => {
  for (const header of ["x-github-delivery", "x-github-event"] as const) {
    const fake = recordingAdapter();
    const headers = { ...validHeaders, [header]: "first, second" };
    const response = await dispatchWebhook({ adapter: fake.adapter }, headers, {
      ...defaultDistinctHeaders(headers),
      [header]: ["first", "second"],
    });

    assert.equal(response.status, 400, header);
    assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }), header);
    assert.deepEqual(fake.calls, [], header);
  }
});

test("webhook rejects a repeated signature header before adapter dispatch", async () => {
  const fake = recordingAdapter();
  const headers = { ...validHeaders, "x-hub-signature-256": "first, second" };
  const response = await dispatchWebhook({ adapter: fake.adapter }, headers, {
    ...defaultDistinctHeaders(headers),
    "x-hub-signature-256": ["first", "second"],
  });

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }));
  assert.deepEqual(fake.calls, []);
});

test("webhook rejects an unsafe delivery filename before adapter dispatch", async () => {
  const fake = recordingAdapter();
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    { ...validHeaders, "x-github-delivery": "../../outside" },
  );

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }));
  assert.deepEqual(fake.calls, []);
});

test("webhook redacts internal failures while sending the original error to diagnostics", async () => {
  const secretEnvironmentName = "MASWE_WEBHOOK_PRIVATE_SECRET";
  const failure = new Error(`database exploded; missing ${secretEnvironmentName}`);
  const diagnostics: unknown[] = [];
  const fake = recordingAdapter();
  fake.adapter.handleWebhook = async () => {
    throw failure;
  };

  const response = await dispatchWebhook(
    { adapter: fake.adapter, onDiagnostic: (error) => diagnostics.push(error) },
    validHeaders,
  );

  assert.equal(response.status, 500);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "internal server error" }));
  assert.doesNotMatch(response.body, /database exploded|MASWE_WEBHOOK_PRIVATE_SECRET/);
  assert.deepEqual(diagnostics, [failure]);
});

test("webhook preserves adapter-generated unauthorized responses", async () => {
  const fake = recordingAdapter({ status: 401, body: { ok: false, message: "invalid signature" } });
  const response = await dispatchWebhook({ adapter: fake.adapter }, validHeaders);

  assert.equal(response.status, 401);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid signature" }));
  assert.equal(fake.calls.length, 1);
});

test("webhook retains the body-limit response without adapter dispatch", async () => {
  const fake = recordingAdapter();
  const response = await dispatchWebhook({ adapter: fake.adapter, maxBodyBytes: 8 }, validHeaders, undefined, "123456789");

  assert.equal(response.status, 413);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "Webhook body exceeds limit of 8 bytes" }));
  assert.deepEqual(fake.calls, []);
});
