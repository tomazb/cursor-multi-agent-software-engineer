import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { RuntimeRequest } from "../src/domain.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";
import { CursorCliRuntime } from "../src/runtimes/cursor-cli.ts";
import { createRuntime } from "../src/runtime.ts";
import { spawn } from "node:child_process";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function initRepo(prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
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

function runCli(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", cliPath, ...args],
      {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => (stdout += chunk));
    child.stderr?.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("retry rejects advanced branch without modifying either SHA", async () => {
  const cwd = await initRepo("maswe-branch-move-");
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.policy.allowedPathGlobs = ["**"];
  config.gates.requireBrainstormApproval = false;
  config.gates.requireDesignApproval = false;
  config.quality.commands = [
    `node -e "require('fs').writeFileSync('src/ok.ts', 'export const dirty = 1\\n')"`,
  ];

  class EditingBuilder extends MockRuntime {
    override async execute(request: RuntimeRequest) {
      if (request.role === "builder") {
        await writeFile(path.join(request.cwd, "src", "feature.ts"), "export const x = 1;\n", "utf8");
        return {
          status: "finished" as const,
          output: "ok\nBUILD_COMPLETE\n",
          requestedModel: request.roleConfig.model,
          actualModel: request.roleConfig.model,
        };
      }
      return super.execute(request);
    }
  }

  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder());
  let run = await orchestrator.start("Branch move", "Fail in CI.");
  assert.equal(run.state, "FAILED");
  const preserved = run.workspace!.headSha;
  const branch = run.workspace!.branch;
  assert.match(preserved, /^[0-9a-f]{40}$/);

  // Advance the failed run branch with an external commit.
  const tempCheckout = await mkdtemp(path.join(os.tmpdir(), "maswe-branch-adv-"));
  await execFileAsync("git", ["worktree", "add", tempCheckout, branch], { cwd });
  await writeFile(path.join(tempCheckout, "src", "ok.ts"), "export const advanced = 1;\n", "utf8");
  await execFileAsync("git", ["add", "src/ok.ts"], { cwd: tempCheckout });
  await execFileAsync("git", ["commit", "-qm", "advance branch"], { cwd: tempCheckout });
  const advanced = (
    await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: tempCheckout })
  ).stdout.trim();
  await execFileAsync("git", ["worktree", "remove", "--force", tempCheckout], { cwd });
  assert.notEqual(advanced, preserved);

  run.config.quality.commands = [];
  await orchestrator.store.save(run);

  await assert.rejects(
    new Orchestrator(cwd, config, new MockRuntime(), orchestrator.store).retryFromFailed(run.id),
    /branch .* moved|refusing|headSha|mismatch/i,
  );

  const branchSha = (await execFileAsync("git", ["rev-parse", branch], { cwd })).stdout.trim();
  assert.equal(branchSha, advanced);
  const reloaded = await orchestrator.store.load(run.id);
  assert.equal(reloaded.workspace?.headSha, preserved);
});

test("existing-run CLI commands ignore malformed project config and env mutations", async () => {
  const cwd = await initRepo("maswe-cli-cfg-");
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.runtime.command = "snapshotted-agent";
  config.roles.brainstormer.model = "snapshotted-model";
  config.policy.useIsolatedWorktree = false;
  config.gates.requireBrainstormApproval = true;
  config.quality.commands = [];

  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(
    path.join(cwd, ".maswe", "config.json"),
    JSON.stringify({
      runtime: { kind: "mock", command: "agent", outputFormat: "json" },
      roles: config.roles,
      gates: config.gates,
      quality: { commands: [] },
      policy: config.policy,
      version: 1,
    }),
  );

  const store = new FileRunStore(cwd);
  const run = await store.create("cli-cfg", "request", config);
  run.state = "WAITING_FOR_BRAINSTORM_APPROVAL";
  await store.save(run);

  // Corrupt project config and mutate environment after the run snapshot exists.
  await writeFile(path.join(cwd, ".maswe", "config.json"), "{ not-json", "utf8");
  const result = await runCli(
    cwd,
    ["status", run.id, "--json"],
    {
      MASWE_RUNTIME: "cursor-cli",
      MASWE_MODEL_BRAINSTORMER: "env-mutated-model",
    },
  );
  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout) as {
    config: { runtime: { kind: string; command: string }; roles: { brainstormer: { model: string } } };
  };
  assert.equal(parsed.config.runtime.kind, "mock");
  assert.equal(parsed.config.runtime.command, "snapshotted-agent");
  assert.equal(parsed.config.roles.brainstormer.model, "snapshotted-model");

  const cancel = await runCli(
    cwd,
    ["cancel", run.id],
    { MASWE_RUNTIME: "cursor-cli", MASWE_MODEL_BRAINSTORMER: "env-mutated-model" },
  );
  assert.equal(cancel.code, 0, cancel.stderr);
  assert.match(cancel.stdout, /CANCELLED/);
});

