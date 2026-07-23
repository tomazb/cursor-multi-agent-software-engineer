import assert from "node:assert/strict";
import { link, mkdtemp, mkdir, writeFile, readFile, rm, access, open } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_CONFIG, assertConfig, migrateConfig } from "../src/config.ts";
import {
  pickCatalogueModel,
  resolveConfigModels,
  resolveProjectModels,
  validatePersistedExactModel,
  resolveLogicalModelId,
} from "../src/model-resolution.ts";
import {
  CursorCliRuntime,
  extractCursorCliOutput,
  parseModelCatalogueIds,
} from "../src/runtimes/cursor-cli.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { gitChangedFiles } from "../src/git-snapshot.ts";
import {
  cleanupDoctorProbeResources,
  ensureRunWorkspace,
  externalWorktreePath,
} from "../src/git-workspace.ts";
import type { AgentRuntime, RuntimeDoctorResult, RuntimeRequest, RuntimeResult } from "../src/domain.ts";

const execFileAsync = promisify(execFile);

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function initRepo(prefix: string): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  await execFileAsync("git", ["init"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# probe\n");
  await execFileAsync("git", ["add", "."], { cwd });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd });
  return cwd;
}

async function installLinkLock(
  lockPath: string,
  meta: { pid: number; owner: string; at: string },
): Promise<void> {
  const tmp = `${lockPath}.${meta.owner}.tmp`;
  await writeFile(tmp, `${JSON.stringify(meta)}\n`, "utf8");
  await link(tmp, lockPath);
  await rm(tmp, { force: true });
}

async function readLockOwner(lockPath: string): Promise<string | undefined> {
  try {
    const meta = JSON.parse(await readFile(lockPath, "utf8")) as { owner?: string };
    return meta.owner;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// 1. Structured catalogue parsing
// ---------------------------------------------------------------------------

test("catalogue parser ignores headings, aliases, metadata, prose, and annotations", () => {
  const catalogue = `
Available models:
alias: old-model-1
metadata: build-42
context-200k
recommended model is gpt-4-turbo
# Models
## Catalogue
(default)
  - see also gpt-4-turbo in docs
prose before
  cursor-grok-4.5-high - also mentions gpt-4-turbo (recommended)
prose after
`;
  const ids = parseModelCatalogueIds(catalogue);
  assert.equal(ids.has("old-model-1"), false);
  assert.equal(ids.has("build-42"), false);
  assert.equal(ids.has("context-200k"), false);
  assert.equal(ids.has("gpt-4-turbo"), false);
  assert.equal(ids.has("default"), false);
  assert.equal(ids.has("cursor-grok-4.5-high"), true);
  assert.equal(ids.size, 1);
});

test("catalogue parser accepts plain, indented, selected, and decorated rows", () => {
  const catalogue = [
    "Available models:",
    "gpt-5.6-sol-high",
    "  cursor-grok-4.5-high",
    "* cursor-claude-fable-5-high (default)",
    "> composer-2.5",
    "\x1b[32mcursor-gpt-5.4-high\x1b[0m - Cursor GPT",
    "  model+plus-1.0",
    "  dotted.model-2",
  ].join("\n");
  const ids = parseModelCatalogueIds(catalogue);
  assert.equal(ids.has("gpt-5.6-sol-high"), true);
  assert.equal(ids.has("cursor-grok-4.5-high"), true);
  assert.equal(ids.has("cursor-claude-fable-5-high"), true);
  assert.equal(ids.has("composer-2.5"), true);
  assert.equal(ids.has("cursor-gpt-5.4-high"), true);
  assert.equal(ids.has("model+plus-1.0"), true);
  assert.equal(ids.has("dotted.model-2"), true);
  assert.equal(ids.has("available"), false);
});

test("catalogue parser takes only the first model-ID field per row", () => {
  const ids = parseModelCatalogueIds(
    "  cursor-grok-4.5-high - fallback would be cursor-grok-4.5-medium\n",
  );
  assert.deepEqual([...ids], ["cursor-grok-4.5-high"]);
});

// ---------------------------------------------------------------------------
// 2. Empty / unparseable catalogue fail-closed
// ---------------------------------------------------------------------------

test("Cursor listModels fails closed on empty stdout with exit 0", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  const runtime = new CursorCliRuntime(config, {
    cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-empty-cat-")),
    spawnFn: async (_c, args) => {
      if (args[0] === "models") {
        return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });
  await assert.rejects(() => runtime.listModels(), /no executable model IDs|catalogue/i);
});

test("Cursor listModels fails closed on headings-only and unrecognized prose", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  for (const stdout of ["Available models:\n", "No models here, just prose.\n"]) {
    const runtime = new CursorCliRuntime(config, {
      cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-prose-cat-")),
      spawnFn: async (_c, args) => {
        if (args[0] === "models") {
          return { exitCode: 0, stdout, stderr: "hint: run login", durationMs: 1 };
        }
        return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
      },
    });
    await assert.rejects(() => runtime.listModels(), /no executable model IDs|unrecognized|catalogue/i);
  }
});

test("Cursor listModels fails closed on nonzero exit and timeout", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  const nonzero = new CursorCliRuntime(config, {
    cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-nz-cat-")),
    spawnFn: async () => ({ exitCode: 2, stdout: "", stderr: "auth failed", durationMs: 1 }),
  });
  await assert.rejects(() => nonzero.listModels(), /exit 2|Failed to list models/i);

  const timedOut = new CursorCliRuntime(config, {
    cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-to-cat-")),
    spawnFn: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "",
      durationMs: 1,
      timedOut: true,
    }),
  });
  await assert.rejects(() => timedOut.listModels(), /timed out|Failed to list models|catalogue/i);
});

