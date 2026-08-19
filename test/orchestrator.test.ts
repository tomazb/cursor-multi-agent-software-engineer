import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  listModels(): Promise<string[]> {
    return this.delegate.listModels();
  }
}

class CountingRuntime implements AgentRuntime {
  private readonly delegate = new MockRuntime();
  verifierExecutions = 0;

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "verifier") this.verifierExecutions += 1;
    return this.delegate.execute(request);
  }

  doctor(): Promise<RuntimeDoctorResult> {
    return this.delegate.doctor();
  }

  listModels(): Promise<string[]> {
    return this.delegate.listModels();
  }
}

class EditingBuilderRuntime extends MockRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      await writeFile(path.join(request.cwd, "builder-change.txt"), "builder delta\n", "utf8");
    }
    return super.execute(request);
  }
}

class EditingResolverRuntime extends MockRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (
      request.role === "prResolver" &&
      !request.prompt.includes("Role: PR comment scope classifier")
    ) {
      await writeFile(path.join(request.cwd, "resolver-change.txt"), "resolver delta\n", "utf8");
    }
    return super.execute(request);
  }
}

class IgnoredInputBuilderRuntime extends MockRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      const localInput = await readFile(
        path.join(request.cwd, "node_modules", "local-tool", "input.txt"),
        "utf8",
      );
      await writeFile(path.join(request.cwd, "builder-input.txt"), localInput, "utf8");
    }
    return super.execute(request);
  }
}

class UnignoringSecretBuilderRuntime extends MockRuntime {
  override async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    if (request.role === "builder") {
      await readFile(path.join(request.cwd, ".env"), "utf8");
      await execFileAsync("git", ["add", "-f", ".env"], { cwd: request.cwd });
      await writeFile(path.join(request.cwd, ".gitignore"), "", "utf8");
      await writeFile(path.join(request.cwd, "builder-output.txt"), "safe output\n", "utf8");
    }
    return super.execute(request);
  }
}

