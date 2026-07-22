import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentRuntime, MasweConfig, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { isGitWorkspaceClean } from "../src/git-snapshot.ts";

const execFileAsync = promisify(execFile);

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-commit-"));
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

class EditingRuntime implements AgentRuntime {
  private readonly mode: "edit" | "commit" | "dirty-extra" | "out-of-scope" | "commit-fail-prep";

  constructor(mode: "edit" | "commit" | "dirty-extra" | "out-of-scope" | "commit-fail-prep") {
    this.mode = mode;
  }

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      if (this.mode === "edit" || this.mode === "commit-fail-prep") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
      }
      if (this.mode === "commit") {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
        await execFileAsync("git", ["add", "src/feature.ts"], { cwd: request.cwd });
        await execFileAsync("git", ["commit", "-qm", "model commit"], { cwd: request.cwd });
      }
      if (this.mode === "dirty-extra") {
        await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
        // Leave an unreadable / uncommittable situation by creating a path outside globs too that commit will see
      }
      if (this.mode === "out-of-scope") {
        await writeFile(path.join(request.cwd, "secret.env"), "TOKEN=1\n", "utf8");
      }
      return {
        status: "finished",
        output: "# builder\n\nBUILD_COMPLETE\n",
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

test("BUILD_COMPLETED is emitted only after deterministic commit with input and output SHAs", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, config(), new EditingRuntime("edit"));
  const run = await orchestrator.start("Commit after build", "Edit src only.");
  assert.equal(run.state, "PR_READY");
  const build = run.events.find((e) => e.type === "BUILD_COMPLETED");
  assert.ok(build);
  assert.ok(typeof build.details?.inputHeadSha === "string");
  assert.ok(typeof build.details?.outputHeadSha === "string");
  assert.notEqual(build.details?.inputHeadSha, build.details?.outputHeadSha);
  assert.equal(build.details?.outputHeadSha, run.workspace?.headSha);
  assert.equal(run.evidence?.quality?.headSha, run.workspace?.headSha);
  assert.equal(run.evidence?.verification?.headSha, run.workspace?.headSha);
  const worktree = run.workspace?.worktreePath;
  assert.ok(worktree);
  assert.equal(await isGitWorkspaceClean(worktree), true);
});

test("rejects model-created commits before deterministic publish", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, config(), new EditingRuntime("commit"));
  const run = await orchestrator.start("No model commits", "Builder must not commit.");
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /model-created commit|unexpected commit|HEAD moved/i);
});

test("rejects out-of-scope working tree changes", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, config(), new EditingRuntime("out-of-scope"));
  const run = await orchestrator.start("Scope", "Only src/** allowed.");
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /Change-scope violation/i);
});

test("deterministic commit failures fail closed", async () => {
  const cwd = await initRepo();
  class CommitFailRuntime extends EditingRuntime {
    constructor() {
      super("edit");
    }
    override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
      const result = await super.execute(request);
      if (request.role === "builder") {
        const gitFile = await readFile(path.join(request.cwd, ".git"), "utf8");
        const gitDir = path.resolve(request.cwd, gitFile.replace(/^gitdir:\s*/i, "").trim());
        await writeFile(path.join(gitDir, "index"), "corrupt-index\n", "utf8");
      }
      return result;
    }
  }
  const orchestrator = new Orchestrator(cwd, config(), new CommitFailRuntime());
  const run = await orchestrator.start("Commit fail", "Must fail closed on commit error.");
  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /commit failed|git (add|commit|status) failed/i);
});

test("dirty tree after failed publish is not accepted as BUILD_COMPLETED", async () => {
  const cwd = await initRepo();
  const orchestrator = new Orchestrator(cwd, config(), new EditingRuntime("out-of-scope"));
  const run = await orchestrator.start("Dirty", "Must not emit BUILD_COMPLETED.");
  assert.equal(
    run.events.some((e) => e.type === "BUILD_COMPLETED"),
    false,
  );
});