test("Cursor listModels resolves a valid catalogue", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  const runtime = new CursorCliRuntime(config, {
    cwd: await mkdtemp(path.join(os.tmpdir(), "maswe-ok-cat-")),
    spawnFn: async (_c, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "Available models:\n  cursor-grok-4.5-high\n",
          stderr: "",
          durationMs: 1,
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });
  assert.deepEqual(await runtime.listModels(), ["cursor-grok-4.5-high"]);
});

// ---------------------------------------------------------------------------
// 3. Persisted exact IDs never re-resolved
// ---------------------------------------------------------------------------

test("resolveProjectModels persists exact IDs; validatePersistedExactModel never substitutes", () => {
  const catalogue = [
    "cursor-grok-4.5-high",
    "cursor-grok-4.5-medium",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
    "gpt-5.6-sol-high",
  ];
  const project = resolveProjectModels(DEFAULT_CONFIG, catalogue);
  assert.equal(project.roles.brainstormer.model, "cursor-grok-4.5-high");

  assert.equal(
    validatePersistedExactModel("cursor-grok-4.5-high", catalogue),
    "cursor-grok-4.5-high",
  );

  const withoutExact = ["cursor-grok-4.5-medium", "gpt-5.6-sol-high"];
  assert.throws(
    () => validatePersistedExactModel("cursor-grok-4.5-high", withoutExact),
    /cursor-grok-4\.5-high|unavailable|no longer available/i,
  );
  assert.throws(
    () => validatePersistedExactModel("cursor-grok-4.5-high", ["cursor-claude-fable-5-high"]),
    /cursor-grok-4\.5-high/,
  );
});

test("existing-run Cursor execute uses persisted exact ID without substitution", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-exact-exec-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  config.roles.brainstormer.model = "cursor-grok-4.5-high";
  config.policy.promptTransport = "argv";

  let seenModel: string | undefined;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_c, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "cursor-grok-4.5-medium\ncursor-grok-4.5-low\n",
          stderr: "",
          durationMs: 1,
        };
      }
      const modelIdx = args.indexOf("--model");
      seenModel = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
      return { exitCode: 0, stdout: "ok\nREADY_FOR_BRAINSTORM_APPROVAL\n", stderr: "", durationMs: 1 };
    },
  });

  await assert.rejects(
    () =>
      runtime.execute({
        runId: "r1",
        role: "brainstormer",
        prompt: "hello",
        cwd,
        roleConfig: config.roles.brainstormer,
      }),
    /cursor-grok-4\.5-high|unavailable|no longer available/i,
  );
  assert.equal(seenModel, undefined);
});

