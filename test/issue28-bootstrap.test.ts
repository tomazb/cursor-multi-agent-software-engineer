import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import * as gitSnapshot from "../src/git-snapshot.ts";
import * as gitWorkspace from "../src/git-workspace.ts";
import { gitWorkspaceFingerprint } from "../src/git-snapshot.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  AgentRuntime,
  MasweConfig,
  RunRecord,
  RuntimeDoctorResult,
  RuntimeRequest,
  RuntimeResult,
  WorkspaceBootstrapIntent,
  WorkflowEventType,
} from "../src/domain.ts";
import {
  externalWorktreePath,
  type GitWorktreeRegistration,
  listGitWorktreeRegistrations,
  workingDirectoryFor,
} from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import { FileRunStore, type CreateRunOptions, type RunStore } from "../src/store.ts";
import { captureWorkspaceBootstrapIntent } from "../src/workspace-bootstrap.ts";

const execFileAsync = promisify(execFile);

type SourceFingerprint = (cwd: string, timeoutMs?: number) => Promise<string>;
type PorcelainParser = (output: string) => GitWorktreeRegistration[];

function captureWorkspaceSourceFingerprint(cwd: string): Promise<string> {
  const candidate = (
    gitSnapshot as typeof gitSnapshot & {
      captureWorkspaceSourceFingerprint?: SourceFingerprint;
    }
  ).captureWorkspaceSourceFingerprint;
  if (typeof candidate !== "function") {
    assert.fail("captureWorkspaceSourceFingerprint must be exported");
  }
  return candidate(cwd);
}

function parseWorktreeRegistrations(output: string): GitWorktreeRegistration[] {
  const candidate = (
    gitWorkspace as typeof gitWorkspace & {
      parseGitWorktreeRegistrationsPorcelain?: PorcelainParser;
    }
  ).parseGitWorktreeRegistrationsPorcelain;
  if (typeof candidate !== "function") {
    assert.fail("parseGitWorktreeRegistrationsPorcelain must be exported");
  }
  return candidate(output);
}

async function initRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-bootstrap-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# demo\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function plannedRun(store: FileRunStore, cwd: string, config: MasweConfig): Promise<RunRecord> {
  return store.create("Bootstrap recovery", "Reconcile the exact workspace.", config, {
    workspaceBootstrap: await captureWorkspaceBootstrapIntent(cwd, config),
  });
}

class CountingRuntime implements AgentRuntime {
  executions = 0;

  async execute(request: RuntimeRequest): Promise<RuntimeResult> {
    this.executions += 1;
    return new MockRuntime().execute(request);
  }

  doctor(): Promise<RuntimeDoctorResult> {
    return new MockRuntime().doctor();
  }

  listModels(): Promise<string[]> {
    return new MockRuntime().listModels();
  }
}

class StartInjectionStore implements RunStore {
  private readonly delegate: FileRunStore;
  private readonly mode: "before" | "complete-clone-after" | "altered-after";

  constructor(
    delegate: FileRunStore,
    mode: "before" | "complete-clone-after" | "altered-after",
  ) {
    this.delegate = delegate;
    this.mode = mode;
  }

  create(title: string, request: string, config: MasweConfig, options: CreateRunOptions = {}) {
    return this.delegate.create(title, request, config, options);
  }
  save(run: RunRecord) {
    return this.delegate.save(run);
  }
  load(runId: string) {
    return this.delegate.load(runId);
  }
  list() {
    return this.delegate.list();
  }
  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (type !== "START") return this.delegate.applyEvent(run, type, actor, details);
    if (this.mode === "before") throw new Error("simulated START pre-publication failure");
    await this.delegate.applyEvent(
      this.mode === "complete-clone-after" ? structuredClone(run) : run,
      type,
      actor,
      details,
    );
    if (this.mode === "complete-clone-after") {
      throw new Error("simulated exact independent START publication");
    }
    const altered = await this.delegate.load(run.id);
    altered.title = "altered after START";
    await this.delegate.save(altered);
    throw new Error("simulated ambiguous START publication");
  }
  writeArtifact(run: RunRecord, name: string, content: string) {
    return this.delegate.writeArtifact(run, name, content);
  }
  readArtifact(run: RunRecord, name: string) {
    return this.delegate.readArtifact(run, name);
  }
}

