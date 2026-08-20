import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  AgentRuntime,
  MasweConfig,
  RoleId,
  RunRecord,
  RuntimeDoctorResult,
  RuntimeRequest,
  RuntimeResult,
} from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { PolicyViolationError } from "../src/policy.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";
import { CursorSdkRuntime } from "../src/runtimes/cursor-sdk.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

const execFileAsync = promisify(execFile);
const FALLBACK_MODEL = "cursor-grok-4.5-high";

async function initGitRepo(t: test.TestContext, prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# policy fence\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function policyConfig(
  targetRole: RoleId,
  configure: (config: MasweConfig) => void = () => undefined,
): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = false;
  config.policy.rejectModelFallback = false;
  config.quality.commands = [];
  config.roles[targetRole].fallbackModels = [FALLBACK_MODEL];
  configure(config);
  return config;
}

function isClassifierRequest(request: RuntimeRequest): boolean {
  return request.prompt.includes("Role: PR comment scope classifier");
}

async function advanceToTarget(
  orchestrator: Orchestrator,
  targetRole: RoleId,
): Promise<RunRecord> {
  let run = await orchestrator.start("Policy fence", `Exercise ${targetRole}.`);
  if (targetRole === "designer" && run.state !== "FAILED") {
    run = await orchestrator.approve(run.id, "brainstorm");
  }
  if (targetRole === "prResolver" && run.state !== "FAILED") {
    run = await orchestrator.markPrOpened(run.id);
    run = await orchestrator.receiveReviewComment(run.id, "Please add the missing null case test.");
  }
  return run;
}

function assertPolicyFailure(
  run: RunRecord,
  code:
    | "policy-read-only-workspace-mutation"
    | "policy-read-only-head-moved"
    | "policy-runtime-identity-mismatch",
): void {
  assert.equal(run.state, "FAILED");
  assert.equal(run.failure?.code, code);
  assert.equal(run.failure?.runtime, undefined);
  assert.doesNotMatch(run.failure?.message ?? "", /all configured models|runtime-models-exhausted/i);
  const failEvent = run.events.findLast((event) => event.type === "FAIL");
  assert.equal(failEvent?.details?.code, code);
  assert.equal(failEvent?.details?.runtime, undefined);
}

class RecordingRuntime implements AgentRuntime {
  private readonly delegate = new MockRuntime();
  private readonly executeBehavior: (
    request: RuntimeRequest,
  ) => Promise<RuntimeResult | undefined>;
  readonly requests: RuntimeRequest[] = [];

  constructor(
    executeBehavior: (request: RuntimeRequest) => Promise<RuntimeResult | undefined>,
  ) {
    this.executeBehavior = executeBehavior;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.requests.push(structuredClone(request));
    return (await this.executeBehavior(request)) ?? this.delegate.execute(request);
  }

  doctor(): Promise<RuntimeDoctorResult> {
    return this.delegate.doctor();
  }

  listModels(): Promise<string[]> {
    return this.delegate.listModels();
  }
}

const workspaceFenceCases: Array<{
  role: Exclude<RoleId, "builder">;
  runtimeThrows: boolean;
  testName: string;
}> = [
  {
    role: "brainstormer",
    runtimeThrows: false,
    testName: "brainstormer effective read-only execution is fenced",
  },
  {
    role: "designer",
    runtimeThrows: true,
    testName: "designer mutation followed by a throw remains a read-only policy failure",
  },
  {
    role: "verifier",
    runtimeThrows: false,
    testName: "read-only workspace mutation is policy failure and skips fallback",
  },
  {
    role: "prResolver",
    runtimeThrows: false,
    testName: "read-only PR comment classification is fenced without changing resolver policy",
  },
];

for (const spec of workspaceFenceCases) {
  test(spec.testName, async (t) => {
    const cwd = await initGitRepo(t, `maswe-issue29-${spec.role}-`);
    const config = policyConfig(spec.role, (value) => {
      value.gates.requireBrainstormApproval = spec.role === "designer";
      value.gates.requireDesignApproval = false;
    });
    const runtime = new RecordingRuntime(async (request) => {
      const target = request.role === spec.role &&
        (spec.role !== "prResolver" || isClassifierRequest(request));
      if (!target) return undefined;
      await writeFile(path.join(request.cwd, `${spec.role}-mutation.txt`), "mutated\n", "utf8");
      if (spec.runtimeThrows) throw new Error("provider disconnected after writing");
      return new MockRuntime().execute(request);
    });
    const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), spec.role);

    assertPolicyFailure(run, "policy-read-only-workspace-mutation");
    const targetRequests = runtime.requests.filter((request) =>
      request.role === spec.role &&
      (spec.role !== "prResolver" || isClassifierRequest(request))
    );
    assert.equal(targetRequests.length, 1);
    assert.notEqual(targetRequests[0]?.roleConfig.model, FALLBACK_MODEL);
    assert.equal(targetRequests[0]?.roleConfig.permissions, "read-only");
    if (spec.role === "prResolver") {
      assert.equal(run.config.roles.prResolver.permissions, "workspace-write");
    }
  });
}