test("persisted exact IDs survive env/project/catalogue drift; retry uses same IDs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-persist-drift-"));
  await mkdir(path.join(cwd, ".maswe"), { recursive: true });

  let catalogue = [
    "cursor-grok-4.5-high",
    "cursor-grok-4.5-medium",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
    "gpt-5.6-sol-high",
  ];
  const executed: string[] = [];

  class TrackingRuntime implements AgentRuntime {
    async listModels(): Promise<string[]> {
      return catalogue;
    }
    async execute(request: RuntimeRequest): Promise<RuntimeResult> {
      executed.push(request.roleConfig.model);
      return {
        status: "finished",
        output: "# mock\n\nREADY_FOR_BRAINSTORM_APPROVAL\n",
        requestedModel: request.roleConfig.model,
        actualModel: request.roleConfig.model,
      };
    }
    async doctor(): Promise<RuntimeDoctorResult> {
      return { ok: true, checks: [] };
    }
  }

  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "mock";
  config.policy.useIsolatedWorktree = false;
  config.policy.allowDirtyWorkspace = true;
  const resolved = resolveProjectModels(config, catalogue);
  const store = new FileRunStore(cwd);
  const orchestrator = new Orchestrator(cwd, resolved, new TrackingRuntime(), store);
  const run = await orchestrator.start("persist", "short");
  assert.equal(run.config.roles.brainstormer.model, "cursor-grok-4.5-high");
  assert.equal(run.config.roles.designer.model, "cursor-claude-fable-5-high");
  assert.equal(run.config.roles.verifier.model, "gpt-5.6-sol-high");

  process.env.MASWE_MODEL_BRAINSTORMER = "cursor-grok-4.5-medium";
    catalogue = [
      "cursor-grok-4.5-medium",
      "cursor-claude-fable-5-high",
      "cursor-claude-opus-4.8-high",
      "gpt-5.6-sol-high",
    ];
  try {
    const reloaded = await store.load(run.id);
    assert.equal(reloaded.config.roles.brainstormer.model, "cursor-grok-4.5-high");
    assert.equal(reloaded.config.roles.designer.model, "cursor-claude-fable-5-high");

    // Catalogue lost the persisted exact ID — mock path does not re-list, but
    // Cursor validation must fail closed when used.
    assert.throws(
      () => validatePersistedExactModel(reloaded.config.roles.brainstormer.model, catalogue),
      /cursor-grok-4\.5-high/,
    );
  } finally {
    delete process.env.MASWE_MODEL_BRAINSTORMER;
  }
});

// ---------------------------------------------------------------------------
// 4. Owner-safe .admin.lock recovery
// ---------------------------------------------------------------------------

