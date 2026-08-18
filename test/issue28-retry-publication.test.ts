import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkflowEventType,
} from "../src/domain.ts";
import { captureWorkspace, listGitWorktreeRegistrations } from "../src/git-workspace.ts";
import { Orchestrator } from "../src/orchestrator.ts";
import { MockRuntime } from "../src/runtimes/mock.ts";
import {
  FileRunStore,
  type CreateRunOptions,
  type RunStore,
} from "../src/store.ts";
import { captureWorkspaceBootstrapIntent } from "../src/workspace-bootstrap.ts";

const execFileAsync = promisify(execFile);
let publicationCwd = "";

before(async () => {
  publicationCwd = await initGitRepo();
});

after(async () => {
  await rm(publicationCwd, { recursive: true, force: true });
});

type RetryInjection =
  | "before"
  | "before-version-jump"
  | "before-malformed-timestamp"
  | "before-unbounded-timestamp"
  | "complete-after"
  | "complete-malformed-event-timestamp-after"
  | "complete-malformed-timestamp-after"
  | "complete-unbounded-timestamp-after"
  | "failure-restored-after";

class RetryInjectionStore implements RunStore {
  private readonly delegate: FileRunStore;
  private readonly injection: RetryInjection;

  constructor(delegate: FileRunStore, injection: RetryInjection) {
    this.delegate = delegate;
    this.injection = injection;
  }

  create(
    title: string,
    request: string,
    config: MasweConfig,
    options: CreateRunOptions = {},
  ): Promise<RunRecord> {
    return this.delegate.create(title, request, config, options);
  }

  save(run: RunRecord): Promise<void> {
    return this.delegate.save(run);
  }

  load(runId: string): Promise<RunRecord> {
    return this.delegate.load(runId);
  }

  list(): Promise<RunRecord[]> {
    return this.delegate.list();
  }

  private async overwriteAuthoritative(run: RunRecord): Promise<void> {
    await writeFile(
      path.join(this.delegate.root, run.id, "run.json"),
      `${JSON.stringify(run, null, 2)}\n`,
      "utf8",
    );
  }

  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    if (type !== "RETRY_FROM_FAILED") {
      return this.delegate.applyEvent(run, type, actor, details);
    }
    if (this.injection.startsWith("before")) {
      if (this.injection !== "before") {
        const observed = await this.delegate.load(run.id);
        if (this.injection === "before-version-jump") {
          observed.version += 2;
          observed.updatedAt = new Date(Date.now() + 1_000).toISOString();
        } else {
          observed.version += 1;
          observed.updatedAt =
            this.injection === "before-malformed-timestamp"
              ? "not-a-file-store-timestamp"
              : "x".repeat(4_096);
        }
        await this.overwriteAuthoritative(observed);
      }
      throw new Error(
        this.injection === "before"
          ? "simulated RETRY_FROM_FAILED pre-publication failure"
          : `simulated ${this.injection} RETRY_FROM_FAILED failure`,
      );
    }

    const published = await this.delegate.applyEvent(
      structuredClone(run),
      type,
      actor,
      details,
    );
    if (this.injection === "failure-restored-after") {
      published.failure = structuredClone(
        details?.previousFailure as NonNullable<RunRecord["failure"]>,
      );
      await this.delegate.save(published);
    } else if (this.injection === "complete-malformed-event-timestamp-after") {
      published.events.at(-1)!.at = "not-a-file-store-timestamp";
      await this.overwriteAuthoritative(published);
    } else if (this.injection === "complete-malformed-timestamp-after") {
      published.updatedAt = "not-a-file-store-timestamp";
      await this.overwriteAuthoritative(published);
    } else if (this.injection === "complete-unbounded-timestamp-after") {
      published.updatedAt = "x".repeat(4_096);
      await this.overwriteAuthoritative(published);
    }
    throw new Error(`simulated ${this.injection} RETRY_FROM_FAILED publication`);
  }

  writeArtifact(
    run: RunRecord,
    name: string,
    content: string,
  ): Promise<ArtifactReference> {
    return this.delegate.writeArtifact(run, name, content);
  }

  readArtifact(run: RunRecord, name: string): Promise<string | undefined> {
    return this.delegate.readArtifact(run, name);
  }
}

function config(useIsolatedWorktree = false): MasweConfig {
  const value = structuredClone(DEFAULT_CONFIG);
  value.runtime.kind = "mock";
  value.policy.useIsolatedWorktree = useIsolatedWorktree;
  value.quality.commands = [];
  return value;
}