test("read-only HEAD movement is distinct and skips fallback", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-head-");
  const config = policyConfig("verifier", (value) => {
    value.gates.requireBrainstormApproval = false;
    value.gates.requireDesignApproval = false;
  });
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "verifier") return undefined;
    await writeFile(path.join(request.cwd, "verifier-commit.txt"), "committed mutation\n", "utf8");
    await execFileAsync("git", ["add", "verifier-commit.txt"], { cwd: request.cwd });
    await execFileAsync("git", ["commit", "-qm", "verifier moved head"], { cwd: request.cwd });
    return new MockRuntime().execute(request);
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "verifier");

  assertPolicyFailure(run, "policy-read-only-head-moved");
  const verifierRequests = runtime.requests.filter((request) => request.role === "verifier");
  assert.equal(verifierRequests.length, 1);
  assert.notEqual(verifierRequests[0]?.roleConfig.model, FALLBACK_MODEL);
});

test("an unreadable captured HEAD is a policy failure and skips fallback", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-unreadable-head-");
  const config = policyConfig("brainstormer");
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "brainstormer") return undefined;
    await rm(path.join(request.cwd, ".git", "HEAD"), { force: true });
    return new MockRuntime().execute(request);
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

  assertPolicyFailure(run, "policy-read-only-head-moved");
  const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
  assert.equal(brainstormRequests.length, 1);
  assert.notEqual(brainstormRequests[0]?.roleConfig.model, FALLBACK_MODEL);
});

for (const wrapper of ["cause", "aggregate"] as const) {
  test(`${wrapper}-wrapped policy violation skips fallback`, async (t) => {
    const cwd = await initGitRepo(t, `maswe-issue29-wrapped-${wrapper}-`);
    const config = policyConfig("brainstormer");
    const runtime = new RecordingRuntime(async (request) => {
      if (request.role !== "brainstormer") return undefined;
      const policyError = new PolicyViolationError(
        "policy-read-only-workspace-mutation",
        "wrapped read-only mutation",
      );
      if (wrapper === "cause") {
        throw new Error("runtime wrapper", { cause: policyError });
      }
      throw new AggregateError(
        [new Error("transport wrapper"), policyError],
        "aggregate runtime wrapper",
      );
    });
    const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

    assertPolicyFailure(run, "policy-read-only-workspace-mutation");
    const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
    assert.equal(brainstormRequests.length, 1);
    assert.notEqual(brainstormRequests[0]?.roleConfig.model, FALLBACK_MODEL);
  });
}

for (const wrapper of ["direct", "cause", "aggregate"] as const) {
  test(`${wrapper} runtime policy survives an unreadable post-run fingerprint`, async (t) => {
    const cwd = await initGitRepo(t, `maswe-issue29-fence-policy-${wrapper}-`);
    const config = policyConfig("brainstormer");
    const runtime = new RecordingRuntime(async (request) => {
      if (request.role !== "brainstormer") return undefined;
      await writeFile(path.join(request.cwd, ".git", "index"), "corrupt index\n", "utf8");
      const policyError = new PolicyViolationError(
        "policy-runtime-identity-mismatch",
        "runtime reported the wrong model",
      );
      if (wrapper === "direct") throw policyError;
      if (wrapper === "cause") {
        throw new Error("runtime wrapper", { cause: policyError });
      }
      throw new AggregateError(
        [new Error("transport wrapper"), policyError],
        "aggregate runtime wrapper",
      );
    });
    const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

    assertPolicyFailure(run, "policy-runtime-identity-mismatch");
    const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
    assert.equal(brainstormRequests.length, 1);
    assert.equal(
      brainstormRequests.some((request) => request.roleConfig.model === FALLBACK_MODEL),
      false,
    );
  });
}