async function nonGitDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "maswe-issue28-bootstrap-nongit-"));
}

function isolatedConfig(): MasweConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = true;
  config.quality.commands = [];
  return config;
}

async function assertNoBootstrapGitSideEffects(
  cwd: string,
  runId: string,
): Promise<void> {
  const excludePath = (
    await execFileAsync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd })
  ).stdout.trim();
  let exclude = "";
  try {
    exclude = await readFile(
      path.isAbsolute(excludePath) ? excludePath : path.join(cwd, excludePath),
      "utf8",
    );
  } catch {
    // A missing exclude file is also proof that bootstrap did not create or update it.
  }
  assert.doesNotMatch(exclude, /^\.maswe\/$/m);

  const branch = await execFileAsync("git", ["branch", "--list", `maswe/${runId}`], { cwd });
  assert.equal(branch.stdout, "", "bootstrap must not create the deterministic branch");
  await assert.rejects(
    access(externalWorktreePath(cwd, runId)),
    "bootstrap must not create the deterministic worktree",
  );
}

async function assertCompleteIsolatedBootstrapIntent(
  cwd: string,
  run: { workspaceBootstrap?: WorkspaceBootstrapIntent },
): Promise<void> {
  const intent = run.workspaceBootstrap;
  assert.ok(intent, "durable run must include workspace bootstrap intent");
  assert.equal(intent.mode, "isolated-worktree");
  assert.equal(intent.sourceBaseSha, (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim());
  assert.equal(intent.sourceBranch, (await execFileAsync("git", ["branch", "--show-current"], { cwd })).stdout.trim());
  assert.equal(intent.sourceTreeFingerprint, await captureWorkspaceSourceFingerprint(cwd));
  assert.match(intent.plannedAt, /^\d{4}-\d{2}-\d{2}T/);
}

test("Git bootstrap source fingerprint excludes .maswe state", async () => {
  const cwd = await initRepo();
  const runPath = path.join(cwd, ".maswe", "runs", "run-1", "run.json");
  await mkdir(path.dirname(runPath), { recursive: true });
  await writeFile(runPath, '{"id":"run-1","title":"before"}\n', "utf8");

  const sourceBefore = await captureWorkspaceSourceFingerprint(cwd);
  const authoritativeBefore = await gitWorkspaceFingerprint(cwd);
  await writeFile(runPath, '{"id":"run-1","title":"after"}\n', "utf8");
  assert.equal(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    ".maswe run state must not affect bootstrap source identity",
  );
  assert.notEqual(
    await gitWorkspaceFingerprint(cwd),
    authoritativeBefore,
    "authoritative fingerprint must retain read-only .maswe enforcement",
  );
});

test("Git bootstrap source fingerprint hashes unstaged diff bytes beyond status", async () => {
  const cwd = await initRepo();
  const readme = path.join(cwd, "README.md");

  await writeFile(readme, "# first unstaged content\n", "utf8");
  const first = await captureWorkspaceSourceFingerprint(cwd);
  const firstStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(firstStatus.stdout, " M README.md\n");

  await writeFile(readme, "# second unstaged content\n", "utf8");
  const second = await captureWorkspaceSourceFingerprint(cwd);
  const secondStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(secondStatus.stdout, firstStatus.stdout);
  assert.notEqual(second, first, "unstaged diff bytes must affect source identity");
});

test("Git bootstrap source fingerprint hashes staged diff bytes beyond status", async () => {
  const cwd = await initRepo();
  const readme = path.join(cwd, "README.md");

  await writeFile(readme, "# first staged content\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  const first = await captureWorkspaceSourceFingerprint(cwd);
  const firstStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(firstStatus.stdout, "M  README.md\n");

  await writeFile(readme, "# second staged content\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  const second = await captureWorkspaceSourceFingerprint(cwd);
  const secondStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(secondStatus.stdout, firstStatus.stdout);
  assert.notEqual(second, first, "staged diff bytes must affect source identity");
});

test("Git bootstrap source fingerprint hashes untracked bytes beyond status and path", async () => {
  const cwd = await initRepo();
  const untracked = path.join(cwd, "untracked.txt");

  await writeFile(untracked, "first untracked content\n", "utf8");
  const first = await captureWorkspaceSourceFingerprint(cwd);
  const firstStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(firstStatus.stdout, "?? untracked.txt\n");

  await writeFile(untracked, "second untracked content\n", "utf8");
  const second = await captureWorkspaceSourceFingerprint(cwd);
  const secondStatus = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd });
  assert.equal(secondStatus.stdout, firstStatus.stdout);
  assert.notEqual(second, first, "untracked bytes must affect source identity");
});

test("non-Git bootstrap source fingerprint excludes .maswe and tracks source files", async () => {
  const cwd = await nonGitDir();
  const runPath = path.join(cwd, ".maswe", "runs", "run-1", "run.json");
  await mkdir(path.dirname(runPath), { recursive: true });
  await writeFile(runPath, '{"id":"run-1","title":"before"}\n', "utf8");
  await writeFile(path.join(cwd, "README.md"), "# source\n", "utf8");

  const sourceBefore = await captureWorkspaceSourceFingerprint(cwd);
  const authoritativeBefore = await gitWorkspaceFingerprint(cwd);
  await writeFile(runPath, '{"id":"run-1","title":"after"}\n', "utf8");
  assert.equal(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    ".maswe run state must not affect non-Git bootstrap source identity",
  );
  assert.notEqual(
    await gitWorkspaceFingerprint(cwd),
    authoritativeBefore,
    "authoritative fingerprint must retain non-Git read-only .maswe enforcement",
  );

  await writeFile(path.join(cwd, "README.md"), "# changed source\n", "utf8");
  assert.notEqual(
    await captureWorkspaceSourceFingerprint(cwd),
    sourceBefore,
    "non-Git source content must affect bootstrap source identity",
  );
});

test("non-Git source fingerprint fails closed when the source root cannot be enumerated", {
  skip: process.platform === "win32",
}, async (t) => {
  const cwd = await nonGitDir();
  t.after(async () => {
    await chmod(cwd, 0o700);
    await rm(cwd, { recursive: true, force: true });
  });
  await chmod(cwd, 0o111);

  await assert.rejects(
    captureWorkspaceSourceFingerprint(cwd),
    /EACCES|permission denied|enumerat/i,
  );
});

test("non-Git source fingerprint length framing separates an embedded-record adversarial pair", async (t) => {
  const single = await nonGitDir();
  const split = await nonGitDir();
  t.after(async () => {
    await rm(single, { recursive: true, force: true });
    await rm(split, { recursive: true, force: true });
  });
  await writeFile(
    path.join(single, "a"),
    Buffer.concat([Buffer.from("left"), Buffer.from("b\0file\0right")]),
  );
  await writeFile(path.join(split, "a"), "left");
  await writeFile(path.join(split, "b"), "right");

  assert.notEqual(
    await captureWorkspaceSourceFingerprint(single),
    await captureWorkspaceSourceFingerprint(split),
    "distinct trees must not collide when file payload bytes mimic the next path/type record",
  );
});

test("start persists complete bootstrap intent before any Git bootstrap side effect", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), undefined, {
    beforeBootstrapReconcile: async () => {
      throw new Error("interrupt after durable start intent");
    },
  });

  await assert.rejects(
    orchestrator.start("Persist start intent", "Stop before workspace reconciliation."),
    /interrupt after durable start intent/,
  );

  const [created] = await orchestrator.store.list();
  const run = await orchestrator.store.load(created!.id);
  assert.equal(run.state, "CREATED");
  assert.equal(run.workspace, undefined);
  await assertCompleteIsolatedBootstrapIntent(cwd, run);
  await assertNoBootstrapGitSideEffects(cwd, run.id);
});