async function initGitRepo(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-retry-git-"));
  await execFileAsync("git", ["init", "-q"], { cwd });
  await execFileAsync("git", ["config", "user.email", "maswe@example.com"], { cwd });
  await execFileAsync("git", ["config", "user.name", "MASWE"], { cwd });
  await writeFile(path.join(cwd, "README.md"), "# retry publication\n", "utf8");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-qm", "init"], { cwd });
  return cwd;
}

async function cleanupGitRepo(cwd: string): Promise<void> {
  try {
    const registrations = await listGitWorktreeRegistrations(cwd);
    for (const registration of registrations) {
      if (registration.worktreePath === path.resolve(cwd)) continue;
      await execFileAsync(
        "git",
        ["worktree", "remove", "--force", registration.worktreePath],
        { cwd },
      ).catch(() => undefined);
    }
    await execFileAsync("git", ["worktree", "prune"], { cwd }).catch(() => undefined);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

async function createFailedRun(
  cwd: string,
  value: MasweConfig,
  store = new FileRunStore(cwd),
): Promise<{ run: RunRecord; store: FileRunStore }> {
  let run = await store.create("Retry publication", "Preserve recovery metadata.", value, {
    workspaceBootstrap: await captureWorkspaceBootstrapIntent(cwd, value),
  });
  if (value.policy.useIsolatedWorktree) {
    run = await new Orchestrator(cwd, value, new MockRuntime(), store).bootstrapCreatedRun(run.id);
    run = await store.applyEvent(run, "BRAINSTORM_COMPLETED", "brainstormer");
  } else {
    run.state = "FAILED";
    run.workspace = await captureWorkspace(cwd);
    delete run.workspaceBootstrap;
  }
  run.failure = {
    code: "workflow-failure",
    message: "retryable failure",
    at: "2026-08-19T00:00:00.000Z",
    resumeState: "WAITING_FOR_BRAINSTORM_APPROVAL",
  };
  if (value.policy.useIsolatedWorktree) {
    run = await store.applyEvent(run, "FAIL", "orchestrator", {
      reason: run.failure.message,
      resumeState: run.failure.resumeState,
    });
  } else {
    await store.save(run);
  }
  return { run, store };
}

function retryEvents(run: RunRecord): RunRecord["events"] {
  return run.events.filter((event) => event.type === "RETRY_FROM_FAILED");
}

test("retry pre-publication failure leaves the authoritative retryable FAILED record intact", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config(true);
  const { run, store } = await createFailedRun(cwd, value);
  const previousFailure = structuredClone(run.failure);
  assert.ok(run.workspace?.worktreePath);
  await execFileAsync("git", ["worktree", "remove", "--force", run.workspace.worktreePath], {
    cwd,
  });

  await assert.rejects(
    new Orchestrator(
      cwd,
      value,
      new MockRuntime(),
      new RetryInjectionStore(store, "before"),
    ).retryFromFailed(run.id),
    /pre-publication failure/,
  );

  const authoritative = await new FileRunStore(cwd).load(run.id);
  const registrations = await listGitWorktreeRegistrations(cwd);
  assert.equal(authoritative.state, "FAILED");
  assert.deepEqual(authoritative.failure, previousFailure);
  assert.equal(retryEvents(authoritative).length, 0);
  assert.ok(authoritative.workspace?.worktreePath);
  const recoveredPath = authoritative.workspace.worktreePath;
  await access(recoveredPath);
  assert.ok(
    registrations.some(
      (registration) =>
        registration.worktreePath === path.resolve(recoveredPath) &&
        registration.branch === authoritative.workspace!.branch &&
        registration.headSha === authoritative.workspace!.headSha,
    ),
    "the exact missing worktree must be reconciled without publishing or deleting failure metadata",
  );
});

test("retry reconciles a FAILED CREATED run with no workspace before publishing once", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-retry-created-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config();
  const store = new FileRunStore(cwd);
  let run = await store.create("Created retry", "Finish bootstrap.", value, {
    workspaceBootstrap: await captureWorkspaceBootstrapIntent(cwd, value),
  });
  run.failure = {
    message: "bootstrap stopped before workspace creation",
    at: "2026-08-19T00:00:00.000Z",
    resumeState: "CREATED",
  };
  run = await store.applyEvent(run, "FAIL", "orchestrator", {
    reason: run.failure.message,
    resumeState: run.failure.resumeState,
  });

  const result = await new Orchestrator(cwd, value, new MockRuntime(), store).retryFromFailed(
    run.id,
  );
  const authoritative = await new FileRunStore(cwd).load(result.id);

  assert.equal(authoritative.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(authoritative.failure, undefined);
  assert.equal(authoritative.workspace?.baseSha, "not-a-git-repository");
  assert.equal(authoritative.workspaceBootstrap, undefined);
  assert.equal(retryEvents(authoritative).length, 1);
  assert.equal(
    authoritative.events.filter((event) => event.type === "START").length,
    1,
  );
  const retryIndex = authoritative.events.findIndex(
    (event) => event.type === "RETRY_FROM_FAILED",
  );
  const startIndex = authoritative.events.findIndex((event) => event.type === "START");
  assert.ok(retryIndex >= 0 && retryIndex < startIndex);
  assert.equal(authoritative.events[retryIndex]?.from, "FAILED");
  assert.equal(authoritative.events[retryIndex]?.to, "CREATED");
  assert.equal(authoritative.events[startIndex]?.from, "CREATED");
  assert.equal(authoritative.events[startIndex]?.to, "BRAINSTORMING");
});

test("retry optimistic conflict preserves failure metadata and publishes no retry event", async () => {
  const cwd = publicationCwd;
  const value = config();
  const { run, store } = await createFailedRun(cwd, value);
  const previousFailure = structuredClone(run.failure);

  await assert.rejects(
    new Orchestrator(cwd, value, new MockRuntime(), store, {
      beforeRetryPublication: async (candidate) => {
        const concurrent = await new FileRunStore(cwd).load(candidate.id);
        await new FileRunStore(cwd).save(concurrent);
      },
    }).retryFromFailed(run.id),
    /version conflict/,
  );

  const authoritative = await new FileRunStore(cwd).load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.deepEqual(authoritative.failure, previousFailure);
  assert.equal(retryEvents(authoritative).length, 0);
});

test("retry rejects malformed no-event version and timestamp shapes", async (t) => {
  for (const injection of [
    "before-version-jump",
    "before-malformed-timestamp",
    "before-unbounded-timestamp",
  ] as const) {
    await t.test(injection, async () => {
      const cwd = publicationCwd;
      const value = config();
      const { run, store } = await createFailedRun(cwd, value);
      const previousFailure = structuredClone(run.failure);

      await assert.rejects(
        new Orchestrator(
          cwd,
          value,
          new MockRuntime(),
          new RetryInjectionStore(store, injection),
        ).retryFromFailed(run.id),
        /retry publication outcome is inconsistent/i,
      );

      const authoritative = await new FileRunStore(cwd).load(run.id);
      assert.equal(authoritative.state, "FAILED");
      assert.deepEqual(authoritative.failure, previousFailure);
      assert.equal(retryEvents(authoritative).length, 0);
    });
  }
});

test("retry directory-sync outcome unknown adopts the one complete authoritative retry", async () => {
  const cwd = publicationCwd;
  const value = config();
  const initialStore = new FileRunStore(cwd);
  const { run } = await createFailedRun(cwd, value, initialStore);
  const previousFailure = structuredClone(run.failure);
  const priorEventIds = new Set(run.events.map((event) => event.id));
  let inject = true;
  const outcomeUnknownStore = new FileRunStore(cwd, {
    syncDirectory: async (directoryPath) => {
      if (!inject || path.basename(directoryPath) !== run.id) return;
      const observed = JSON.parse(
        await readFile(path.join(directoryPath, "run.json"), "utf8"),
      ) as RunRecord;
      if (observed.events.at(-1)?.type === "RETRY_FROM_FAILED") {
        inject = false;
        throw new Error("simulated retry directory sync failure");
      }
    },
  });

  const result = await new Orchestrator(
    cwd,
    value,
    new MockRuntime(),
    outcomeUnknownStore,
  ).retryFromFailed(run.id);
  const authoritative = await new FileRunStore(cwd).load(result.id);
  const currentRetries = retryEvents(authoritative).filter(
    (event) => !priorEventIds.has(event.id),
  );

  assert.equal(authoritative.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(authoritative.failure, undefined);
  assert.equal(currentRetries.length, 1);
  assert.deepEqual(currentRetries[0]?.details?.previousFailure, previousFailure);
});

test("retry adopts an independently completed publication after applyEvent throws", async () => {
  const cwd = publicationCwd;
  const value = config();
  const { run, store } = await createFailedRun(cwd, value);
  const priorEventIds = new Set(run.events.map((event) => event.id));

  const result = await new Orchestrator(
    cwd,
    value,
    new MockRuntime(),
    new RetryInjectionStore(store, "complete-after"),
  ).retryFromFailed(run.id);
  const authoritative = await new FileRunStore(cwd).load(result.id);
  const currentRetries = retryEvents(authoritative).filter(
    (event) => !priorEventIds.has(event.id),
  );

  assert.equal(authoritative.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(authoritative.failure, undefined);
  assert.equal(currentRetries.length, 1);
});

test("retry rejects complete-looking publications with malformed timestamps", async (t) => {
  for (const injection of [
    "complete-malformed-event-timestamp-after",
    "complete-malformed-timestamp-after",
    "complete-unbounded-timestamp-after",
  ] as const) {
    await t.test(injection, async () => {
      const cwd = publicationCwd;
      const value = config();
      const { run, store } = await createFailedRun(cwd, value);

      await assert.rejects(
        new Orchestrator(
          cwd,
          value,
          new MockRuntime(),
          new RetryInjectionStore(store, injection),
        ).retryFromFailed(run.id),
        /retry publication outcome is inconsistent/i,
      );

      const authoritative = await new FileRunStore(cwd).load(run.id);
      assert.equal(authoritative.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
      assert.equal(authoritative.failure, undefined);
      assert.equal(retryEvents(authoritative).length, 1);
    });
  }
});

test("retry rejects a partial publication that restores active failure metadata", async () => {
  const cwd = publicationCwd;
  const value = config();
  const { run, store } = await createFailedRun(cwd, value);

  await assert.rejects(
    new Orchestrator(
      cwd,
      value,
      new MockRuntime(),
      new RetryInjectionStore(store, "failure-restored-after"),
    ).retryFromFailed(run.id),
    /retry publication outcome is inconsistent/i,
  );

  const authoritative = await new FileRunStore(cwd).load(run.id);
  assert.equal(authoritative.state, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.ok(authoritative.failure);
  assert.equal(retryEvents(authoritative).length, 1);
});

test("an old retry event is never mistaken for the current failed publication", async () => {
  const cwd = publicationCwd;
  const value = config();
  const initial = await createFailedRun(cwd, value);
  let run = await new Orchestrator(cwd, value, new MockRuntime(), initial.store).retryFromFailed(
    initial.run.id,
  );
  run.failure = {
    message: "failed again",
    at: "2026-08-19T00:00:01.000Z",
    resumeState: "WAITING_FOR_BRAINSTORM_APPROVAL",
  };
  run = await initial.store.applyEvent(run, "FAIL", "orchestrator", {
    reason: run.failure.message,
    resumeState: run.failure.resumeState,
  });
  const oldRetryId = retryEvents(run)[0]?.id;

  await assert.rejects(
    new Orchestrator(
      cwd,
      value,
      new MockRuntime(),
      new RetryInjectionStore(initial.store, "before"),
    ).retryFromFailed(run.id),
    /pre-publication failure/,
  );

  const authoritative = await new FileRunStore(cwd).load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.deepEqual(retryEvents(authoritative).map((event) => event.id), [oldRetryId]);
});

test("retry rejects a dirty isolated worktree without cleaning or removing it", async (t) => {
  const cwd = await initGitRepo();
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config(true);
  const { run, store } = await createFailedRun(cwd, value);
  const worktreePath = run.workspace?.worktreePath;
  assert.ok(worktreePath);
  const dirtyPath = path.join(worktreePath, "dirty.txt");
  await writeFile(dirtyPath, "do not discard\n", "utf8");

  await assert.rejects(
    new Orchestrator(cwd, value, new MockRuntime(), store).retryFromFailed(run.id),
    /dirty/,
  );

  const authoritative = await new FileRunStore(cwd).load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(await readFile(dirtyPath, "utf8"), "do not discard\n");
});

test("later Git operator retry rejects branch, HEAD, and source-plane drift", async (t) => {
  for (const mutation of ["branch", "head", "dirty"] as const) {
    await t.test(mutation, async (t) => {
      const cwd = await initGitRepo();
      t.after(async () => cleanupGitRepo(cwd));
      const value = config();
      const { run, store } = await createFailedRun(cwd, value);
      const previousFailure = structuredClone(run.failure);

      if (mutation === "branch") {
        await execFileAsync("git", ["switch", "-qc", `retry-drift-${run.id}`], { cwd });
      } else if (mutation === "head") {
        await writeFile(path.join(cwd, "README.md"), "# advanced operator HEAD\n", "utf8");
        await execFileAsync("git", ["add", "README.md"], { cwd });
        await execFileAsync("git", ["commit", "-qm", "advance operator HEAD"], { cwd });
      } else {
        await writeFile(path.join(cwd, "operator-dirty.txt"), "preserve me\n", "utf8");
      }

      await assert.rejects(
        new Orchestrator(cwd, value, new MockRuntime(), store).retryFromFailed(run.id),
        mutation === "dirty" ? /dirty/ : /moved|supersede/,
      );

      const authoritative = await new FileRunStore(cwd).load(run.id);
      assert.equal(authoritative.state, "FAILED");
      assert.deepEqual(authoritative.failure, previousFailure);
      assert.equal(retryEvents(authoritative).length, 0);
    });
  }
});

test("later isolated retry rejects every conflicting preserved workspace shape", async (t) => {
  for (const mutation of [
    "wrong-path",
    "alternate-registration",
    "prunable-registration",
    "wrong-branch",
    "wrong-head",
    "fingerprint-drift",
  ] as const) {
    await t.test(mutation, async (t) => {
      const cwd = await initGitRepo();
      t.after(async () => cleanupGitRepo(cwd));
      const value = config(true);
      const { run, store } = await createFailedRun(cwd, value);
      const previousFailure = structuredClone(run.failure);
      const worktreePath = run.workspace?.worktreePath;
      const branch = run.workspace?.branch;
      const headSha = run.workspace?.headSha;
      assert.ok(worktreePath && branch && headSha);

      if (mutation === "wrong-path") {
        run.workspace!.worktreePath = path.join(cwd, "wrong-retry-path");
        await store.save(run);
      } else if (mutation === "alternate-registration") {
        const alternatePath = path.join(os.tmpdir(), `maswe-retry-alternate-${run.id}`);
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
        await execFileAsync("git", ["worktree", "add", "--", alternatePath, branch], { cwd });
      } else if (mutation === "prunable-registration") {
        await rm(worktreePath, { recursive: true, force: true });
        const registration = (await listGitWorktreeRegistrations(cwd)).find(
          (candidate) => candidate.branch === branch,
        );
        assert.equal(registration?.prunable, true);
      } else if (mutation === "wrong-branch") {
        const alternateBranch = `retry-wrong/${run.id}`;
        await execFileAsync("git", ["worktree", "remove", "--force", worktreePath], { cwd });
        await execFileAsync("git", ["branch", alternateBranch, headSha], { cwd });
        await execFileAsync(
          "git",
          ["worktree", "add", "--", worktreePath, alternateBranch],
          { cwd },
        );
      } else if (mutation === "wrong-head") {
        await writeFile(path.join(worktreePath, "README.md"), "# advanced retry HEAD\n", "utf8");
        await execFileAsync("git", ["add", "README.md"], { cwd: worktreePath });
        await execFileAsync("git", ["commit", "-qm", "advance retry HEAD"], {
          cwd: worktreePath,
        });
      } else {
        await mkdir(path.join(worktreePath, ".maswe"), { recursive: true });
        await writeFile(
          path.join(worktreePath, ".maswe", "config.json"),
          "{\"drift\":true}\n",
          "utf8",
        );
      }

      await assert.rejects(
        new Orchestrator(cwd, value, new MockRuntime(), store).retryFromFailed(run.id),
        /identity|alternate|prunable|wrong|moved|fingerprint|conflict/i,
      );

      const authoritative = await new FileRunStore(cwd).load(run.id);
      assert.equal(authoritative.state, "FAILED");
      assert.deepEqual(authoritative.failure, previousFailure);
      assert.equal(retryEvents(authoritative).length, 0);
    });
  }
});

test("later non-Git operator-checkout retry fails closed and requires supersession", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-retry-nongit-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const value = config();
  const { run, store } = await createFailedRun(cwd, value);

  await assert.rejects(
    new Orchestrator(cwd, value, new MockRuntime(), store).retryFromFailed(run.id),
    /non-Git.*supersed/i,
  );

  const authoritative = await new FileRunStore(cwd).load(run.id);
  assert.equal(authoritative.state, "FAILED");
  assert.equal(authoritative.failure?.resumeState, "WAITING_FOR_BRAINSTORM_APPROVAL");
  assert.equal(retryEvents(authoritative).length, 0);
});
