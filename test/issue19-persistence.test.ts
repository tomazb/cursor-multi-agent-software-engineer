import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { renderRun } from "../src/run-rendering.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  AgentRuntime,
  MasweConfig,
  RuntimeDoctorResult,
  RuntimeRequest,
  RuntimeResult,
} from "../src/domain.ts";
import { sanitizeDurableRuntimeFailureSummary } from "../src/failure-diagnostics.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  FAILURE_DIAGNOSTIC_MAX_CODE_POINTS,
} from "../src/redaction.ts";
import { FileRunStore } from "../src/store.ts";
import { spawnFileCaptured } from "./helpers/child-process.ts";

const PERSISTED_CANARY = "ISSUE19_CANARY_PERSISTED_SECRET";
const FINE_GRAINED_PAT =
  "github_pat_11SYNTHETICPERSISTENCEONLY_abcdefghijklmnopqrstuvwxyz0123456789";
const MODELS = [
  "cursor-grok-4.5-high",
  "gpt-5.6-sol-high",
  "cursor-claude-fable-5-high",
  "cursor-claude-opus-4.8-high",
];
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface ExpectedDurableRuntimeAttempt {
  model: string;
  code: string;
  message: string;
  requestedModel?: string;
  configuredModel?: string;
  exitCode?: number;
  timedOut?: boolean;
  durationMs?: number;
  promptTransport?: string;
  stderrPresent: boolean;
  truncated: boolean;
}

interface ExpectedDurableRuntimeSummary {
  attempts: ExpectedDurableRuntimeAttempt[];
  totalAttempts: number;
  omittedAttempts: number;
  aggregateTruncated: boolean;
}

function runtimeSummary(run: unknown): ExpectedDurableRuntimeSummary | undefined {
  return (
    run as {
      failure?: { runtime?: ExpectedDurableRuntimeSummary };
    }
  ).failure?.runtime;
}

test("durable runtime metadata bounds inspection of malformed attempt arrays", () => {
  const attempts = Array.from({ length: 100 }, () => null);
  Object.defineProperty(attempts, 8, {
    get() {
      throw new Error("attempt sanitizer scanned beyond its durable bound");
    },
  });

  const summary = sanitizeDurableRuntimeFailureSummary({
    attempts,
    totalAttempts: 100,
    aggregateTruncated: false,
  });

  assert.deepEqual(summary, {
    attempts: [],
    totalAttempts: 100,
    omittedAttempts: 100,
    aggregateTruncated: false,
  });
});

function issue19Config(rejectModelFallback = false): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.allowDirtyWorkspace = true;
  config.policy.useIsolatedWorktree = false;
  config.policy.rejectModelFallback = rejectModelFallback;
  for (const role of Object.keys(config.roles) as Array<keyof typeof config.roles>) {
    config.roles[role].model = MODELS[0]!;
    config.roles[role].fallbackModels = [];
  }
  config.roles.brainstormer.fallbackModels = MODELS.slice(1);
  return config;
}

class UnsafeFailureRuntime implements AgentRuntime {
  readonly attempts: string[] = [];

  async listModels(): Promise<string[]> {
    return MODELS;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.attempts.push(request.roleConfig.model);
    const secret = `${PERSISTED_CANARY}_${this.attempts.length}`;
    const raw = [
      `provider rejected model ${request.roleConfig.model}`,
      `token=${secret}`,
      "safe retry guidance",
      "😀".repeat(3_000),
    ].join("\n");
    return {
      status: "error",
      output: raw,
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
      failure: {
        code: "runtime-error",
        message: raw,
        requestedModel: request.roleConfig.model,
        exitCode: 23,
        timedOut: false,
        durationMs: 17,
        stderrPresent: true,
        truncated: false,
      },
      metadata: {
        stderr: raw,
        unsafeNested: { token: secret },
      },
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    return { ok: true, checks: [] };
  }
}

class ThrowingFailureRuntime extends UnsafeFailureRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.attempts.push(request.roleConfig.model);
    throw new Error(
      `transport rejected ${request.roleConfig.model} token=${PERSISTED_CANARY}_THROWN`,
    );
  }
}