test("supersede persists linked bootstrap intent before any Git bootstrap side effect", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const originalOrchestrator = new Orchestrator(cwd, config, new MockRuntime());
  const original = await originalOrchestrator.store.create(
    "Original run",
    "Create a replacement before reconciliation.",
    config,
  );
  const orchestrator = new Orchestrator(cwd, config, new MockRuntime(), originalOrchestrator.store, {
    beforeBootstrapReconcile: async () => {
      throw new Error("interrupt after durable supersede intent");
    },
  });

  await assert.rejects(
    orchestrator.supersede(original.id),
    /interrupt after durable supersede intent/,
  );

  const runs = await orchestrator.store.list();
  const replacementId = runs.find((run) => run.id !== original.id)?.id;
  assert.ok(replacementId, "replacement must be durably created");
  const replacement = await orchestrator.store.load(replacementId);
  assert.equal(replacement.state, "CREATED");
  assert.equal(replacement.workspace, undefined);
  assert.equal(replacement.supersedes, original.id);
  await assertCompleteIsolatedBootstrapIntent(cwd, replacement);
  await assertNoBootstrapGitSideEffects(cwd, replacement.id);
});

test("bootstrap barriers fail from authoritative CREATED state without running a role", async (t) => {
  for (const barrier of [
    "beforeBranchCreate",
    "afterBranchCreate",
    "afterWorktreeCreate",
    "afterWorkspaceCheckpoint",
  ] as const) {
    await t.test(barrier, async () => {
      const cwd = await initRepo();
      const runtime = new CountingRuntime();
      const config = isolatedConfig();
      const hook = async () => {
        throw new Error(`interrupt at ${barrier}`);
      };
      const options = {
        automaticTransitionLimit: 20,
        ...(barrier === "afterWorkspaceCheckpoint"
          ? { afterWorkspaceCheckpoint: hook }
          : { bootstrapHooks: { [barrier]: hook } }),
      };
      const orchestrator = new Orchestrator(cwd, config, runtime, undefined, options);

      const result = await orchestrator.start("Barrier", `Stop at ${barrier}.`);
      const authoritative = await orchestrator.store.load(result.id);

      assert.equal(authoritative.state, "FAILED");
      assert.equal(authoritative.failure?.resumeState, "CREATED");
      assert.ok(authoritative.workspaceBootstrap);
      assert.equal(authoritative.events.filter((event) => event.type === "START").length, 0);
      assert.equal(runtime.executions, 0, "no role may execute before authoritative START");
      if (barrier === "afterWorkspaceCheckpoint") {
        assert.ok(authoritative.workspace?.worktreePath, "checkpointed workspace must survive failure");
        await access(authoritative.workspace.worktreePath);
        const registrations = await listGitWorktreeRegistrations(cwd);
        assert.ok(
          registrations.some(
            (registration) =>
              registration.worktreePath === path.resolve(authoritative.workspace!.worktreePath!) &&
              registration.branch === authoritative.workspace!.branch,
          ),
          "checkpointed worktree registration must survive failure publication",
        );
      } else {
        assert.equal(authoritative.workspace, undefined);
      }
    });
  }
});