test("ordinary runtime error with an unreadable post-run fingerprint fails closed", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-fence-runtime-error-");
  const config = policyConfig("brainstormer");
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "brainstormer") return undefined;
    await writeFile(path.join(request.cwd, ".git", "index"), "corrupt index\n", "utf8");
    throw new Error("temporary provider failure");
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

  assert.equal(run.state, "FAILED");
  assert.equal(run.failure?.code, "workflow-failure");
  assert.equal(run.failure?.runtime, undefined);
  assert.doesNotMatch(run.failure?.message ?? "", /all configured models|runtime-models-exhausted/i);
  const failEvent = run.events.findLast((event) => event.type === "FAIL");
  assert.equal(failEvent?.details?.code, "workflow-failure");
  assert.equal(failEvent?.details?.runtime, undefined);
  const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
  assert.equal(brainstormRequests.length, 1);
  assert.equal(
    brainstormRequests.some((request) => request.roleConfig.model === FALLBACK_MODEL),
    false,
  );
});

const runtimeIdentityBoundaryCases = [
  {
    name: "successful result cannot echo a self-consistent model other than the trusted candidate",
    status: "finished",
    identity: "other",
    rejectModelFallback: false,
  },
  {
    name: "runtime error result cannot echo a self-consistent model other than the trusted candidate",
    status: "error",
    identity: "other",
    rejectModelFallback: true,
  },
  {
    name: "successful result rejects a present empty actual model",
    status: "finished",
    identity: "empty-actual",
    rejectModelFallback: true,
  },
  {
    name: "runtime error result rejects a present empty actual model",
    status: "error",
    identity: "empty-actual",
    rejectModelFallback: false,
  },
] as const;

for (const spec of runtimeIdentityBoundaryCases) {
  test(spec.name, async (t) => {
    const cwd = await initGitRepo(t, `maswe-issue29-identity-boundary-${spec.status}-`);
    const config = policyConfig("brainstormer", (value) => {
      value.policy.rejectModelFallback = spec.rejectModelFallback;
    });
    const runtime = new RecordingRuntime(async (request) => {
      if (request.role !== "brainstormer") return undefined;
      const requestedModel = spec.identity === "other"
        ? "runtime-selected-other-model"
        : request.roleConfig.model;
      const actualModel = spec.identity === "other"
        ? "runtime-selected-other-model"
        : "";
      if (spec.status === "finished") {
        const result = await new MockRuntime().execute(request);
        return { ...result, requestedModel, actualModel };
      }
      return {
        status: "error",
        output: "provider rejected request",
        requestedModel,
        actualModel,
        failure: {
          code: "runtime-error",
          message: "provider rejected request",
          requestedModel,
          stderrPresent: false,
          truncated: false,
        },
      };
    });
    const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

    assertPolicyFailure(run, "policy-runtime-identity-mismatch");
    const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
    assert.equal(brainstormRequests.length, 1);
    assert.equal(brainstormRequests[0]?.roleConfig.model, config.roles.brainstormer.model);
    assert.equal(
      brainstormRequests.some((request) => request.roleConfig.model === FALLBACK_MODEL),
      false,
    );
  });
}

test("a genuinely undefined actual model remains valid", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-identity-undefined-");
  const config = policyConfig("brainstormer");
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "brainstormer") return undefined;
    const result = await new MockRuntime().execute(request);
    delete result.actualModel;
    return result;
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

  assert.equal(run.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(run.failure, undefined);
  const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
  assert.equal(brainstormRequests.length, 1);
  assert.equal(brainstormRequests[0]?.roleConfig.model, config.roles.brainstormer.model);
});

test("runtime model identity mismatch is policy failure and skips fallback", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-identity-");
  const config = policyConfig("brainstormer");
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "brainstormer") return undefined;
    const result = await new MockRuntime().execute(request);
    return { ...result, actualModel: "cursor-claude-fable-5-high" };
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

  assertPolicyFailure(run, "policy-runtime-identity-mismatch");
  const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
  assert.equal(brainstormRequests.length, 1);
  assert.notEqual(brainstormRequests[0]?.roleConfig.model, FALLBACK_MODEL);
});

test("failed runtime result identity mismatch is policy failure and skips fallback", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-failed-identity-");
  const config = policyConfig("brainstormer");
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "brainstormer") return undefined;
    return {
      status: "error",
      output: "provider rejected request",
      requestedModel: request.roleConfig.model,
      actualModel: "cursor-claude-fable-5-high",
      failure: {
        code: "runtime-error",
        message: "provider rejected request",
        requestedModel: request.roleConfig.model,
        stderrPresent: false,
        truncated: false,
      },
    };
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

  assertPolicyFailure(run, "policy-runtime-identity-mismatch");
  const brainstormRequests = runtime.requests.filter((request) => request.role === "brainstormer");
  assert.equal(brainstormRequests.length, 1);
  assert.notEqual(brainstormRequests[0]?.roleConfig.model, FALLBACK_MODEL);
});