class FineGrainedPatFailureRuntime extends UnsafeFailureRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.attempts.push(request.roleConfig.model);
    const raw = `provider rejected credential ${FINE_GRAINED_PAT}`;
    return {
      status: "error",
      output: raw,
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
      failure: {
        code: "runtime-error",
        message: raw,
        requestedModel: request.roleConfig.model,
        configuredModel: request.roleConfig.model,
        promptTransport: "stdin",
        exitCode: 41,
        timedOut: false,
        durationMs: 29,
        stderrPresent: true,
        truncated: false,
      },
      metadata: {
        diagnostic: raw,
        stderrPresent: true,
      },
    };
  }
}

async function makeProject(
  t: test.TestContext,
  rejectModelFallback = false,
): Promise<{
  cwd: string;
  runtime: UnsafeFailureRuntime;
  store: FileRunStore;
  orchestrator: Orchestrator;
}> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-persist-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = new UnsafeFailureRuntime();
  const config = issue19Config(rejectModelFallback);
  const store = new FileRunStore(cwd);
  return {
    cwd,
    runtime,
    store,
    orchestrator: new Orchestrator(cwd, config, runtime, store),
  };
}

function assertNoCanary(value: unknown): void {
  const serialized = JSON.stringify(value) ?? "";
  assert.equal(
    serialized.includes(PERSISTED_CANARY),
    false,
    "synthetic Issue #19 canary crossed the persistence boundary",
  );
}

async function allFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await allFiles(target)));
    else files.push(target);
  }
  return files;
}

test("unsafe runtime failure is absent from returned state, disk, events, artifacts, and CLI", async (t) => {
  const { cwd, runtime, store, orchestrator } = await makeProject(t);

  const run = await orchestrator.start("Issue 19 persistence", "synthetic request");

  assert.equal(run.state, "FAILED");
  assert.deepEqual(runtime.attempts, MODELS);
  assertNoCanary(run);
  assert.match(run.failure?.message ?? "", /runtime-error/);
  assert.match(run.failure?.message ?? "", /safe retry guidance/);
  assert.match(run.failure?.message ?? "", /cursor-grok-4\.5-high/);
  assert.ok(
    [...(run.failure?.message ?? "")].length <=
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
  );
  for (const event of run.events) assertNoCanary(event.details);

  const runFile = path.join(cwd, ".maswe", "runs", run.id, "run.json");
  const persisted = await readFile(runFile, "utf8");
  assert.equal(persisted.includes(PERSISTED_CANARY), false);
  assert.match(persisted, /safe retry guidance/);

  const files = await allFiles(path.join(cwd, ".maswe", "runs", run.id));
  for (const file of files) {
    const content = await readFile(file, "utf8");
    assert.equal(content.includes(PERSISTED_CANARY), false, `leak in ${file}`);
  }
  assert.equal(run.artifacts.length, 0);

  const loaded = await store.load(run.id);
  for (const cliOutput of [renderRun(loaded), JSON.stringify(loaded, null, 2)]) {
    assert.equal(cliOutput.includes(PERSISTED_CANARY), false);
    assert.match(cliOutput, /runtime-error/);
  }

  assertNoCanary(loaded);
});