async function initGitRepo(t: test.TestContext, prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# orchestrator\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
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

for (const returnGate of ["PR_READY", "PR_REVIEW"] as const) {
  test(`a local HEAD move at ${returnGate} gets fresh evidence and returns to that gate`, async (t) => {
    const cwd = await initGitRepo(t, `maswe-local-revalidation-${returnGate.toLowerCase()}-`);
    const config = testConfig((c) => {
      c.gates.requireBrainstormApproval = false;
      c.gates.requireDesignApproval = false;
    });
    const runtime = new CountingRuntime();
    const orchestrator = new Orchestrator(cwd, config, runtime);
    let run = await orchestrator.start("Local revalidation", "Verify the operator's current HEAD.");
    if (returnGate === "PR_REVIEW") run = await orchestrator.markPrOpened(run.id);
    assert.equal(run.state, returnGate);
    assert.equal(runtime.verifierExecutions, 1);
    assert.equal(run.counters.commentResolutionCycles, 0);
    const oldHead = run.workspace?.headSha;

    await writeFile(path.join(cwd, "operator-change.txt"), `${returnGate}\n`, "utf8");
    await execFileAsync("git", ["add", "operator-change.txt"], { cwd });
    await execFileAsync("git", ["commit", "-qm", `operator move for ${returnGate}`], { cwd });
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
    const newHead = stdout.trim();
    assert.notEqual(newHead, oldHead);

    await orchestrator.runUntilBlocked(run.id);
    const authoritative = await orchestrator.store.load(run.id);

    assert.equal(authoritative.state, returnGate);
    assert.equal(authoritative.workspace?.headSha, newHead);
    assert.equal(authoritative.evidence?.quality?.headSha, newHead);
    assert.equal(authoritative.evidence?.verification?.headSha, newHead);
    assert.equal(authoritative.revalidation, undefined);
    assert.equal(authoritative.counters.commentResolutionCycles, 0);
    assert.equal(runtime.verifierExecutions, 2);
    assert.equal(
      authoritative.artifacts.filter(
        (artifact) => artifact.logicalName === "05-quality-report.md",
      ).length,
      2,
    );
    const finalVerify = [...authoritative.events]
      .reverse()
      .find((event) =>
        event.type === "VERIFY_PASSED" || event.type === "VERIFY_PASSED_AFTER_REVIEW"
      );
    assert.equal(
      finalVerify?.type,
      returnGate === "PR_READY" ? "VERIFY_PASSED" : "VERIFY_PASSED_AFTER_REVIEW",
    );
  });
}

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

test("allowed dirty workspace changes are included in speculative builder publication", async (t) => {
  const cwd = await initGitRepo(t, "maswe-allowed-dirty-builder-");
  await writeFile(path.join(cwd, "README.md"), "# operator baseline\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await writeFile(path.join(cwd, "operator-change.txt"), "preserve me\n", "utf8");
  const config = testConfig((c) => {
    c.policy.allowDirtyWorkspace = true;
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const run = await new Orchestrator(cwd, config, new EditingBuilderRuntime()).start(
    "Allowed dirty build",
    "Preserve and publish the allowed workspace baseline.",
  );
  const { stdout: published } = await execFileAsync(
    "git",
    ["show", "HEAD:operator-change.txt"],
    { cwd },
  );
  const { stdout: builderDelta } = await execFileAsync(
    "git",
    ["show", "HEAD:builder-change.txt"],
    { cwd },
  );
  const { stdout: stagedBaseline } = await execFileAsync(
    "git",
    ["show", "HEAD:README.md"],
    { cwd },
  );
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });

  assert.equal(run.state, "PR_READY");
  assert.equal(published, "preserve me\n");
  assert.equal(builderDelta, "builder delta\n");
  assert.equal(stagedBaseline, "# operator baseline\n");
  assert.equal(status, "");
});

test("speculative builder execution preserves ignored local inputs without publishing them", async (t) => {
  const cwd = await initGitRepo(t, "maswe-ignored-builder-input-");
  await writeFile(path.join(cwd, ".gitignore"), "node_modules/\n", "utf8");
  await execFileAsync("git", ["add", ".gitignore"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "ignore local builder inputs"], { cwd });
  await mkdir(path.join(cwd, "node_modules", "local-tool"), { recursive: true });
  await writeFile(
    path.join(cwd, "node_modules", "local-tool", "input.txt"),
    "trusted local input\n",
    "utf8",
  );
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });

  const run = await new Orchestrator(cwd, config, new IgnoredInputBuilderRuntime()).start(
    "Ignored builder input",
    "Use the trusted local input without publishing it.",
  );
  assert.equal(run.state, "PR_READY");
  const publishedInput = await readFile(path.join(cwd, "builder-input.txt"), "utf8");
  const { stdout: ignoredInCommit } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "--name-only", "HEAD", "--", "node_modules"],
    { cwd },
  );

  assert.equal(publishedInput, "trusted local input\n");
  assert.equal(ignoredInCommit, "");
});

test("seeded ignored inputs cannot become publishable role output", async (t) => {
  const cwd = await initGitRepo(t, "maswe-ignored-builder-secret-");
  await writeFile(path.join(cwd, ".gitignore"), ".env\n", "utf8");
  await execFileAsync("git", ["add", ".gitignore"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "ignore local secrets"], { cwd });
  await writeFile(path.join(cwd, ".env"), "REPOSITORY_TOKEN=do-not-publish\n", "utf8");
  const { stdout: beforeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });

  const run = await new Orchestrator(cwd, config, new UnignoringSecretBuilderRuntime()).start(
    "Ignored secret",
    "Use local inputs without publishing credentials.",
  );
  const { stdout: afterHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  const secretLookup = await execFileAsync("git", ["cat-file", "-e", "HEAD:.env"], {
    cwd,
  }).then(
    () => true,
    () => false,
  );

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /ignore-rule|seeded local inputs/i);
  assert.equal(afterHead.trim(), beforeHead.trim());
  assert.equal(status, "");
  assert.equal(secretLookup, false);
});

test("clean speculative publication rejects an intervening authoritative branch move", async (t) => {
  const cwd = await initGitRepo(t, "maswe-clean-role-cas-");
  await writeFile(path.join(cwd, "baseline.txt"), "B\n", "utf8");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "B"], { cwd });
  const { stdout: beforeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: parentHead } = await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd });
  const { stdout: branch } = await execFileAsync("git", ["branch", "--show-current"], { cwd });
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilderRuntime(), undefined, {
    beforeRoleRefPublish: async () => {
      await execFileAsync(
        "git",
        [
          "update-ref",
          `refs/heads/${branch.trim()}`,
          parentHead.trim(),
          beforeHead.trim(),
        ],
        { cwd },
      );
    },
  });

  const run = await orchestrator.start(
    "Clean role compare-and-swap",
    "Never overwrite an intervening branch move.",
  );
  const { stdout: afterHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /operator reconciliation/i);
  assert.equal(afterHead.trim(), parentHead.trim());
  assert.notEqual(status, "");
});

