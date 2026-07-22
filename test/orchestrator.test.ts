import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentRuntime, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

const execFileAsync = promisify(execFile);

class FailingVerifierRuntime implements AgentRuntime {
  private readonly delegate = new MockRuntime();

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role !== "verifier") return this.delegate.execute(request);
    return {
      status: "finished",
      output: "# Verification\n\nVERDICT: FAIL\n",
      requestedModel: request.roleConfig.model,
      actualModel: request.roleConfig.model,
    };
  }

  doctor(): Promise<RuntimeDoctorResult> {
    return this.delegate.doctor();
  }
}

test("workflow reaches PR_READY after both approvals, CI, and verification", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-run-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.quality.commands = ["node -e \"process.exit(0)\""];
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime());

  let run = await orchestrator.start("Add audit trail", "Persist an append-only audit trail.");
  assert.equal(run.state, "WAITING_FOR_BRAINSTORM_APPROVAL");

  run = await orchestrator.approve(run.id, "brainstorm");
  assert.equal(run.state, "WAITING_FOR_DESIGN_APPROVAL");

  run = await orchestrator.approve(run.id, "design");
  assert.equal(run.state, "PR_READY");
  assert.ok(run.artifacts.some((artifact) => artifact.name === "06-verification-report.md"));
  assert.equal(run.counters.buildVerifyCycles, 1);
});

test("approval gates can be disabled for trusted automation", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-auto-gates-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [];
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime());

  const run = await orchestrator.start("Automated feature", "Implement the approved routine change.");

  assert.equal(run.state, "PR_READY");
  assert.equal(run.approvals.brainstorm, true);
  assert.equal(run.approvals.design, true);
  assert.ok(run.events.some((event) => event.actor === "policy"));
});

test("CI and verifier failures are nonblocking only when explicitly configured", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-nonblocking-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.gates.requireCiPass = false;
  config.gates.requireVerifierPass = false;
  config.quality.commands = ["node -e \"process.exit(9)\""];
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
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.quality.commands = [];
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime());

  await assert.rejects(
    orchestrator.start("Unsafe start", "Do not run against a dirty workspace."),
    /Workspace is dirty/,
  );
});

test("review comment is classified, resolved, and independently re-verified", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-review-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.quality.commands = [];
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