test("synthetic fine-grained GitHub PAT is absent from every durable and rendered sink", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-fine-pat-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = issue19Config(true);
  const runtime = new FineGrainedPatFailureRuntime();
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(cwd, config, runtime, store);

  const failed = await orchestrator.start(
    "Issue 19 fine-grained PAT",
    "synthetic request",
  );
  assert.equal(failed.state, "FAILED");
  assert.equal(JSON.stringify(failed).includes(FINE_GRAINED_PAT), false);
  assert.equal(renderRun(failed).includes(FINE_GRAINED_PAT), false);

  const runFile = path.join(
    cwd,
    ".maswe",
    "runs",
    failed.id,
    "run.json",
  );
  assert.equal((await readFile(runFile, "utf8")).includes(FINE_GRAINED_PAT), false);

  for (const json of [false, true]) {
    const result = await spawnFileCaptured(
      process.execPath,
      [
        "--experimental-strip-types",
        cliPath,
        "status",
        failed.id,
        ...(json ? ["--json"] : []),
        "--cwd",
        cwd,
      ],
      { cwd },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.includes(FINE_GRAINED_PAT), false);
    assert.match(result.stdout, /runtime-error/);
  }

  const retried = await orchestrator.retryFromFailed(failed.id);
  assert.equal(retried.state, "FAILED");
  assert.equal(JSON.stringify(retried).includes(FINE_GRAINED_PAT), false);
  const retry = retried.events.find(
    (event) => event.type === "RETRY_FROM_FAILED",
  );
  assert.ok(retry);
  assert.equal(JSON.stringify(retry).includes(FINE_GRAINED_PAT), false);
  const previousFailure = (
    retry?.details as {
      previousFailure?: {
        runtime?: ExpectedDurableRuntimeSummary;
      };
    }
  )?.previousFailure;
  assert.equal(
    previousFailure?.runtime?.attempts[0]?.exitCode,
    41,
  );

  const replacement = await orchestrator.supersede(retried.id);
  const superseded = await store.load(retried.id);
  assert.equal(JSON.stringify(superseded).includes(FINE_GRAINED_PAT), false);
  assert.equal(JSON.stringify(replacement).includes(FINE_GRAINED_PAT), false);
  assert.equal(runtimeSummary(superseded)?.attempts[0]?.exitCode, 41);

  for (const runId of [superseded.id, replacement.id]) {
    const files = await allFiles(path.join(cwd, ".maswe", "runs", runId));
    for (const file of files) {
      assert.equal(
        (await readFile(file, "utf8")).includes(FINE_GRAINED_PAT),
        false,
        `fine-grained PAT leaked in ${file}`,
      );
    }
  }
});

test("one runtime attempt retains the bounded structured durable subset", async (t) => {
  const { orchestrator } = await makeProject(t, true);

  const run = await orchestrator.start(
    "Issue 19 one structured attempt",
    "synthetic request",
  );
  const summary = runtimeSummary(run);

  assert.ok(summary);
  assert.equal(summary.totalAttempts, 1);
  assert.equal(summary.omittedAttempts, 0);
  assert.equal(summary.aggregateTruncated, false);
  assert.equal(summary.attempts.length, 1);
  assert.deepEqual(
    {
      model: summary.attempts[0]?.model,
      code: summary.attempts[0]?.code,
      requestedModel: summary.attempts[0]?.requestedModel,
      exitCode: summary.attempts[0]?.exitCode,
      timedOut: summary.attempts[0]?.timedOut,
      durationMs: summary.attempts[0]?.durationMs,
      stderrPresent: summary.attempts[0]?.stderrPresent,
      truncated: summary.attempts[0]?.truncated,
    },
    {
      model: MODELS[0],
      code: "runtime-error",
      requestedModel: MODELS[0],
      exitCode: 23,
      timedOut: false,
      durationMs: 17,
      stderrPresent: true,
      truncated: true,
    },
  );
  assertNoCanary(summary);
});

test("fallback failures retain structured metadata for every stored attempt and FAIL details", async (t) => {
  const { orchestrator } = await makeProject(t);

  const run = await orchestrator.start(
    "Issue 19 several structured attempts",
    "synthetic request",
  );
  const summary = runtimeSummary(run);

  assert.ok(summary);
  assert.equal(summary.totalAttempts, MODELS.length);
  assert.equal(summary.omittedAttempts, 0);
  assert.equal(summary.aggregateTruncated, true);
  assert.deepEqual(
    summary.attempts.map((attempt) => attempt.model),
    MODELS,
  );
  assert.ok(
    summary.attempts.every(
      (attempt) =>
        attempt.exitCode === 23 &&
        attempt.timedOut === false &&
        attempt.durationMs === 17 &&
        attempt.stderrPresent === true,
    ),
  );
  const fail = run.events.findLast((event) => event.type === "FAIL");
  assert.deepEqual(
    (fail?.details as { runtime?: ExpectedDurableRuntimeSummary } | undefined)
      ?.runtime,
    summary,
  );
  assertNoCanary(fail?.details);
});