test("bootstrap rejects staged, unstaged, and non-ignored untracked worktree dirt before checkpoint", async (t) => {
  for (const dirtyKind of ["staged", "unstaged", "untracked"] as const) {
    await t.test(dirtyKind, async () => {
      const cwd = await initRepo();
      const config = isolatedConfig();
      const orchestrator = new Orchestrator(cwd, config, new CountingRuntime(), undefined, {
        bootstrapHooks: {
          afterWorktreeCreate: async (run: RunRecord) => {
            const worktreePath = externalWorktreePath(cwd, run.id);
            if (dirtyKind === "untracked") {
              await writeFile(path.join(worktreePath, "new.txt"), "untracked\n", "utf8");
              return;
            }
            await writeFile(path.join(worktreePath, "README.md"), `${dirtyKind}\n`, "utf8");
            if (dirtyKind === "staged") {
              await execFileAsync("git", ["add", "README.md"], { cwd: worktreePath });
            }
          },
        },
      });

      const result = await orchestrator.start("Dirty bootstrap", dirtyKind);
      const authoritative = await orchestrator.store.load(result.id);

      assert.equal(authoritative.state, "FAILED");
      assert.equal(authoritative.failure?.resumeState, "CREATED");
      assert.equal(authoritative.workspace, undefined, "dirty workspace must not be checkpointed");
      assert.equal(authoritative.events.some((event) => event.type === "START"), false);
    });
  }
});