test("doctor cleanup removes probe worktree and branch; failures are visible checks", async () => {
  const cwd = await initRepo("maswe-doctor-clean-");
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.policy.promptTransport = "stdin";
  config.policy.trustManagedWorktrees = true;
  config.policy.useIsolatedWorktree = true;

  const beforeWorktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd }))
    .stdout;

  const runtime = new CursorCliRuntime(config, { cwd });
  const report = await runtime.doctor();
  const cleanup = report.checks.find((c) => c.name === "doctor-probe-cleanup");
  assert.ok(cleanup, "doctor must report probe cleanup check");
  assert.equal(cleanup.ok, true, cleanup.message);
  assert.match(cleanup.message, /Removed doctor probe|No ephemeral/);

  const afterWorktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd }))
    .stdout;
  assert.equal(afterWorktrees, beforeWorktrees);

  // Planted probe cleanup deletes both worktree and branch.
  const probeId = `doctor-${Date.now().toString(36)}`;
  const { ensureRunWorkspace, cleanupDoctorProbeResources } = await import("../src/git-workspace.ts");
  const planted = await ensureRunWorkspace(cwd, {
    schemaVersion: 1,
    version: 1,
    id: probeId,
    title: "planted",
    request: "probe",
    repositoryPath: cwd,
    state: "CREATED",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    approvals: { brainstorm: false, design: false },
    counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
    config,
    artifacts: [],
    events: [],
  });
  assert.ok(planted.worktreePath);
  await access(planted.worktreePath!);
  const branchBefore = (
    await execFileAsync("git", ["rev-parse", "--verify", `maswe/${probeId}`], { cwd })
  ).stdout.trim();
  assert.match(branchBefore, /^[0-9a-f]{40}$/);

  await cleanupDoctorProbeResources(cwd, probeId, planted.worktreePath!);
  await assert.rejects(access(planted.worktreePath!), /ENOENT/);
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", `maswe/${probeId}`], { cwd }),
  );
});

test(
  "opt-in Cursor CLI smoke: brainstormer reaches WAITING_FOR_BRAINSTORM_APPROVAL",
  { skip: process.env.MASWE_CURSOR_SMOKE !== "1" },
  async () => {
    const cwd = await initRepo("maswe-smoke-");
    const config = structuredClone(DEFAULT_CONFIG);
    config.runtime.kind = "cursor-cli";
    config.runtime.outputFormat = "text";
    config.policy.trustManagedWorktrees = true;
    config.policy.useIsolatedWorktree = true;
    config.gates.requireBrainstormApproval = true;
    config.quality.commands = [];

    const runtime = createRuntime(config, cwd);
    const { pickCatalogueModel } = await import("../src/model-resolution.ts");
    const { ROLE_IDS } = await import("../src/domain.ts");
    const model = pickCatalogueModel(
      await runtime.listModels(),
      process.env.MASWE_MODEL_BRAINSTORMER,
    );
    for (const role of ROLE_IDS) {
      config.roles[role].model = model;
      delete config.roles[role].fallbackModels;
    }

    const orchestrator = new Orchestrator(cwd, config, runtime);
    const run = await orchestrator.start("Smoke", "One-sentence brainstorm only. Keep the report short.");
    assert.ok(run.workspace?.worktreePath);
    assert.equal(
      run.state,
      "WAITING_FOR_BRAINSTORM_APPROVAL",
      `smoke failed: state=${run.state} failure=${run.failure?.message ?? "(none)"}`,
    );
    assert.ok(run.artifacts.some((a) => a.logicalName === "02-brainstorm.md"));
  },
);

test(
  "opt-in Cursor CLI smoke: DEFAULT json outputFormat brainstormer with marker extraction",
  { skip: process.env.MASWE_CURSOR_SMOKE !== "1" },
  async () => {
    const cwd = await initRepo("maswe-smoke-json-");
    const config = structuredClone(DEFAULT_CONFIG);
    config.runtime.kind = "cursor-cli";
    // Explicitly exercise the DEFAULT execution path (json), including extractCursorCliOutput.
    config.runtime.outputFormat = "json";
    config.policy.trustManagedWorktrees = true;
    config.policy.useIsolatedWorktree = true;
    config.gates.requireBrainstormApproval = true;
    config.quality.commands = [];

    const runtime = createRuntime(config, cwd);
    const { pickCatalogueModel } = await import("../src/model-resolution.ts");
    const { ROLE_IDS } = await import("../src/domain.ts");
    const model = pickCatalogueModel(
      await runtime.listModels(),
      process.env.MASWE_MODEL_BRAINSTORMER ?? "grok-4.5",
    );
    for (const role of ROLE_IDS) {
      config.roles[role].model = model;
      delete config.roles[role].fallbackModels;
    }

    const orchestrator = new Orchestrator(cwd, config, runtime);
    const run = await orchestrator.start(
      "Smoke JSON",
      "One-sentence brainstorm only. Keep the report short.",
    );
    assert.ok(run.workspace?.worktreePath, "managed worktree required");
    assert.equal(run.config.roles.brainstormer.model, model);
    assert.equal(
      run.state,
      "WAITING_FOR_BRAINSTORM_APPROVAL",
      `json smoke failed: state=${run.state} failure=${run.failure?.message ?? "(none)"}`,
    );
    assert.ok(run.artifacts.some((a) => a.logicalName === "02-brainstorm.md"));
    assert.equal(run.failure, undefined);
  },
);
