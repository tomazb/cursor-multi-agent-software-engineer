import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { ensureRunWorkspace } from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-evidence-"));
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

function baseConfig(overrides: (c: MasweConfig) => void = () => undefined): MasweConfig {
  const c = structuredClone(DEFAULT_CONFIG);
  c.runtime.kind = "mock";
  c.policy.useIsolatedWorktree = true;
  c.policy.allowedPathGlobs = ["**"];
  c.gates.requireBrainstormApproval = false;
  c.gates.requireDesignApproval = false;
  overrides(c);
  return c;
}

class EditingBuilder implements AgentRuntime {
  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      await mkdir(path.join(request.cwd, "src"), { recursive: true });
      await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
      return {
        status: "finished",
        output: "done\nBUILD_COMPLETE\n",
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    return new MockRuntime().execute(request);
  }
  doctor(): Promise<RuntimeDoctorResult> {
    return new MockRuntime().doctor();
  }
}

test("quality command that edits a tracked file fails closed before verifier", async () => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [
      `node -e "require('fs').writeFileSync('src/ok.ts', 'export const dirty = 1\\n')"`,
    ];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  const run = await orchestrator.start("Dirty CI", "Quality must not dirty tree.");
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /clean worktree|dirty/i);
  assert.equal(run.events.some((e) => e.type === "VERIFY_PASSED"), false);
});

test("quality command that creates a commit invalidates and fails before verifier", async () => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [
      `node -e "require('fs').writeFileSync('src/ok.ts','export const y=1\\n'); require('child_process').execFileSync('git',['add','src/ok.ts']); require('child_process').execFileSync('git',['commit','-qm','ci commit'])"`,
    ];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  const run = await orchestrator.start("CI commit", "Quality must not commit.");
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /clean worktree|HEAD moved|dirty|commit/i);
});

test("HEAD change between CI and verifier fails closed", async () => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [];
  });

  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  const run = await orchestrator.store.create(
    "HEAD move",
    "Verifier must see clean fresh SHA.",
    config,
  );
  run.workspace = await ensureRunWorkspace(cwd, run);
  await orchestrator.store.save(run);
  await orchestrator.store.applyEvent(run, "START", "user");

  let current = run;
  for (let i = 0; i < 20 && current.state !== "VERIFYING" && current.state !== "FAILED"; i += 1) {
    const before = current.state;
    current = await orchestrator.advance(current.id);
    if (before === "CI_RUNNING" && current.state === "VERIFYING") break;
  }
  assert.equal(current.state, "VERIFYING");

  const workdir = current.workspace?.worktreePath ?? cwd;
  await writeFile(path.join(workdir, "src", "ok.ts"), "export const z = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src/ok.ts"], { cwd: workdir });
  await execFileAsync("git", ["commit", "-qm", "sneaky"], { cwd: workdir });

  current = await orchestrator.advance(current.id);
  assert.equal(current.state, "FAILED");
  assert.match(
    current.failure?.message ?? "",
    /clean worktree|stale|HEAD|quality evidence|fresh/i,
  );
});