test("bootstrap revalidates checkpoint cleanliness before START", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const sentinelBytes = Buffer.from("dirty sentinel must survive exactly\n\0binary tail", "utf8");
  const orchestrator = new Orchestrator(cwd, config, new CountingRuntime(), undefined, {
    afterWorkspaceCheckpoint: async (checkpoint: RunRecord) => {
      const authoritative = await orchestrator.store.load(checkpoint.id);
      assert.equal(authoritative.state, "CREATED");
      assert.ok(authoritative.workspaceBootstrap);
      assert.deepEqual(authoritative.workspace, checkpoint.workspace);
      assert.equal(authoritative.events.length, 0);
      await writeFile(
        path.join(authoritative.workspace!.worktreePath!, "after-checkpoint.txt"),
        sentinelBytes,
      );
    },
  });

  const result = await orchestrator.start("Checkpoint dirt", "Reject dirt before START.");
  const authoritative = await orchestrator.store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CREATED");
  assert.ok(authoritative.workspace?.worktreePath);
  assert.ok(authoritative.workspaceBootstrap);
  assert.equal(authoritative.events.some((event) => event.type === "START"), false);
  const checkpointedPath = authoritative.workspace.worktreePath;
  await access(checkpointedPath);
  assert.deepEqual(
    await readFile(path.join(checkpointedPath, "after-checkpoint.txt")),
    sentinelBytes,
    "bootstrap failure publication must preserve dirty untracked bytes exactly",
  );
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.ok(
    registrations.some(
      (registration) =>
        registration.worktreePath === path.resolve(checkpointedPath) &&
        registration.branch === authoritative.workspace!.branch,
    ),
    "dirty checkpointed worktree registration must survive failure publication",
  );
});

test("bootstrap rejects exact-path registration on the wrong branch", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);
  const worktreePath = externalWorktreePath(cwd, run.id);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["branch", "alternate", "HEAD"], { cwd });
  await execFileAsync("git", ["worktree", "add", worktreePath, "alternate"], { cwd });

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.match(
    authoritative.failure?.message ?? "",
    /deterministic path is registered to the wrong branch/i,
  );
  assert.equal(authoritative.workspace, undefined);
});

test("bootstrap rejects a deterministic branch at the wrong HEAD", async () => {
  const cwd = await initRepo();
  await writeFile(path.join(cwd, "second.txt"), "second\n", "utf8");
  await execFileAsync("git", ["add", "second.txt"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "second"], { cwd });
  const config = isolatedConfig();
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);
  await execFileAsync("git", ["branch", `maswe/${run.id}`, "HEAD~1"], { cwd });

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.match(authoritative.failure?.message ?? "", /deterministic branch has the wrong HEAD/i);
  assert.equal(authoritative.workspace, undefined);
});