test("lost role CAS preserves an externally reset winning checkout", async (t) => {
  const cwd = await initGitRepo(t, "maswe-clean-role-reset-cas-");
  await writeFile(path.join(cwd, "baseline.txt"), "B\n", "utf8");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "B"], { cwd });
  const { stdout: parentHead } = await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd });
  const config = testConfig((c) => {
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilderRuntime(), undefined, {
    beforeRoleRefPublish: async () => {
      await execFileAsync("git", ["reset", "--hard", parentHead.trim()], { cwd });
    },
  });

  const run = await orchestrator.start(
    "Winning checkout compare-and-swap",
    "Never mutate an external checkout that wins publication.",
  );
  const { stdout: afterHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });
  const baselineExists = await readFile(path.join(cwd, "baseline.txt"), "utf8").then(
    () => true,
    () => false,
  );
  const builderChangeExists = await readFile(path.join(cwd, "builder-change.txt"), "utf8").then(
    () => true,
    () => false,
  );

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /operator reconciliation/i);
  assert.equal(afterHead.trim(), parentHead.trim());
  assert.equal(status, "");
  assert.equal(baselineExists, false);
  assert.equal(builderChangeExists, false);
});

test("lost role CAS preserves a winning managed worktree", async (t) => {
  const cwd = await initGitRepo(t, "maswe-isolated-role-reset-cas-");
  await writeFile(path.join(cwd, "baseline.txt"), "B\n", "utf8");
  await execFileAsync("git", ["add", "baseline.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "B"], { cwd });
  const { stdout: parentHead } = await execFileAsync("git", ["rev-parse", "HEAD^"], { cwd });
  const config = testConfig((c) => {
    c.policy.useIsolatedWorktree = true;
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  let winningWorktreePath: string | undefined;
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilderRuntime(), undefined, {
    beforeRoleRefPublish: async () => {
      const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd });
      winningWorktreePath = stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length))
        .find((worktreePath) => path.resolve(worktreePath) !== path.resolve(cwd));
      assert.ok(winningWorktreePath);
      await execFileAsync("git", ["reset", "--hard", parentHead.trim()], {
        cwd: winningWorktreePath,
      });
    },
  });

  const run = await orchestrator.start(
    "Managed winning checkout compare-and-swap",
    "Preserve a managed checkout that wins publication.",
  );
  assert.ok(winningWorktreePath);
  t.after(async () => {
    await execFileAsync("git", ["worktree", "remove", "--force", winningWorktreePath!], {
      cwd,
    }).catch(() => undefined);
  });
  const { stdout: registrations } = await execFileAsync(
    "git",
    ["worktree", "list", "--porcelain"],
    { cwd },
  );
  const registeredWorktreePaths = registrations
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)))
    .sort();

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /operator reconciliation/i);
  assert.deepEqual(
    registeredWorktreePaths,
    [cwd, winningWorktreePath].map((worktreePath) => path.resolve(worktreePath)).sort(),
  );
  assert.equal(
    (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: winningWorktreePath })).stdout.trim(),
    parentHead.trim(),
  );
  assert.equal(
    (await execFileAsync("git", ["status", "--porcelain"], { cwd: winningWorktreePath })).stdout,
    "",
  );
});

test("failed dirty builder publication restores the exact allowed baseline", async (t) => {
  const cwd = await initGitRepo(t, "maswe-dirty-builder-rollback-");
  await writeFile(path.join(cwd, "README.md"), "# staged operator baseline\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await writeFile(path.join(cwd, "operator-change.txt"), "untracked operator baseline\n", "utf8");
  const { stdout: beforeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: beforeStatus } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1"],
    { cwd },
  );
  const config = testConfig((c) => {
    c.policy.allowDirtyWorkspace = true;
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingBuilderRuntime(), undefined, {
    afterDirtyRoleDeltaApplied: async () => {
      throw new Error("simulated dirty builder publication failure");
    },
  });

  const run = await orchestrator.start(
    "Rollback dirty build",
    "Restore the exact operator baseline if publication fails.",
  );
  const { stdout: afterHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: afterStatus } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1"],
    { cwd },
  );

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /simulated dirty builder publication failure/i);
  assert.equal(afterHead.trim(), beforeHead.trim());
  assert.equal(afterStatus, beforeStatus);
  assert.doesNotMatch(afterStatus, /builder-change\.txt/);
});

