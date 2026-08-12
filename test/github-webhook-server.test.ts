import assert from "node:assert/strict";
import { once } from "node:events";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import type {
  GitHubAppAdapter,
  WebhookHandleResult,
  WebhookRequest,
} from "../src/github/adapter.ts";
import {
  createWebhookServer,
  listenWebhookServer,
  WebhookIngressDeadlineError,
  type WebhookServerOptions,
} from "../src/github/webhook-server.ts";

interface HttpResponse {
  status: number;
  body: string;
}

interface RecordingAdapter {
  adapter: GitHubAppAdapter;
  calls: WebhookRequest[];
}

interface DispatchOptions {
  headersDistinct?: Record<string, string[]> | undefined;
  body?: string | Readable;
  method?: string;
  url?: string;
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
  requestOptions: DispatchOptions = {},
): Promise<HttpResponse> {
  const server = createWebhookServer(options);
  const headersDistinct = Object.hasOwn(requestOptions, "headersDistinct")
    ? requestOptions.headersDistinct
    : defaultDistinctHeaders(headers);
  const body = requestOptions.body ?? "{}";
  const request = Object.assign(typeof body === "string" ? Readable.from([Buffer.from(body)]) : body, {
    method: requestOptions.method ?? "POST",
    url: requestOptions.url ?? "/github/webhook",
    headers,
    headersDistinct,
  }) as unknown as IncomingMessage;

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
      headersDistinct: { ...defaultDistinctHeaders(headers), [header]: ["first", "second"] },
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
    headersDistinct: { ...defaultDistinctHeaders(headers), "x-hub-signature-256": ["first", "second"] },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }));
  assert.deepEqual(fake.calls, []);
});

test("webhook rejects an unsafe delivery id before adapter dispatch", async () => {
  const fake = recordingAdapter();
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    { ...validHeaders, "x-github-delivery": "unsafe/id" },
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

test("webhook retains the default one MiB body limit across streamed chunks", async () => {
  const fake = recordingAdapter();
  const chunks = [
    Buffer.alloc(524_288),
    Buffer.alloc(524_289),
    Buffer.from("transport-drain-after-limit"),
  ];
  const body = new Readable({
    read() {
      this.push(chunks.shift() ?? null);
    },
  });
  const drained = once(body, "end");
  const response = await dispatchWebhook({ adapter: fake.adapter }, validHeaders, { body });
  await drained;

  assert.equal(response.status, 413);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "Webhook body exceeds limit of 1048576 bytes" }));
  assert.deepEqual(fake.calls, []);
  assert.equal(chunks.length, 0);
  assert.equal(body.readableLength, 0);
});

test("webhook rejects array-valued fallback headers before adapter dispatch", async () => {
  for (const header of ["x-github-delivery", "x-github-event", "x-hub-signature-256"] as const) {
    const fake = recordingAdapter();
    const response = await dispatchWebhook(
      { adapter: fake.adapter },
      { ...validHeaders, [header]: ["first", "second"] },
      { headersDistinct: undefined },
    );

    assert.equal(response.status, 400, header);
    assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }), header);
    assert.deepEqual(fake.calls, [], header);
  }
});

test("webhook rejects a missing signature header before adapter dispatch", async () => {
  const fake = recordingAdapter();
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    { "x-github-delivery": "delivery-1", "x-github-event": "push" },
  );

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid webhook headers" }));
  assert.deepEqual(fake.calls, []);
});

test("webhook forwards the exact request bytes without UTF-8 replacement", async () => {
  const bytes = Buffer.from([0x7b, 0xff, 0x7d]);
  const fake = recordingAdapter({
    status: 400,
    body: { ok: false, message: "invalid UTF-8 body" },
  });
  const response = await dispatchWebhook({ adapter: fake.adapter }, validHeaders, {
    body: Readable.from([bytes]),
  });

  assert.equal(response.status, 400);
  assert.ok(Buffer.isBuffer(fake.calls[0]?.rawBody));
  assert.deepEqual(fake.calls[0]?.rawBody, bytes);
});

test("webhook returns 503 within one ingress deadline when body receipt stalls", async () => {
  const diagnostics: unknown[] = [];
  const body = new Readable({ read() {} });
  const fake = recordingAdapter();
  const started = Date.now();

  const response = await dispatchWebhook(
    {
      adapter: fake.adapter,
      ingressTimeoutMs: 25,
      onDiagnostic: (error) => diagnostics.push(error),
    },
    validHeaders,
    { body },
  );

  assert.equal(response.status, 503);
  assert.ok(Date.now() - started < 500);
  assert.deepEqual(fake.calls, []);
  assert.equal(diagnostics.length, 1);
  assert.equal((diagnostics[0] as WebhookIngressDeadlineError).code, "GITHUB_WEBHOOK_INGRESS_NOT_STARTED");
  assert.equal(body.destroyed, true);
});