test("stale admin lock is not auto-reclaimed; explicit recovery is owner-safe (barrier)", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-admin-stale-"));
  const store = new FileRunStore(cwd, { lockRetries: 6 });
  const run = await store.create("admin-stale", "recover", DEFAULT_CONFIG);
  const adminPath = path.join(cwd, ".maswe", "runs", run.id, ".admin.lock");
  await mkdir(path.dirname(adminPath), { recursive: true });

  const staleOwner = "stale-admin-O";
  await installLinkLock(adminPath, {
    pid: 1_000_000_777,
    owner: staleOwner,
    at: new Date(Date.now() - 240_000).toISOString(),
  });

  // Normal acquire must fail closed while stale admin remains.
  const blocked = structuredClone(run);
  blocked.title = "blocked-by-stale-admin";
  await assert.rejects(store.save(blocked), /admin lock|unlock-admin|stale/i);
  assert.equal(await readLockOwner(adminPath), staleOwner);

  const aObserved = deferred();
  const bObserved = deferred();
  const allowARecover = deferred();
  const allowBResume = deferred();
  const cEntered = deferred();
  const allowCExit = deferred();

  const recoverA = store.unlockAdmin(run.id, {
    afterObserve: async (meta) => {
      assert.equal(meta?.owner, staleOwner);
      aObserved.resolve();
      await allowARecover.promise;
    },
  });
  const recoverB = store.unlockAdmin(run.id, {
    afterObserve: async (meta) => {
      assert.equal(meta?.owner, staleOwner);
      bObserved.resolve();
      await allowBResume.promise;
    },
  });

  await Promise.all([aObserved.promise, bObserved.promise]);

  allowARecover.resolve();
  await recoverA;
  assert.equal(await readLockOwner(adminPath), undefined);

  // C acquires live admin N and pauses inside the critical section.
  const holdN = deferred();
  const cPromise = store.withAdminLockForTest(run.id, async () => {
    cEntered.resolve();
    await allowCExit.promise;
    return "c-done";
  });
  await cEntered.promise;
  const liveOwner = await readLockOwner(adminPath);
  assert.ok(liveOwner);
  assert.notEqual(liveOwner, staleOwner);
  holdN.resolve();

  // B resumes — must not delete N.
  allowBResume.resolve();
  await assert.rejects(() => recoverB, /changed|live|refusing|recovery/i);
  assert.equal(await readLockOwner(adminPath), liveOwner);

  // D cannot enter while C holds N.
  await assert.rejects(
    store.withAdminLockForTest(run.id, async () => "d-entered"),
    /admin lock|contention|recovery/i,
  );
  assert.equal(await readLockOwner(adminPath), liveOwner);

  allowCExit.resolve();
  assert.equal(await cPromise, "c-done");
  assert.equal(await readLockOwner(adminPath), undefined);

  // Normal save works after cleanup.
  const ok = structuredClone(await store.load(run.id));
  ok.title = "after-admin-recovery";
  await store.save(ok);
  assert.equal((await store.load(run.id)).title, "after-admin-recovery");
});

test("unlockAdmin rejects live owner, corrupt lock, and incomplete lock without force", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-admin-reject-"));
  const store = new FileRunStore(cwd, { lockRetries: 4 });
  const run = await store.create("admin-reject", "cases", DEFAULT_CONFIG);
  const adminPath = path.join(cwd, ".maswe", "runs", run.id, ".admin.lock");

  await installLinkLock(adminPath, {
    pid: process.pid,
    owner: "live-admin",
    at: new Date().toISOString(),
  });
  await assert.rejects(store.unlockAdmin(run.id), /live pid|refusing/i);
  await store.unlockAdmin(run.id, { force: true });
  assert.equal(await readLockOwner(adminPath), undefined);

  await writeFile(adminPath, "{not-json\n", "utf8");
  await assert.rejects(store.unlockAdmin(run.id), /corrupt|incomplete|force/i);
  await store.unlockAdmin(run.id, { force: true });

  const holder = await open(adminPath, "wx");
  await holder.writeFile("", "utf8");
  await assert.rejects(store.unlockAdmin(run.id), /incomplete|corrupt|force/i);
  await store.unlockAdmin(run.id, { force: true });
  await holder.close();
});

// ---------------------------------------------------------------------------
// 5. Doctor partial-creation cleanup
// ---------------------------------------------------------------------------

