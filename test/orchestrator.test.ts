import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

const execFileAsync = promisify(execFile);

function testConfig(overrides: (config: MasweConfig) => void = () => undefined): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = false;
  config.quality.commands = ["node -e \"process.exit(0)\""];
  overrides(config);
  return config;
}

class FailingVerifierRuntime implements AgentRuntime {
  private readonly delegate = new MockRuntime();
  failuresRemaining: number;

  constructor(failuresRemaining = Number.POSITIVE_INFINITY) {
    this.failuresRemaining = failuresRemaining;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role !== "verifier") return this.delegate.execute(request);
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      return {
        status: "finished",
        output: "# Verification\n\n- BLOCKING: missing null case\n\nVERDICT: FAIL\n",
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    return this.delegate.execute(request);
  }

  doctor(): Promise<RuntimeDoctorResult> {
    return this.delegate.doctor();
  }
}

test("workflow reaches PR_READY after both approvals, CI, and verification", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-"));
  const orchestrator = new Orchestrator(cwd, testConfig(), new MockRuntime());

  let run = await orchestrator.start("Add audit trail", "Persist an append-only audit trail.");
  assert.equal(run.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.ok(run.workspace);
  assert.equal(run.version >= 2, true);

  run = await orchestrator.approve(run.id, "brainstorm");
  assert.equal(run.state, "WAITING_FOR_DESIGN_APPROVAL");

  run = await orchestrator.approve(run.id, "design");
  assert.equal(run.state, "PR_READY");
  assert.ok(run.artifacts.some((artifact) => artifact.name === "06-verification-report.md"));
  assert.equal(run.counters.buildVerifyCycles, 1);
});

test("approval gates can be disabled for trusted automation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-auto-gates-"));
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime());

  const run = await orchestrator.start("Automated feature", "Implement the approved routine change.");

  assert.equal(run.state, "PR_READY");
  assert.equal(run.approvals.brainstorm, true);
  assert.equal(run.approvals.design, true);
  assert.ok(run.events.some((event) => event.actor === "policy"));
});

test("CI and verifier failures are nonblocking only when explicitly configured", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-nonblocking-"));
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.gates.requireCiPass = false;
    c.gates.requireVerifierPass = false;
    c.quality.commands = ["node -e \"process.exit(9)\""];
  });
  const orchestrator = new Orchestrator(cwd, config, new FailingVerifierRuntime());

  const run = await orchestrator.start("Experimental feature", "Exercise nonblocking policy gates.");

  assert.equal(run.state, "PR_READY");
  const ciEvent = run.events.find((event) => event.type === "CI_PASSED");
  const verifyEvent = run.events.find((event) => event.type === "VERIFY_PASSED");
  assert.equal(ciEvent?.details?.passed, false);
  assert.equal(ciEvent?.details?.required, false);
  assert.equal(verifyEvent?.details?.passed, false);
  assert.equal(verifyEvent?.details?.required, false);
});

test("dirty git workspaces are rejected by default", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-dirty-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await writeFile(path.join(cwd, "uncommitted.txt"), "dirty\n", "utf8");
  const orchestrator = new Orchestrator(cwd, testConfig(), new MockRuntime());

  await assert.rejects(
    orchestrator.start("Unsafe start", "Do not run against a dirty workspace."),
    /Workspace is dirty/,
  );
});

test("review comment is classified, resolved, and independently re-verified", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-review-"));
  const config = testConfig((c) => {
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime());

  let run = await orchestrator.start("Feature", "Do the thing.");
  run = await orchestrator.approve(run.id, "brainstorm");
  run = await orchestrator.approve(run.id, "design");
  run = await orchestrator.markPrOpened(run.id);
  run = await orchestrator.receiveReviewComment(run.id, "Please add the missing null case test.");

  assert.equal(run.state, "PR_REVIEW");
  assert.equal(run.counters.commentResolutionCycles, 1);
  assert.ok(run.events.some((event) => event.type === "VERIFY_PASSED_AFTER_REVIEW"));
});

test("verifier failures write explicit defects and retry into a passing build", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-defects-"));
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
    c.policy.maxBuildVerifyCycles = 3;
  });
  const runtime = new FailingVerifierRuntime(1);
  const orchestrator = new Orchestrator(cwd, config, runtime);

  const run = await orchestrator.start("Fix defects", "Builder must see verifier defects.");
  assert.equal(run.state, "PR_READY");
  assert.equal(run.counters.buildVerifyCycles, 2);
  assert.ok(run.artifacts.some((artifact) => artifact.logicalName === "10-verifier-defects.md"));
  const defects = await orchestrator.store.readArtifact(run, "10-verifier-defects.md");
  assert.match(defects ?? "", /missing null case/i);
});

test("retry-from-failed resumes a failed run using stored resumeState", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-retry-"));
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
    c.policy.maxBuildVerifyCycles = 1;
  });
  const orchestrator = new Orchestrator(cwd, config, new FailingVerifierRuntime());

  let run = await orchestrator.start("Retry me", "Force a failed verification cycle.");
  assert.equal(run.state, "FAILED");
  assert.equal(run.failure?.resumeState, "BUILDING");

  // Allow the next verify to pass after raising the cycle budget on the persisted config.
  run.config.policy.maxBuildVerifyCycles = 3;
  await orchestrator.store.save(run);
  const runtime = new FailingVerifierRuntime(0);
  const retryOrchestrator = new Orchestrator(cwd, config, runtime, orchestrator.store);
  run = await retryOrchestrator.retryFromFailed(run.id);
  assert.equal(run.state, "PR_READY");
  assert.equal(run.failure, undefined);
});

test("supersede creates a replacement run linked to the original", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-supersede-"));
  const config = testConfig((c) => {
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime());
  let original = await orchestrator.start("Original", "First attempt.");
  assert.equal(original.state, "WAITING_FOR_BRAINSTORM_APPROVAL");

  const replacement = await orchestrator.supersede(original.id);
  original = await orchestrator.store.load(original.id);
  assert.equal(original.state, "CANCELLED");
  assert.equal(original.supersededBy, replacement.id);
  assert.equal(replacement.supersedes, original.id);
  assert.equal(replacement.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
});