test("bootstrap rejects its deterministic branch registered at an alternate path", async () => {
  const cwd = await initRepo();
  const alternatePath = await mkdtemp(path.join(os.tmpdir(), "maswe-alternate-registration-"));
  await rm(alternatePath, { recursive: true, force: true });
  const config = isolatedConfig();
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);
  await execFileAsync("git", ["branch", `maswe/${run.id}`, "HEAD"], { cwd });
  await execFileAsync("git", ["worktree", "add", alternatePath, `maswe/${run.id}`], { cwd });

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.match(
    authoritative.failure?.message ?? "",
    /deterministic branch is registered at an alternate path/i,
  );
  assert.equal(authoritative.workspace, undefined);
});

test("bootstrap rejects an occupied unregistered deterministic path", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);
  const worktreePath = externalWorktreePath(cwd, run.id);
  await mkdir(worktreePath, { recursive: true });
  await writeFile(path.join(worktreePath, "occupied.txt"), "occupied\n", "utf8");

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.match(authoritative.failure?.message ?? "", /occupied|unregistered/i);
  assert.equal(authoritative.workspace, undefined);
});

test("bootstrap rejects a stale prunable deterministic registration", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);
  const worktreePath = externalWorktreePath(cwd, run.id);
  await mkdir(path.dirname(worktreePath), { recursive: true });
  await execFileAsync("git", ["branch", `maswe/${run.id}`, "HEAD"], { cwd });
  await execFileAsync("git", ["worktree", "add", worktreePath, `maswe/${run.id}`], { cwd });
  await rm(worktreePath, { recursive: true, force: true });

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.match(authoritative.failure?.message ?? "", /prunable|stale/i);
  assert.equal(authoritative.workspace, undefined);
});

test("bootstrap rejects operator source drift after durable intent", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  config.policy.useIsolatedWorktree = false;
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);
  await writeFile(path.join(cwd, "README.md"), "# drifted\n", "utf8");

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.match(authoritative.failure?.message ?? "", /source|drift|fingerprint/i);
  assert.equal(authoritative.events.some((event) => event.type === "START"), false);
});

test("isolated working directory never falls back to the operator checkout", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const store = new FileRunStore(cwd);
  const run = await plannedRun(store, cwd, config);

  assert.throws(
    () => workingDirectoryFor(run),
    /requires an established MASWE-managed worktree/,
  );
});

test("structured worktree inspection accepts and omits a bare main repository record", async () => {
  const source = await initRepo();
  const bare = await mkdtemp(path.join(os.tmpdir(), "maswe-bare-registration-"));
  await rm(bare, { recursive: true, force: true });
  await execFileAsync("git", ["clone", "-q", "--bare", source, bare]);
  const linked = await mkdtemp(path.join(os.tmpdir(), "maswe-bare-linked-"));
  await rm(linked, { recursive: true, force: true });
  await execFileAsync("git", ["worktree", "add", linked], { cwd: bare });

  const registrations = await listGitWorktreeRegistrations(bare);
  assert.deepEqual(registrations, [
    {
      worktreePath: path.resolve(linked),
      headSha: (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: linked })).stdout.trim(),
      branch: path.basename(linked),
      prunable: false,
    },
  ]);
});

test("structured worktree parser rejects ambiguous marker combinations and duplicate bare records", () => {
  const sha = "a".repeat(40);
  const malformed = [
    `worktree /tmp/detached-and-branch\0HEAD ${sha}\0detached\0branch refs/heads/topic\0\0`,
    `worktree /tmp/no-checkout-marker\0HEAD ${sha}\0\0`,
    `worktree /tmp/duplicate-detached\0HEAD ${sha}\0detached\0detached\0\0`,
    `worktree /tmp/duplicate-locked\0HEAD ${sha}\0detached\0locked first\0locked second\0\0`,
    "worktree /tmp/bare-one\0bare\0\0worktree /tmp/bare-two\0bare\0\0",
  ];

  for (const output of malformed) {
    assert.throws(
      () => parseWorktreeRegistrations(output),
      /malformed|conflicting/i,
    );
  }
});