test("retry history re-sanitizes previousFailure before persistence", async (t) => {
  const { cwd, store, orchestrator } = await makeProject(t, true);
  const failed = await orchestrator.start("Issue 19 retry", "synthetic request");
  failed.failure!.message = `manually unsafe token=${PERSISTED_CANARY}_RETRY`;
  await store.save(failed);

  const retried = await orchestrator.retryFromFailed(failed.id);

  assert.equal(retried.state, "FAILED");
  assertNoCanary(retried);
  const retry = retried.events.find((event) => event.type === "RETRY_FROM_FAILED");
  assert.ok(retry);
  assertNoCanary(retry?.details);
  assert.match(JSON.stringify(retry?.details), /\[REDACTED\]/);
  const persisted = await readFile(
    path.join(cwd, ".maswe", "runs", failed.id, "run.json"),
    "utf8",
  );
  assert.equal(persisted.includes(PERSISTED_CANARY), false);
});

test("single-model rejection uses the same bounded safe contract", async (t) => {
  const { runtime, orchestrator } = await makeProject(t, true);

  const run = await orchestrator.start("Issue 19 single model", "synthetic request");

  assert.equal(run.state, "FAILED");
  assert.deepEqual(runtime.attempts, [MODELS[0]]);
  assertNoCanary(run);
  assert.match(run.failure?.message ?? "", /cursor-grok-4\.5-high/);
  assert.match(run.failure?.message ?? "", /runtime-error/);
  assert.ok(
    [...(run.failure?.message ?? "")].length <=
      FAILURE_AGGREGATE_MAX_CODE_POINTS,
  );
});

test("FileRunStore sanitizes unsafe failure and retry event callers", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-store-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("unsafe caller", "request", issue19Config(true));
  run.failure = {
    message: `unsafe token=${PERSISTED_CANARY}_STORE`,
    at: new Date().toISOString(),
    resumeState: "BRAINSTORMING",
  };

  await store.applyEvent(run, "FAIL", "unsafe-caller", {
    reason: `unsafe token=${PERSISTED_CANARY}_EVENT`,
    resumeState: "BRAINSTORMING",
  });

  const failed = await store.load(run.id);
  assertNoCanary(failed);
  assert.match(failed.failure?.message ?? "", /\[REDACTED\]/);
  assert.match(
    String(failed.events.at(-1)?.details?.reason ?? ""),
    /\[REDACTED\]/,
  );
  const previousFailure = {
    message: `unsafe token=${PERSISTED_CANARY}_PREVIOUS`,
    at: new Date().toISOString(),
    resumeState: "BRAINSTORMING" as const,
  };
  delete failed.failure;
  await store.applyEvent(failed, "RETRY_FROM_FAILED", "unsafe-caller", {
    resumeState: "BRAINSTORMING",
    previousFailure,
  });

  const retried = await store.load(run.id);
  assertNoCanary(retried);
  assert.match(
    JSON.stringify(retried.events.at(-1)?.details),
    /\[REDACTED\]/,
  );
});

function guardedMalformedAttempts(): unknown[] {
  const attempts = Array.from({ length: 100 }, () => null);
  Object.defineProperty(attempts, 8, {
    get() {
      throw new Error("event sanitizer cloned beyond its durable bound");
    },
  });
  return attempts;
}

test("FAIL event sanitizes runtime attempts before cloning details", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-fail-event-bound-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("bounded FAIL event", "request", issue19Config(true));

  const failed = await store.applyEvent(run, "FAIL", "test", {
    reason: "runtime exhausted",
    runtime: {
      attempts: guardedMalformedAttempts(),
      totalAttempts: 100,
      aggregateTruncated: false,
    },
  });

  const runtime = failed.events.at(-1)?.details?.runtime as
    | ExpectedDurableRuntimeSummary
    | undefined;
  assert.ok(runtime);
  assert.equal(runtime.attempts.length, 0);
  assert.equal(runtime.omittedAttempts, 100);
});

