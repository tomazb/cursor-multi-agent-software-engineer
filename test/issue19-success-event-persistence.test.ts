import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  AgentRuntime,
  MasweConfig,
  RuntimeDoctorResult,
  RuntimeFinishedResult,
  RuntimeRequest,
  RuntimeResult,
  WorkflowEventType,
} from "../src/domain.ts";
import {
  normalizeModelDisplay,
  normalizeRuntimeIdentifierDisplay,
} from "../src/failure-diagnostics.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { renderRun } from "../src/run-rendering.ts";
import { FileRunStore } from "../src/store.ts";

const SAFE_EXECUTION_MODEL = "safe-execution-model";
const SUCCESS_CREDENTIAL_CANARY =
  "github_pat_11SUCCESSDISPLAYONLY_abcdefghijklmnopqrstuvwxyz0123456789";
const HOSTILE_MODEL_DISPLAY =
  `safe-model-prefix\r\n\u0000\u0085\u2028\u2029\u202e\u2066 ${SUCCESS_CREDENTIAL_CANARY}` +
  " | forged [runtime-error]: safe-model-suffix";
const HOSTILE_AGENT_DISPLAY =
  `safe-agent-prefix\r\n\u0000\u0085\u2028\u2029\u202d\u2067 ${SUCCESS_CREDENTIAL_CANARY}` +
  " | forged [agent]: safe-agent-suffix";
const HOSTILE_RUN_DISPLAY =
  `safe-run-prefix\r\n\u0000\u0085\u2028\u2029\u202c\u2069 ${SUCCESS_CREDENTIAL_CANARY}` +
  " | forged [run]: safe-run-suffix";
const IDENTITY_EVENTS: WorkflowEventType[] = [
  "BRAINSTORM_COMPLETED",
  "DESIGN_COMPLETED",
  "BUILD_COMPLETED",
  "VERIFY_PASSED",
  "VERIFY_PASSED_AFTER_REVIEW",
  "VERIFY_FAILED",
  "RESOLUTION_COMPLETED",
];
const PROHIBITED_DISPLAY_CONTROLS =
  /[\r\n\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

function successConfig(): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.allowDirtyWorkspace = true;
  config.policy.useIsolatedWorktree = false;
  config.policy.rejectModelFallback = true;
  config.policy.maxBuildVerifyCycles = 3;
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.gates.requireCiPass = true;
  config.gates.requireVerifierPass = true;
  config.quality.commands = [];
  for (const role of Object.values(config.roles)) {
    role.model = SAFE_EXECUTION_MODEL;
    role.fallbackModels = [];
  }
  return config;
}

class HostileSuccessfulRuntime implements AgentRuntime {
  readonly invocationModels: string[] = [];
  private verifierCalls = 0;

  async listModels(): Promise<string[]> {
    return [SAFE_EXECUTION_MODEL];
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.invocationModels.push(request.roleConfig.model);
    const classifying = request.prompt.includes(
      "Role: PR comment scope classifier",
    );
    let marker: string;
    if (classifying) {
      marker = "SCOPE: IN_SCOPE";
    } else if (request.role === "brainstormer") {
      marker = "READY_FOR_BRAINSTORM_APPROVAL";
    } else if (request.role === "designer") {
      marker = "READY_FOR_DESIGN_APPROVAL";
    } else if (request.role === "builder") {
      marker = "BUILD_COMPLETE";
    } else if (request.role === "verifier") {
      this.verifierCalls += 1;
      marker = this.verifierCalls === 1 ? "VERDICT: FAIL" : "VERDICT: PASS";
    } else {
      marker = "RESOLUTION_COMPLETE";
    }
    return {
      status: "finished",
      output: `safe ${request.role} output\n${marker}\n`,
      requestedModel: HOSTILE_MODEL_DISPLAY,
      actualModel: HOSTILE_MODEL_DISPLAY,
      agentId: HOSTILE_AGENT_DISPLAY,
      runId: HOSTILE_RUN_DISPLAY,
    };
  }

  async doctor(): Promise<RuntimeDoctorResult> {
    return { ok: true, checks: [] };
  }
}

class NormalizationCollisionRuntime extends HostileSuccessfulRuntime {
  override async execute(
    request: RuntimeRequest,
  ): Promise<RuntimeFinishedResult> {
    this.invocationModels.push(request.roleConfig.model);
    return {
      status: "finished",
      output: "safe brainstorm output\nREADY_FOR_BRAINSTORM_APPROVAL\n",
      requestedModel: "collision[identity]",
      actualModel: "collision(identity)",
    };
  }
}

function assertSafeDisplay(
  value: unknown,
  prefix: string,
  suffix: string,
): void {
  assert.equal(typeof value, "string");
  const display = value as string;
  assert.doesNotMatch(display, PROHIBITED_DISPLAY_CONTROLS);
  assert.equal(display.includes(SUCCESS_CREDENTIAL_CANARY), false);
  assert.equal(display.includes(" | "), false);
  assert.equal(display.includes("["), false);
  assert.equal(display.includes("]"), false);
  assert.ok([...display].length <= 256);
  assert.match(display, new RegExp(prefix));
  assert.match(display, new RegExp(suffix));
}