test("ordinary runtime failure still uses configured fallback", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-fallback-");
  const config = policyConfig("brainstormer");
  let failedPrimary = false;
  const runtime = new RecordingRuntime(async (request) => {
    if (request.role !== "brainstormer" || failedPrimary) return undefined;
    failedPrimary = true;
    return {
      status: "error",
      output: "temporary provider failure",
      requestedModel: request.roleConfig.model,
      failure: {
        code: "runtime-error",
        message: "temporary provider failure",
        requestedModel: request.roleConfig.model,
        stderrPresent: false,
        truncated: false,
      },
    };
  });
  const run = await advanceToTarget(new Orchestrator(cwd, config, runtime), "brainstormer");

  assert.equal(run.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(run.failure, undefined);
  assert.deepEqual(
    runtime.requests
      .filter((request) => request.role === "brainstormer")
      .map((request) => request.roleConfig.model),
    [config.roles.brainstormer.model, FALLBACK_MODEL],
  );
});

test("PR resolver classifier uses a read-only request without changing persisted permissions", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-classifier-");
  const config = policyConfig("prResolver", (value) => {
    value.gates.requireBrainstormApproval = false;
    value.gates.requireDesignApproval = false;
  });
  const runtime = new RecordingRuntime(async () => undefined);
  let run = await new Orchestrator(cwd, config, runtime).start("Classifier", "Classify a comment.");
  const orchestrator = new Orchestrator(cwd, config, runtime);
  run = await orchestrator.markPrOpened(run.id);
  run = await orchestrator.receiveReviewComment(run.id, "Please add a null case.");

  const classifier = runtime.requests.find((request) =>
    request.role === "prResolver" && isClassifierRequest(request)
  );
  const resolver = runtime.requests.find((request) =>
    request.role === "prResolver" && !isClassifierRequest(request)
  );
  assert.equal(classifier?.roleConfig.permissions, "read-only");
  assert.equal(resolver?.roleConfig.permissions, "workspace-write");
  assert.equal(run.config.roles.prResolver.permissions, "workspace-write");
  assert.equal(run.state, "PR_REVIEW");
});

for (const spawnOutcome of ["return", "throw"] as const) {
  test(`Cursor CLI reports ${spawnOutcome}-path read-only mutation as a policy violation`, async (t) => {
    const cwd = await initGitRepo(t, `maswe-issue29-cli-${spawnOutcome}-`);
    const config = structuredClone(DEFAULT_CONFIG);
    config.runtime.outputFormat = "text";
    const runtime = new CursorCliRuntime(config, {
      cwd,
      spawnFn: async (_command, args, options) => {
        if (args[0] === "models") {
          return {
            exitCode: 0,
            stdout: `${config.roles.brainstormer.model}\n`,
            stderr: "",
            durationMs: 1,
          };
        }
        await writeFile(path.join(options.cwd, `cli-${spawnOutcome}.txt`), "mutated\n", "utf8");
        if (spawnOutcome === "throw") throw new Error("spawn failed after writing");
        return { exitCode: 0, stdout: "READY_FOR_BRAINSTORM_APPROVAL\n", stderr: "", durationMs: 1 };
      },
    });

    await assert.rejects(
      () => runtime.execute({
        runId: `cli-${spawnOutcome}`,
        role: "brainstormer",
        prompt: "brainstorm",
        cwd,
        roleConfig: config.roles.brainstormer,
      }),
      (error) =>
        error instanceof PolicyViolationError &&
        error.code === "policy-read-only-workspace-mutation",
    );
  });
}

test("Cursor SDK reports read-only mutation as a policy violation", async (t) => {
  const cwd = await initGitRepo(t, "maswe-issue29-sdk-");
  const priorKey = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = "synthetic-test-key";
  t.after(() => {
    if (priorKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = priorKey;
  });
  const runtime = new CursorSdkRuntime({
    importFn: async () => ({
      Agent: {
        prompt: async () => {
          await writeFile(path.join(cwd, "sdk-mutation.txt"), "mutated\n", "utf8");
          return {
            status: "finished",
            result: "READY_FOR_BRAINSTORM_APPROVAL\n",
            model: { id: DEFAULT_CONFIG.roles.brainstormer.model },
            agentId: "sdk-agent",
            id: "sdk-run",
          };
        },
      },
    }),
  });

  await assert.rejects(
    () => runtime.execute({
      runId: "sdk-read-only",
      role: "brainstormer",
      prompt: "brainstorm",
      cwd,
      roleConfig: DEFAULT_CONFIG.roles.brainstormer,
    }),
    (error) =>
      error instanceof PolicyViolationError &&
      error.code === "policy-read-only-workspace-mutation",
  );
});