test("retry event sanitizes runtime attempts before cloning previous failure", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-retry-event-bound-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("bounded retry event", "request", issue19Config(true));
  const failed = await store.applyEvent(run, "FAIL", "test", {
    reason: "runtime exhausted",
  });

  const retried = await store.applyEvent(failed, "RETRY_FROM_FAILED", "test", {
    resumeState: "BRAINSTORMING",
    previousFailure: {
      message: "runtime exhausted",
      at: new Date().toISOString(),
      runtime: {
        attempts: guardedMalformedAttempts(),
        totalAttempts: 100,
        aggregateTruncated: false,
      },
    },
  });

  const previous = retried.events.at(-1)?.details?.previousFailure as
    | { runtime?: ExpectedDurableRuntimeSummary }
    | undefined;
  assert.ok(previous?.runtime);
  assert.equal(previous.runtime.attempts.length, 0);
  assert.equal(previous.runtime.omittedAttempts, 100);
});

test("unrelated event details do not require failure-sanitizer cloneability", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-event-details-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create(
    "Issue 19 unrelated details",
    "synthetic request",
    issue19Config(true),
  );
  const details = new Proxy({ note: "preserved" }, {});

  const started = await store.applyEvent(run, "START", "test", details);
  assert.equal(started.events.at(-1)?.details?.note, "preserved");
  assert.equal((await store.load(run.id)).events.at(-1)?.details?.note, "preserved");
});

test("fallback aggregate is bounded while retaining each reachable model identity", async (t) => {
  const { orchestrator } = await makeProject(t);

  const run = await orchestrator.start("Issue 19 bounded fallback", "synthetic request");

  const message = run.failure?.message ?? "";
  assertNoCanary(message);
  assert.ok([...message].length <= FAILURE_AGGREGATE_MAX_CODE_POINTS);
  assert.ok([...message].length > FAILURE_DIAGNOSTIC_MAX_CODE_POINTS);
  for (const model of MODELS) {
    assert.match(message, new RegExp(model.replaceAll(".", "\\.")));
  }
  assert.match(message, /… \[truncated\]$/);
});

test("fallback aggregate reports model attempts omitted after reaching its bound", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-many-fallbacks-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const models = Array.from(
    { length: 12 },
    (_, index) => `synthetic-model-${String(index + 1).padStart(2, "0")}`,
  );
  const config = issue19Config(false);
  config.roles.brainstormer.model = models[0]!;
  config.roles.brainstormer.fallbackModels = models.slice(1);
  const runtime = new (class extends UnsafeFailureRuntime {
    override async listModels(): Promise<string[]> {
      return [...MODELS, ...models];
    }
  })();
  const orchestrator = new Orchestrator(
    cwd,
    config,
    runtime,
    new FileRunStore(cwd),
  );

  const run = await orchestrator.start(
    "Issue 19 many fallbacks",
    "synthetic request",
  );
  const message = run.failure?.message ?? "";

  assert.deepEqual(runtime.attempts, models);
  assertNoCanary(message);
  assert.ok([...message].length <= FAILURE_AGGREGATE_MAX_CODE_POINTS);
  assert.match(message, /8 additional model failures omitted after aggregate limit/);
  const summary = runtimeSummary(run);
  assert.ok(summary);
  assert.equal(summary.totalAttempts, models.length);
  assert.equal(summary.attempts.length, 8);
  assert.equal(summary.omittedAttempts, 4);
  assert.equal(summary.aggregateTruncated, true);
  assert.deepEqual(
    summary.attempts.map((attempt) => attempt.model),
    models.slice(0, 8),
  );
  assertNoCanary(summary);
});