test("doctor cleanup removes branch when worktree creation fails after branch exists", async () => {
  const cwd = await initRepo("maswe-doctor-partial-");
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.kind = "cursor-cli";
  config.runtime.command = process.execPath;
  config.policy.promptTransport = "argv";
  config.policy.trustManagedWorktrees = true;
  config.policy.useIsolatedWorktree = true;

  const beforeBranches = (await execFileAsync("git", ["branch", "--list", "maswe/doctor-*"], { cwd }))
    .stdout;
  const beforeWorktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd }))
    .stdout;

  let probeId: string | undefined;
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (command, args, options) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "cursor-grok-4.5-high\ngpt-5.6-sol-high\ncursor-claude-fable-5-high\n",
          stderr: "",
          durationMs: 1,
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });

  // Inject failure: create branch then fail worktree by using a custom ensure path.
  const originalEnsure = ensureRunWorkspace;
  const gitWorkspace = await import("../src/git-workspace.ts");
  const ensureSpy = async (repositoryPath: string, run: Parameters<typeof ensureRunWorkspace>[1]) => {
    probeId = run.id;
    await execFileAsync("git", ["branch", `maswe/${run.id}`, "HEAD"], { cwd: repositoryPath });
    throw new Error("injected worktree creation failure");
  };
  // Use runtime's private path via doctor after monkeypatching module is hard;
  // instead call cleanup helpers directly for branch-only / path-only / repeat cases,
  // and use a subclass-style injection through resolveDoctorProbe by failing ensure.
  void originalEnsure;
  void ensureSpy;
  void gitWorkspace;

  // Branch-only cleanup
  const branchOnlyId = `doctor-${randomUUID().slice(0, 8)}`;
  await execFileAsync("git", ["branch", `maswe/${branchOnlyId}`, "HEAD"], { cwd });
  await cleanupDoctorProbeResources(cwd, branchOnlyId, path.join(cwd, "missing-worktree"));
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", `maswe/${branchOnlyId}`], { cwd }),
  );

  // Path-only cleanup (no branch)
  const pathOnlyId = `doctor-${randomUUID().slice(0, 8)}`;
  const pathOnly = externalWorktreePath(cwd, pathOnlyId);
  await mkdir(pathOnly, { recursive: true });
  await writeFile(path.join(pathOnly, "x"), "y");
  await cleanupDoctorProbeResources(cwd, pathOnlyId, pathOnly);
  await assert.rejects(access(pathOnly), /ENOENT/);

  // Repeated cleanup is idempotent
  await cleanupDoctorProbeResources(cwd, pathOnlyId, pathOnly);
  await cleanupDoctorProbeResources(cwd, branchOnlyId, path.join(cwd, "missing-worktree"));

  // Partial failure through doctor: force ensureRunWorkspace failure after branch
  const failingRuntime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_c, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "cursor-grok-4.5-high\ngpt-5.6-sol-high\ncursor-claude-fable-5-high\n",
          stderr: "",
          durationMs: 1,
        };
      }
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });

  // Patch ensure via runtime test hook
  (failingRuntime as unknown as { ensureProbeWorkspace: typeof ensureRunWorkspace }).ensureProbeWorkspace =
    async (repositoryPath, run) => {
      probeId = run.id;
      await execFileAsync("git", ["branch", `maswe/${run.id}`, "HEAD"], { cwd: repositoryPath });
      throw new Error("injected worktree creation failure");
    };

  const report = await failingRuntime.doctor();
  assert.ok(probeId);
  await assert.rejects(
    execFileAsync("git", ["rev-parse", "--verify", `maswe/${probeId}`], { cwd }),
  );
  const cleanup = report.checks.find((c) => c.name === "doctor-probe-cleanup");
  assert.ok(cleanup);
  assert.equal(cleanup.ok, true, cleanup.message);
  assert.ok(
    report.checks.some((c) => !c.ok && /injected worktree|cursor-cli/i.test(c.message)),
    "original doctor failure must remain visible",
  );

  const afterBranches = (await execFileAsync("git", ["branch", "--list", "maswe/doctor-*"], { cwd }))
    .stdout;
  const afterWorktrees = (await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd }))
    .stdout;
  assert.equal(afterBranches, beforeBranches);
  assert.equal(afterWorktrees, beforeWorktrees);
});