test("allowed dirty workspace changes are included in speculative resolver publication", async (t) => {
  const cwd = await initGitRepo(t, "maswe-allowed-dirty-resolver-");
  const config = testConfig((c) => {
    c.policy.allowDirtyWorkspace = true;
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(cwd, config, new EditingResolverRuntime());
  let run = await orchestrator.start(
    "Allowed dirty resolution",
    "Preserve and publish the allowed workspace baseline.",
  );
  run = await orchestrator.markPrOpened(run.id);
  await writeFile(path.join(cwd, "README.md"), "# operator resolver baseline\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await writeFile(path.join(cwd, "operator-change.txt"), "preserve resolver baseline\n", "utf8");

  run = await orchestrator.receiveReviewComment(run.id, "Please apply the resolver change.");
  const { stdout: published } = await execFileAsync(
    "git",
    ["show", "HEAD:operator-change.txt"],
    { cwd },
  );
  const { stdout: resolverDelta } = await execFileAsync(
    "git",
    ["show", "HEAD:resolver-change.txt"],
    { cwd },
  );
  const { stdout: stagedBaseline } = await execFileAsync(
    "git",
    ["show", "HEAD:README.md"],
    { cwd },
  );
  const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], { cwd });

  assert.equal(run.state, "PR_REVIEW");
  assert.equal(published, "preserve resolver baseline\n");
  assert.equal(resolverDelta, "resolver delta\n");
  assert.equal(stagedBaseline, "# operator resolver baseline\n");
  assert.equal(status, "");
});

test("failed dirty resolver publication restores the exact allowed baseline", async (t) => {
  const cwd = await initGitRepo(t, "maswe-dirty-resolver-rollback-");
  const config = testConfig((c) => {
    c.policy.allowDirtyWorkspace = true;
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });
  const orchestrator = new Orchestrator(
    cwd,
    config,
    new EditingResolverRuntime(),
    undefined,
    {
      afterDirtyRoleDeltaApplied: async () => {
        throw new Error("simulated dirty resolver publication failure");
      },
    },
  );
  let run = await orchestrator.start(
    "Rollback dirty resolution",
    "Restore the exact operator baseline if resolver publication fails.",
  );
  run = await orchestrator.markPrOpened(run.id);
  await writeFile(path.join(cwd, "README.md"), "# staged resolver baseline\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await writeFile(path.join(cwd, "operator-change.txt"), "untracked resolver baseline\n", "utf8");
  const { stdout: beforeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: beforeStatus } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1"],
    { cwd },
  );

  run = await orchestrator.receiveReviewComment(run.id, "Please apply the resolver change.");
  const { stdout: afterHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: afterStatus } = await execFileAsync(
    "git",
    ["status", "--porcelain=v1"],
    { cwd },
  );

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /simulated dirty resolver publication failure/i);
  assert.equal(afterHead.trim(), beforeHead.trim());
  assert.equal(afterStatus, beforeStatus);
  assert.doesNotMatch(afterStatus, /resolver-change\.txt/);
});

test("tracked MASWE control-plane changes are never included in builder publication", async (t) => {
  const cwd = await initGitRepo(t, "maswe-tracked-control-plane-");
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });
  await writeFile(path.join(cwd, ".maswe", "tracked.txt"), "committed control\n", "utf8");
  await execFileAsync("git", ["add", "-f", ".maswe/tracked.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "track control plane fixture"], { cwd });
  const { stdout: beforeHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  await writeFile(path.join(cwd, ".maswe", "tracked.txt"), "private runtime state\n", "utf8");
  const config = testConfig((c) => {
    c.policy.allowDirtyWorkspace = true;
    c.gates.requireBrainstormApproval = false;
    c.gates.requireDesignApproval = false;
    c.quality.commands = [];
  });

  const run = await new Orchestrator(cwd, config, new MockRuntime()).start(
    "Protected control plane",
    "Never publish MASWE state.",
  );
  const { stdout: afterHead } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  const { stdout: committedControl } = await execFileAsync(
    "git",
    ["show", "HEAD:.maswe/tracked.txt"],
    { cwd },
  );

  assert.equal(run.state, "FAILED");
  assert.match(run.failure?.message ?? "", /MASWE control-plane/i);
  assert.equal(afterHead.trim(), beforeHead.trim());
  assert.equal(committedControl, "committed control\n");
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
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# retry\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
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