test("checkpoint outcome unknown reloads and fails the authoritative actionable checkpoint", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  let inject = true;
  const store = new FileRunStore(cwd, {
    syncDirectory: async (directoryPath) => {
      if (!inject) return;
      try {
        const observed = JSON.parse(
          await readFile(path.join(directoryPath, "run.json"), "utf8"),
        ) as RunRecord;
        if (observed.state === "CREATED" && observed.workspace?.worktreePath) {
          inject = false;
          throw new Error("simulated checkpoint directory sync failure");
        }
      } catch (error) {
        if (!inject) throw error;
      }
    },
  });
  const run = await plannedRun(store, cwd, config);

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await store.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CREATED");
  assert.ok(authoritative.workspace?.worktreePath);
  assert.ok(authoritative.workspaceBootstrap);
});

test("START outcome unknown adopts only the exact complete START publication", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const initialStore = new FileRunStore(cwd);
  const run = await plannedRun(initialStore, cwd, config);
  let inject = true;
  const outcomeUnknownStore = new FileRunStore(cwd, {
    syncDirectory: async (directoryPath) => {
      if (!inject) return;
      try {
        const observed = JSON.parse(
          await readFile(path.join(directoryPath, "run.json"), "utf8"),
        ) as RunRecord;
        if (observed.state === "BRAINSTORMING" && observed.events.at(-1)?.type === "START") {
          inject = false;
          throw new Error("simulated START directory sync failure");
        }
      } catch (error) {
        if (!inject) throw error;
      }
    },
  });

  const result = await new Orchestrator(
    cwd,
    config,
    new CountingRuntime(),
    outcomeUnknownStore,
  ).bootstrapCreatedRun(run.id);
  const authoritative = await initialStore.load(result.id);
  assert.equal(authoritative.state, "BRAINSTORMING");
  assert.equal(authoritative.workspaceBootstrap, undefined);
  assert.ok(authoritative.workspace?.worktreePath);
  assert.equal(authoritative.events.filter((event) => event.type === "START").length, 1);
});

test("START pre-publication failure reloads and fails the exact CREATED checkpoint", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const delegate = new FileRunStore(cwd);
  const run = await plannedRun(delegate, cwd, config);
  const store = new StartInjectionStore(delegate, "before");

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await delegate.load(result.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "CREATED");
  assert.ok(authoritative.workspaceBootstrap);
  assert.ok(authoritative.workspace?.worktreePath);
  assert.equal(authoritative.events.some((event) => event.type === "START"), false);
  await access(authoritative.workspace.worktreePath);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.ok(
    registrations.some(
      (registration) =>
        registration.worktreePath === path.resolve(authoritative.workspace!.worktreePath!) &&
        registration.branch === authoritative.workspace!.branch,
    ),
    "START pre-publication failure must preserve the checkpointed registration",
  );
});

test("START recovery adopts an exact complete publication written from an independent clone", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const delegate = new FileRunStore(cwd);
  const run = await plannedRun(delegate, cwd, config);
  const store = new StartInjectionStore(delegate, "complete-clone-after");

  const result = await new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id);
  const authoritative = await delegate.load(result.id);
  assert.equal(authoritative.state, "BRAINSTORMING");
  assert.equal(authoritative.workspaceBootstrap, undefined);
  assert.equal(authoritative.events.filter((event) => event.type === "START").length, 1);
});

test("START recovery rejects an altered authoritative publication", async () => {
  const cwd = await initRepo();
  const config = isolatedConfig();
  const delegate = new FileRunStore(cwd);
  const run = await plannedRun(delegate, cwd, config);
  const store = new StartInjectionStore(delegate, "altered-after");

  await assert.rejects(
    new Orchestrator(cwd, config, new CountingRuntime(), store).bootstrapCreatedRun(run.id),
    /bootstrap publication outcome is ambiguous/i,
  );
  const authoritative = await delegate.load(run.id);
  assert.equal(authoritative.state, "BRAINSTORMING");
  assert.equal(authoritative.title, "altered after START");
});