test("doctor-probe-cleanup check fails when cleanup command fails", async () => {
  const cwd = await initRepo("maswe-doctor-cleanfail-");
  const probeId = `doctor-${randomUUID().slice(0, 8)}`;
  await execFileAsync("git", ["branch", `maswe/${probeId}`, "HEAD"], { cwd });
  // Make branch deletion fail by using an invalid git dir trick: pass wrong repo path
  await assert.rejects(
    cleanupDoctorProbeResources(path.join(cwd, "does-not-exist"), probeId, path.join(cwd, "no-wt")),
  );
});

// ---------------------------------------------------------------------------
// 6. Cursor output normalization
// ---------------------------------------------------------------------------

test("extractCursorCliOutput accepts only terminal stream-json result events", () => {
  const terminalThenLog = [
    JSON.stringify({ type: "result", result: "FINAL_MARKER\nREADY_FOR_BRAINSTORM_APPROVAL\n" }),
    JSON.stringify({ type: "log", message: "post-result noise", text: "ignore-me" }),
  ].join("\n");
  assert.match(extractCursorCliOutput(terminalThenLog), /FINAL_MARKER/);

  const partialThenResult = [
    JSON.stringify({ type: "assistant", message: "partial", text: "partial", result: "wrong" }),
    JSON.stringify({ type: "result", result: "terminal-ok\nREADY_FOR_BRAINSTORM_APPROVAL\n" }),
  ].join("\n");
  assert.match(extractCursorCliOutput(partialThenResult), /terminal-ok/);

  assert.equal(extractCursorCliOutput(JSON.stringify({ type: "assistant", text: "only" })), "");
  // Non-JSON text is preserved for text-mode success paths.
  assert.equal(extractCursorCliOutput("{not-json"), "{not-json");
  assert.equal(extractCursorCliOutput(""), "");
  // NDJSON with JSON events but no terminal result fails closed.
  assert.equal(
    extractCursorCliOutput(JSON.stringify({ type: "log", message: "nope", text: "x" })),
    "",
  );

  const multi = [
    JSON.stringify({ type: "result", result: "first" }),
    JSON.stringify({ type: "result", result: "second-terminal" }),
  ].join("\n");
  assert.equal(extractCursorCliOutput(multi), "second-terminal");
});

test("Cursor execute never treats stderr as successful assistant content", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-stderr-out-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.runtime.command = process.execPath;
  config.roles.brainstormer.model = "cursor-grok-4.5-high";
  config.policy.promptTransport = "argv";

  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_c, args) => {
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "cursor-grok-4.5-high\n",
          stderr: "",
          durationMs: 1,
        };
      }
      return {
        exitCode: 0,
        stdout: "",
        stderr: JSON.stringify({ type: "result", result: "from-stderr\nREADY_FOR_BRAINSTORM_APPROVAL\n" }),
        durationMs: 1,
      };
    },
  });

  const result = await runtime.execute({
    runId: "r1",
    role: "brainstormer",
    prompt: "hello",
    cwd,
    roleConfig: config.roles.brainstormer,
  });
  assert.equal(result.status, "error");
  assert.notEqual(result.output, "from-stderr\nREADY_FOR_BRAINSTORM_APPROVAL\n");
  assert.match(String(result.metadata?.stderr ?? ""), /from-stderr/);
});

// ---------------------------------------------------------------------------
// 7. Safe smoke model selection
// ---------------------------------------------------------------------------

test("pickCatalogueModel stays within approved families and fails closed otherwise", () => {
  assert.equal(
    pickCatalogueModel(["cursor-grok-4.5-high", "gpt-5.6-sol-high"], "grok-4.5"),
    "cursor-grok-4.5-high",
  );
  assert.equal(
    pickCatalogueModel(["gpt-5.6-sol-high", "cursor-claude-fable-5-high"]),
    "gpt-5.6-sol-high",
  );
  assert.throws(
    () => pickCatalogueModel(["totally-unrelated-9", "other-vendor-3"]),
    /No approved smoke model family/i,
  );
  assert.throws(
    () => pickCatalogueModel(["gpt-5.4-high", "gpt-5.3-codex-high"], "gpt-5"),
    /Ambiguous/,
  );
  assert.equal(
    pickCatalogueModel(["cursor-grok-4.5-medium", "cursor-grok-4.5-high"]),
    "cursor-grok-4.5-high",
  );
});