test("webhook ingress deadline includes the durable adapter handoff", async () => {
  const diagnostics: unknown[] = [];
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let finishLate!: () => void;
  const lateFinished = new Promise<void>((resolve) => { finishLate = resolve; });
  let durable = false;
  const fake = recordingAdapter();
  fake.adapter.handleWebhook = async () => {
    if (!durable) {
      await blocked;
      durable = true;
      finishLate();
      return { status: 202, body: { ok: true } };
    }
    return { status: 202, body: { ok: true, duplicate: true } };
  };

  const response = await dispatchWebhook(
    {
      adapter: fake.adapter,
      ingressTimeoutMs: 25,
      onDiagnostic: (error) => diagnostics.push(error),
    },
    validHeaders,
  );

  assert.equal(response.status, 503);
  assert.equal(diagnostics.length, 1);
  assert.ok(diagnostics[0] instanceof WebhookIngressDeadlineError);
  assert.equal(
    (diagnostics[0] as WebhookIngressDeadlineError).code,
    "GITHUB_WEBHOOK_INGRESS_OUTCOME_UNKNOWN",
  );
  release();
  await lateFinished;

  const replay = await dispatchWebhook({ adapter: fake.adapter }, validHeaders);
  assert.equal(replay.status, 202);
  assert.equal(JSON.parse(replay.body).duplicate, true);
});

test("webhook drains invalid-header bodies after returning 400", async () => {
  let reads = 0;
  const body = new Readable({
    read() {
      reads += 1;
      this.push(Buffer.from("ignored"));
      this.push(null);
    },
  });
  const drained = Promise.race([
    once(body, "end"),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("invalid-header body was not drained")), 100)),
  ]);
  const fake = recordingAdapter();
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    { "x-github-event": "push", "x-hub-signature-256": validHeaders["x-hub-signature-256"] },
    { body },
  );

  assert.equal(response.status, 400);
  await drained;
  assert.ok(reads > 0);
  assert.deepEqual(fake.calls, []);
});

test("webhook keeps internal failures generic when diagnostics throw", async () => {
  const privateDetail = "MASWE_DIAGNOSTIC_THROW_SECRET";
  const fake = recordingAdapter();
  fake.adapter.handleWebhook = async () => {
    throw new Error(`internal ${privateDetail}`);
  };

  const response = await dispatchWebhook(
    { adapter: fake.adapter, onDiagnostic: () => { throw new Error("diagnostic failed"); } },
    validHeaders,
  );

  assert.equal(response.status, 500);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "internal server error" }));
  assert.doesNotMatch(response.body, /MASWE_DIAGNOSTIC_THROW_SECRET|diagnostic failed/);
});

test("webhook does not rewrite a response after headers were sent", async () => {
  const failure = new Error("failure after response started");
  const diagnostics: unknown[] = [];
  const fake = recordingAdapter();
  fake.adapter.handleWebhook = async () => {
    throw failure;
  };
  const server = createWebhookServer({
    adapter: fake.adapter,
    onDiagnostic: (error) => diagnostics.push(error),
  });
  const request = Object.assign(Readable.from([Buffer.from("{}")]), {
    method: "POST",
    url: "/github/webhook",
    headers: validHeaders,
    headersDistinct: defaultDistinctHeaders(validHeaders),
  }) as unknown as IncomingMessage;
  let ended = 0;
  const response = {
    headersSent: true,
    writableEnded: false,
    writeHead() {
      assert.fail("writeHead must not run after headersSent");
    },
    end(this: { writableEnded: boolean }, chunk?: string | Buffer) {
      assert.equal(chunk, undefined);
      ended += 1;
      this.writableEnded = true;
    },
  } as unknown as ServerResponse;

  server.emit("request", request, response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, 1);
  assert.deepEqual(diagnostics, [failure]);
});

test("listener removes its startup error handler and retains diagnostic handling", async () => {
  const diagnostics: unknown[] = [];
  const fake = recordingAdapter();
  const { server } = await listenWebhookServer({
    adapter: fake.adapter,
    host: "127.0.0.1",
    port: 0,
    onDiagnostic: (error) => diagnostics.push(error),
    listenServer: (_server, _port, _host, onListening) => onListening(),
  });
  assert.equal(server.listenerCount("error"), 1);
  const failure = new Error("post-listen diagnostic");
  server.emit("error", failure);
  assert.deepEqual(diagnostics, [failure]);
});

test("webhook passes adapter-produced bad-request responses through", async () => {
  const fake = recordingAdapter({ status: 400, body: { ok: false, message: "invalid payload" } });
  const response = await dispatchWebhook({ adapter: fake.adapter }, validHeaders);

  assert.equal(response.status, 400);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "invalid payload" }));
  assert.equal(fake.calls.length, 1);
});

test("webhook returns 404 outside its route and drains the request body", async () => {
  const fake = recordingAdapter();
  const body = Readable.from([Buffer.from("ignored-route-body")]);
  const drained = once(body, "end");
  const response = await dispatchWebhook(
    { adapter: fake.adapter },
    validHeaders,
    { url: "/other", body },
  );

  assert.equal(response.status, 404);
  await Promise.race([
    drained,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("not-found body was not drained")), 100)),
  ]);
  assert.equal(response.body, JSON.stringify({ ok: false, message: "not found" }));
  assert.deepEqual(fake.calls, []);
});