test("model display identity is single-line and cannot impersonate aggregate entries", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-model-frame-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const configuredModel =
    `${MODELS[0]}\r\n\u0000 | forged [runtime-error]: injected`;
  const config = issue19Config(true);
  for (const role of Object.keys(config.roles) as Array<
    keyof typeof config.roles
  >) {
    config.roles[role].model = configuredModel;
    config.roles[role].fallbackModels = [];
  }
  const runtime = new (class extends UnsafeFailureRuntime {
    override async listModels(): Promise<string[]> {
      return [configuredModel];
    }
  })();
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(cwd, config, runtime, store);

  const run = await orchestrator.start(
    "Issue 19 model framing",
    "synthetic request",
  );
  const summary = runtimeSummary(run);
  assert.ok(summary);
  assert.equal(runtime.attempts.length, 1);
  assert.match(runtime.attempts[0] ?? "", /[\r\n\u0000]/);

  const attempt = summary.attempts[0];
  assert.ok(attempt);
  for (const field of [
    attempt.model,
    attempt.requestedModel ?? "",
    attempt.configuredModel ?? "",
  ]) {
    assert.doesNotMatch(field, /[\r\n\u0000-\u001f\u007f-\u009f]/);
    assert.doesNotMatch(field, /\s\|\s|\[[^\]]+\]:/);
  }
  const human = renderRun(run);
  assert.doesNotMatch(human, /\n\s*\|\s*forged/);
  assert.match(
    human,
    /Runtime attempts: 1 total, 1 stored, 0 omitted by durable cap/,
  );
});

test("human and JSON CLI expose structured metadata without credential canaries", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-cli-meta-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = issue19Config(true);
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(
    cwd,
    config,
    new FineGrainedPatFailureRuntime(),
    store,
  );
  const run = await orchestrator.start(
    "Issue 19 CLI metadata",
    "synthetic request",
  );

  const human = await spawnFileCaptured(
    process.execPath,
    [
      "--experimental-strip-types",
      cliPath,
      "status",
      run.id,
      "--cwd",
      cwd,
    ],
    { cwd },
  );
  assert.equal(human.code, 0, human.stderr);
  assert.equal(human.stdout.includes(FINE_GRAINED_PAT), false);
  assert.match(
    human.stdout,
    /Runtime attempts: 1 total, 1 stored, 0 omitted by durable cap/,
  );
  assert.match(human.stdout, /exit=41/);
  assert.match(human.stdout, /transport=stdin/);
  assert.match(human.stdout, /stderr=yes/);

  const json = await spawnFileCaptured(
    process.execPath,
    [
      "--experimental-strip-types",
      cliPath,
      "status",
      run.id,
      "--json",
      "--cwd",
      cwd,
    ],
    { cwd },
  );
  assert.equal(json.code, 0, json.stderr);
  assert.equal(json.stdout.includes(FINE_GRAINED_PAT), false);
  const parsed = JSON.parse(json.stdout);
  const summary = runtimeSummary(parsed);
  assert.ok(summary);
  assert.equal(summary.attempts[0]?.exitCode, 41);
  assert.equal(summary.attempts[0]?.promptTransport, "stdin");
});

test("thrown runtime errors and supersede state use the same safe boundary", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue19-supersede-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = issue19Config(true);
  const runtime = new ThrowingFailureRuntime();
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(cwd, config, runtime, store);

  const original = await orchestrator.start("Issue 19 thrown", "synthetic request");
  assert.equal(original.state, "FAILED");
  assertNoCanary(original);
  assert.match(original.failure?.message ?? "", /transport rejected/);

  const replacement = await orchestrator.supersede(original.id);
  assert.equal(replacement.supersedes, original.id);
  assertNoCanary(replacement);
  assertNoCanary(await store.load(original.id));
  assertNoCanary(await store.load(replacement.id));

  for (const runId of [original.id, replacement.id]) {
    const persisted = await readFile(
      path.join(cwd, ".maswe", "runs", runId, "run.json"),
      "utf8",
    );
    assert.equal(persisted.includes(PERSISTED_CANARY), false);
  }
});