// ---------------------------------------------------------------------------
// 8. Doctor stdin probe uses resolved exact model
// ---------------------------------------------------------------------------

test("doctor stdin probe uses the same resolved exact model as start", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-doctor-probe-model-"));
  const config = structuredClone(DEFAULT_CONFIG);
  // Non-node command name so doctor exercises the real --model probe path.
  config.runtime.command = "agent";
  config.policy.promptTransport = "stdin";
  config.policy.useIsolatedWorktree = false;
  config.policy.trustManagedWorktrees = false;
  config.roles.brainstormer.model = "grok-4.5";

  const modelArgs: string[] = [];
  const runtime = new CursorCliRuntime(config, {
    cwd,
    spawnFn: async (_c, args) => {
      if (args[0] === "--version") {
        return { exitCode: 0, stdout: "agent 1.0", stderr: "", durationMs: 1 };
      }
      if (args[0] === "models") {
        return {
          exitCode: 0,
          stdout: "cursor-grok-4.5-high\ncursor-claude-fable-5-high\ncursor-claude-opus-4.8-high\ngpt-5.6-sol-high\n",
          stderr: "",
          durationMs: 1,
        };
      }
      const idx = args.indexOf("--model");
      if (idx >= 0) modelArgs.push(args[idx + 1]!);
      return { exitCode: 0, stdout: "ok", stderr: "", durationMs: 1 };
    },
  });

  const report = await runtime.doctor();
  const probe = report.checks.find((c) => c.name === "prompt-transport-probe");
  assert.ok(probe?.ok, probe?.message ?? "missing prompt-transport-probe check");
  assert.equal(modelArgs[0], "cursor-grok-4.5-high");
  assert.match(probe!.message, /cursor-grok-4\.5-high/);

  const startResolved = resolveProjectModels(config, [
    "cursor-grok-4.5-high",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
    "gpt-5.6-sol-high",
  ]);
  assert.equal(startResolved.roles.brainstormer.model, "cursor-grok-4.5-high");
});

// ---------------------------------------------------------------------------
// 9. NUL-safe gitChangedFiles
// ---------------------------------------------------------------------------

test("gitChangedFiles preserves unusual filenames via NUL-delimited diff", async () => {
  const cwd = await initRepo("maswe-nul-diff-");
  const base = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();

  const names = [
    "space file.txt",
    "tab\tfile.txt",
    "-leading-dash.txt",
    "unicodé-文件.txt",
  ];
  // Newline-in-filename where the filesystem permits.
  let newlineName: string | undefined;
  try {
    newlineName = "has\nnewline.txt";
    await writeFile(path.join(cwd, newlineName), "x\n");
    names.push(newlineName);
  } catch {
    newlineName = undefined;
  }

  for (const name of names) {
    if (name === newlineName) continue;
    await writeFile(path.join(cwd, name), "x\n");
  }
  await execFileAsync("git", ["add", "-A"], { cwd });
  await execFileAsync("git", ["-c", "core.hooksPath=/dev/null", "commit", "-m", "unusual"], { cwd });

  const files = await gitChangedFiles(cwd, base, "HEAD");
  for (const name of names) {
    assert.ok(files.includes(name), `missing ${JSON.stringify(name)} in ${JSON.stringify(files)}`);
  }
});

// ---------------------------------------------------------------------------
// 10. Assert migrated run configuration
// ---------------------------------------------------------------------------