function assertSafeIdentityEvents(run: {
  events: Array<{
    type: WorkflowEventType;
    details?: Record<string, unknown>;
  }>;
}): void {
  for (const eventType of IDENTITY_EVENTS) {
    const matching = run.events.filter((event) => event.type === eventType);
    assert.ok(matching.length > 0, `${eventType} must be exercised`);
    for (const event of matching) {
      assertSafeDisplay(
        event.details?.requestedModel,
        "safe-model-prefix",
        "safe-model-suffix",
      );
      assertSafeDisplay(
        event.details?.actualModel,
        "safe-model-prefix",
        "safe-model-suffix",
      );
      assertSafeDisplay(
        event.details?.agentId,
        "safe-agent-prefix",
        "safe-agent-suffix",
      );
      assertSafeDisplay(
        event.details?.runtimeRunId,
        "safe-run-prefix",
        "safe-run-suffix",
      );
    }
  }
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

function assertNoRawIdentity(value: unknown): void {
  const serialized =
    typeof value === "string" ? value : (JSON.stringify(value) ?? "");
  for (const canary of [
    HOSTILE_MODEL_DISPLAY,
    HOSTILE_AGENT_DISPLAY,
    HOSTILE_RUN_DISPLAY,
    SUCCESS_CREDENTIAL_CANARY,
  ]) {
    assert.equal(
      serialized.includes(canary),
      false,
      `raw successful-event identity crossed persistence: ${JSON.stringify(canary)}`,
    );
  }
}

test("all successful workflow events persist only bounded runtime identity display copies", async (t) => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "maswe-issue19-success-events-"),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = new HostileSuccessfulRuntime();
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(
    cwd,
    successConfig(),
    runtime,
    store,
  );

  let run = await orchestrator.start(
    "Successful event identity framing",
    "Exercise every successful runtime-backed event.",
  );
  assert.equal(run.state, "PR_READY");
  run = await orchestrator.markPrOpened(run.id);
  run = await orchestrator.receiveReviewComment(
    run.id,
    "Resolve this in-scope synthetic review comment.",
  );
  assert.equal(run.state, "PR_REVIEW");

  assert.ok(
    runtime.invocationModels.length > 0 &&
      runtime.invocationModels.every(
        (model) => model === SAFE_EXECUTION_MODEL,
      ),
    "runtime invocation must retain the configured exact identifier",
  );
  assertSafeIdentityEvents(run);
  assertNoRawIdentity(run);
  assertNoRawIdentity(renderRun(run));
  assertNoRawIdentity(JSON.stringify(run, null, 2));

  const runFile = path.join(cwd, ".maswe", "runs", run.id, "run.json");
  const persisted = await readFile(runFile, "utf8");
  assertNoRawIdentity(persisted);
  const loaded = await store.load(run.id);
  assertSafeIdentityEvents(loaded);
  assertNoRawIdentity(loaded);

  const replacement = await orchestrator.supersede(run.id);
  const superseded = await store.load(run.id);
  for (const record of [superseded, replacement]) {
    assertNoRawIdentity(record);
    assertNoRawIdentity(renderRun(record));
    assertNoRawIdentity(JSON.stringify(record, null, 2));
    for (const file of await allFiles(
      path.join(cwd, ".maswe", "runs", record.id),
    )) {
      assertNoRawIdentity(await readFile(file, "utf8"));
    }
  }
  assertSafeIdentityEvents(superseded);
});

test("exact-model enforcement compares raw runtime identities before display normalization", async (t) => {
  const cwd = await mkdtemp(
    path.join(os.tmpdir(), "maswe-issue19-raw-model-check-"),
  );
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const runtime = new NormalizationCollisionRuntime();
  const orchestrator = new Orchestrator(
    cwd,
    successConfig(),
    runtime,
    new FileRunStore(cwd),
  );

  const run = await orchestrator.start(
    "Raw model identity check",
    "Normalization-equivalent runtime identities must still mismatch.",
  );

  assert.equal(run.state, "FAILED");
  assert.deepEqual(runtime.invocationModels, [SAFE_EXECUTION_MODEL]);
  assert.match(run.failure?.message ?? "", /runtime reported/i);
});

test("runtime identity display policies preserve ordinary identifiers and are idempotent", () => {
  assert.equal(
    normalizeModelDisplay("gpt-5.6-sol-high"),
    "gpt-5.6-sol-high",
  );
  assert.equal(
    normalizeRuntimeIdentifierDisplay("agent-run_123"),
    "agent-run_123",
  );

  const modelOnce = normalizeModelDisplay(HOSTILE_MODEL_DISPLAY);
  const agentOnce = normalizeRuntimeIdentifierDisplay(HOSTILE_AGENT_DISPLAY);
  assert.equal(normalizeModelDisplay(modelOnce), modelOnce);
  assert.equal(normalizeRuntimeIdentifierDisplay(agentOnce), agentOnce);
});
