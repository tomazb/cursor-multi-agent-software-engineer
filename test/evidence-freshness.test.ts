import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type { AgentRuntime, ArtifactReference, MasweConfig, RunRecord, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";
import { ensureRunWorkspace, refreshWorkspaceHead } from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { RevalidationService } from "../src/revalidation.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const HEAD_C = "c".repeat(40);

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
  listModels(): Promise<string[]> {
    return new MockRuntime().listModels();
  }
}

class TrackingRuntime extends EditingBuilder {
  verifierExecutions = 0;

  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "verifier") this.verifierExecutions += 1;
    return super.execute(request);
  }
}

class RetargetAfterArtifactStore extends FileRunStore {
  private retargeted = false;
  private readonly artifactName: string;

  constructor(cwd: string, artifactName: string) {
    super(cwd);
    this.artifactName = artifactName;
  }

  override async writeArtifact(
    run: RunRecord,
    name: string,
    content: string,
  ): Promise<ArtifactReference> {
    const reference = await super.writeArtifact(run, name, content);
    if (name === this.artifactName && !this.retargeted) {
      this.retargeted = true;
      const current = await this.load(run.id);
      await new RevalidationService(this).route(run.id, {
        source: "github",
        previousHeadSha: current.revalidation!.requestedHeadSha,
        requestedHeadSha: HEAD_C,
        actor: "github-app",
      });
    }
    return reference;
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

test("initial revalidation invalidates every stale evidence binding", async () => {
  const cwd = await initRepo();
  const store = new FileRunStore(cwd);
  const run = await store.create("stale evidence", "revalidate a newer head", baseConfig());
  run.state = "PR_READY";
  run.evidence = {
    quality: { headSha: "a".repeat(40), passed: true, at: "2026-08-18T12:00:00.000Z" },
    verification: { headSha: "a".repeat(40), passed: true, at: "2026-08-18T12:00:00.000Z" },
    mergeReady: { headSha: "a".repeat(40), passed: true, at: "2026-08-18T12:00:00.000Z" },
  };
  await store.save(run);

  const routed = await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha: "a".repeat(40),
    requestedHeadSha: "b".repeat(40),
    actor: "local-runner",
    at: "2026-08-18T12:01:00.000Z",
  });

  assert.equal(routed.evidence, undefined);
  assert.equal((await store.load(run.id)).evidence, undefined);
});

test("an associated target mismatch fails before work and an exact operator alignment retries", async (t) => {
  const cwd = await initRepo();
  const config = baseConfig((c) => {
    c.quality.commands = [];
  });
  const runtime = new TrackingRuntime();
  const orchestrator = new Orchestrator(cwd, config, runtime);
  let run = await orchestrator.start("Associated revalidation", "Verify only the associated HEAD.");
  assert.equal(run.state, "PR_READY");
  assert.equal(runtime.verifierExecutions, 1);
  const headB = run.workspace?.headSha;
  const worktreePath = run.workspace?.worktreePath;
  const branch = run.workspace?.branch;
  assert.ok(headB && worktreePath && branch);
  t.after(async () => {
    await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd }).catch(
      () => undefined,
    );
    await rm(cwd, { recursive: true, force: true });
  });

  const { stdout: treeOutput } = await execFileAsync(
    "git",
    ["rev-parse", `${headB}^{tree}`],
    { cwd },
  );
  const { stdout: headOutput } = await execFileAsync(
    "git",
    ["commit-tree", treeOutput.trim(), "-p", headB, "-m", "associated head C"],
    { cwd },
  );
  const headC = headOutput.trim();
  run.github = {
    installationId: 1,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: run.workspace!.baseSha,
    headSha: headC,
    branch: run.workspace!.branch,
  };
  await orchestrator.store.save(run);
  await new RevalidationService(orchestrator.store).route(run.id, {
    source: "github",
    previousHeadSha: headB,
    requestedHeadSha: headC,
    actor: "github-app",
  });

  await orchestrator.advance(run.id);
  let authoritative = await orchestrator.store.load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CI_RUNNING");
  assert.match(authoritative.failure?.message ?? "", /workspace.*HEAD|target.*workspace|alignment/i);
  assert.equal(runtime.verifierExecutions, 1);
  assert.equal(
    authoritative.artifacts.filter(
      (artifact) => artifact.logicalName === "05-quality-report.md",
    ).length,
    1,
  );

  await execFileAsync("git", ["update-ref", `refs/heads/${branch}`, headC, headB], { cwd });
  await new Orchestrator(cwd, config, runtime, orchestrator.store).retryFromFailed(run.id);
  authoritative = await orchestrator.store.load(run.id);

  assert.equal(authoritative.state, "PR_READY");
  assert.equal(authoritative.workspace?.headSha, headC);
  assert.equal(authoritative.evidence?.quality?.headSha, headC);
  assert.equal(authoritative.evidence?.verification?.headSha, headC);
  assert.equal(authoritative.revalidation, undefined);
  assert.equal(runtime.verifierExecutions, 2);
});

test("a stale builder generation cannot commit after a concurrent retarget", async (t) => {
  const cwd = await initRepo();
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const config = baseConfig((c) => {
    c.policy.useIsolatedWorktree = false;
    c.quality.commands = [];
  });
  const store = new RetargetAfterArtifactStore(cwd, "04-builder-report.md");
  const run = await store.create("fenced builder", "Do not commit stale work.", config);
  run.state = "PR_READY";
  run.workspace = await ensureRunWorkspace(cwd, run);
  await store.save(run);
  const previousHeadSha = run.workspace.headSha;

  await writeFile(path.join(cwd, "new-head.txt"), "head B\n", "utf8");
  await execFileAsync("git", ["add", "new-head.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "head B"], { cwd });
  const observed = structuredClone(run);
  await refreshWorkspaceHead(observed);
  const headB = observed.workspace!.headSha;
  await new RevalidationService(store).route(run.id, {
    source: "local-workspace",
    previousHeadSha,
    requestedHeadSha: headB,
    actor: "local-runner",
    observedWorkspace: observed.workspace!,
  });
  const active = await store.load(run.id);
  await store.applyEvent(active, "CI_FAILED", "quality-runner", {
    passed: false,
    required: true,
    headSha: headB,
  });

  const orchestrator = new Orchestrator(cwd, config, new EditingBuilder(), store);
  await assert.rejects(
    orchestrator.advance(run.id),
    /stale.*fence|version conflict|publication outcome/i,
  );
  const authoritative = await store.load(run.id);
  const { stdout: actualHeadOutput } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });

  assert.equal(authoritative.state, "CI_RUNNING");
  assert.equal(authoritative.revalidation?.requestedHeadSha, HEAD_C);
  assert.equal(authoritative.revalidation?.generation, 2);
  assert.equal(actualHeadOutput.trim(), headB);
  assert.equal(
    authoritative.events.some((event) => event.type === "BUILD_COMPLETED"),
    false,
  );
  assert.equal(
    authoritative.artifacts.filter(
      (artifact) => artifact.logicalName === "04-builder-report.md",
    ).length,
    1,
  );
});