test("migrateRunRecord asserts config and ignores environment overrides", () => {
  process.env.MASWE_MODEL_VERIFIER = "env-should-not-apply";
  try {
    assert.throws(
      () =>
        migrateRunRecord({
          schemaVersion: 1,
          version: 1,
          id: "r",
          title: "t",
          request: "q",
          repositoryPath: "/tmp",
          state: "CREATED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvals: { brainstorm: false, design: false },
          counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
          config: {
            roles: { brainstormer: { model: "" } },
          },
          artifacts: [],
          events: [],
        }),
      /model must not be empty/i,
    );

    assert.throws(
      () =>
        migrateRunRecord({
          schemaVersion: 1,
          version: 1,
          id: "r",
          title: "t",
          request: "q",
          repositoryPath: "/tmp",
          state: "CREATED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvals: { brainstorm: false, design: false },
          counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
          config: {
            roles: { builder: { model: "x", permissions: "sudo" } },
          },
          artifacts: [],
          events: [],
        }),
      /permissions/i,
    );

    assert.throws(
      () =>
        migrateRunRecord({
          schemaVersion: 1,
          version: 1,
          id: "r",
          title: "t",
          request: "q",
          repositoryPath: "/tmp",
          state: "CREATED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvals: { brainstorm: false, design: false },
          counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
          config: {
            policy: { useIsolatedWorktree: "yes" },
          },
          artifacts: [],
          events: [],
        }),
      /boolean/i,
    );

    assert.throws(
      () =>
        migrateRunRecord({
          schemaVersion: 1,
          version: 1,
          id: "r",
          title: "t",
          request: "q",
          repositoryPath: "/tmp",
          state: "CREATED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvals: { brainstorm: false, design: false },
          counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
          config: {
            policy: { commandTimeoutMs: "600000" },
          },
          artifacts: [],
          events: [],
        }),
      /commandTimeoutMs/i,
    );

    assert.throws(
      () =>
        migrateRunRecord({
          schemaVersion: 1,
          version: 1,
          id: "r",
          title: "t",
          request: "q",
          repositoryPath: "/tmp",
          state: "CREATED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvals: { brainstorm: false, design: false },
          counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
          config: {
            policy: { allowedPathGlobs: [] },
          },
          artifacts: [],
          events: [],
        }),
      /allowedPathGlobs/i,
    );

    assert.throws(
      () =>
        migrateRunRecord({
          schemaVersion: 1,
          version: 1,
          id: "r",
          title: "t",
          request: "q",
          repositoryPath: "/tmp",
          state: "CREATED",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          approvals: { brainstorm: false, design: false },
          counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
          config: {
            quality: { commands: "npm test" },
          },
          artifacts: [],
          events: [],
        }),
      /quality\.commands/i,
    );

    const valid = migrateRunRecord({
      schemaVersion: 1,
      version: 1,
      id: "r",
      title: "t",
      request: "q",
      repositoryPath: "/tmp",
      state: "CREATED",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvals: { brainstorm: false, design: false },
      counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
      config: {
        runtime: { kind: "mock", command: "agent", outputFormat: "json" },
        roles: { verifier: { model: "snapshotted-verifier", permissions: "read-only", reasoning: "high" } },
      },
      artifacts: [],
      events: [],
    });
    assert.equal(valid.config.roles.verifier.model, "snapshotted-verifier");
    assert.notEqual(valid.config.roles.verifier.model, process.env.MASWE_MODEL_VERIFIER);
    assertConfig(valid.config);
  } finally {
    delete process.env.MASWE_MODEL_VERIFIER;
  }
});

test("resolveLogicalModelId empty catalogue pass-through stays SDK-only helper", () => {
  // Documented SDK behavior: empty catalogue keeps configured id.
  assert.equal(resolveLogicalModelId("grok-4.5", []), "grok-4.5");
  // Project resolution still works when catalogue is present.
  const resolved = resolveConfigModels(DEFAULT_CONFIG, [
    "cursor-grok-4.5-high",
    "gpt-5.6-sol-high",
    "cursor-claude-fable-5-high",
    "cursor-claude-opus-4.8-high",
  ]);
  assert.equal(resolved.roles.brainstormer.model, "cursor-grok-4.5-high");
});
