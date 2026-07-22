import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-prov-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await mkdir(path.join(cwd, "src"), { recursive: true });
  await writeFile(path.join(cwd, "src", "ok.ts"), "export {}\n", "utf8");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

function config(overrides: (c: MasweConfig) => void = () => undefined): MasweConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runtime.kind = "mock";
  c.policy.useIsolatedWorktree = true;
  c.policy.allowedPathGlobs = ["src/**", "README.md"];
  c.gates.requireBrainstormApproval = false;
  c.gates.requireDesignApproval = false;
  c.quality.commands = [];
  overrides(c);
  return c;
}

class EditingBuilder implements AgentRuntime {
  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
      return {
        status: "finished",
        output: "ok\nBUILD_COMPLETE\n",
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    return new MockRuntime().execute(request);
  }
  doctor(): Promise<RuntimeDoctorResult> {
    return new MockRuntime().doctor();
  }
  listModels(): Promise<string[]> {
    return new MockRuntime().listModels();
  }
}

test("failed run keeps branch ref and can recreate worktree from headSha on retry from CI_RUNNING", async () => {
  const cwd = await initRepo();
  const cfg = config((c) => {
    // Throw inside CI so resumeState is CI_RUNNING (not a soft CI_FAILED→BUILDING loop).
    c.quality.commands = [
      `node -e "require('fs').writeFileSync('src/ok.ts', 'export const dirty = 1\\n')"`,
    ];
  });
  const orchestrator = new Orchestrator(cwd, cfg, new EditingBuilder());
  let run = await orchestrator.start("Fail in CI", "Preserve builder SHA.");
  assert.equal(run.state, "FAILED");
  assert.equal(run.failure?.resumeState, "CI_RUNNING");

  const build = run.events.find((e) => e.type === "BUILD_COMPLETED");
  const outputSha = String(build?.details?.outputHeadSha ?? "");
  assert.match(outputSha, /^[0-9a-f]{40}$/);
  assert.equal(run.workspace?.headSha, outputSha);

  // Branch ref must still exist after failure cleanup.
  const branch = run.workspace?.branch;
  assert.ok(branch);
  const ref = await execFileAsync("git", ["rev-parse", branch], { cwd });
  assert.equal(ref.stdout.trim(), outputSha);

  run.config.quality.commands = [];
  await orchestrator.store.save(run);

  const retried = await new Orchestrator(cwd, cfg, new MockRuntime(), orchestrator.store).retryFromFailed(
    run.id,
  );
  assert.ok(["PR_READY", "FAILED", "BUILDING", "CI_RUNNING", "VERIFYING"].includes(retried.state));
  assert.ok(retried.workspace?.worktreePath);
  await access(retried.workspace!.worktreePath!);
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: retried.workspace!.worktreePath!,
  });
  // Recreated worktree should start from preserved headSha (builder output).
  assert.equal(head.stdout.trim(), outputSha);
});

test("retry from VERIFYING preserves builder output SHA in recreated worktree", async () => {
  const cwd = await initRepo();
  class FailVerifier extends EditingBuilder {
    override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
      if (request.role === "verifier") {
        return {
          status: "finished",
          output: "nope\nVERDICT: FAIL\n",
          requestedModel: request.roleConfig.model,
          actualModel: request.roleConfig.model,
        };
      }
      return super.execute(request);
    }
  }

  const cfg = config((c) => {
    c.policy.maxBuildVerifyCycles = 1;
  });
  const orchestrator = new Orchestrator(cwd, cfg, new FailVerifier());
  let run = await orchestrator.start("Fail verify", "Preserve SHA.");
  assert.equal(run.state, "FAILED");
  const build = run.events.find((e) => e.type === "BUILD_COMPLETED");
  const outputSha = String(build?.details?.outputHeadSha ?? "");
  assert.match(outputSha, /^[0-9a-f]{40}$/);

  // Force resumeState to VERIFYING for this provenance test.
  run.failure = {
    message: run.failure?.message ?? "forced",
    at: new Date().toISOString(),
    resumeState: "VERIFYING",
  };
  run.state = "FAILED";
  await orchestrator.store.save(run);

  const passRuntime = new MockRuntime();
  const retried = await new Orchestrator(cwd, cfg, passRuntime, orchestrator.store).retryFromFailed(
    run.id,
  );
  assert.ok(retried.workspace?.worktreePath);
  const head = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: retried.workspace!.worktreePath!,
  });
  assert.equal(head.stdout.trim(), outputSha);
});
