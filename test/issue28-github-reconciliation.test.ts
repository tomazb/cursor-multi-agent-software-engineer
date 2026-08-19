import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import type { MasweConfig, RunRecord, WorkflowEventType } from "../src/domain.ts";
import {
  DurableAtomicWriteOutcomeUnknownError,
  writeDurableAtomic,
} from "../src/durable-file.ts";
import { GitHubAppAdapter } from "../src/github/adapter.ts";
import { GitHubAssociationIndex } from "../src/github/association.ts";
import type { GitHubHttpClient } from "../src/github/checks.ts";
import type { RunStore } from "../src/store.ts";
import { FileRunStore } from "../src/store.ts";

const SECRET = "issue-28-github-reconciliation-secret";
const SECRET_ENV = "MASWE_TEST_ISSUE_28_GITHUB_RECONCILIATION_SECRET";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const HEAD_C = "c".repeat(40);

function config(): MasweConfig {
  return mergeConfigForTest({
    runtime: { kind: "mock" },
    quality: { commands: [] },
    githubApp: {
      enabled: true,
      readOnlyChecks: true,
      webhookSecretEnv: SECRET_ENV,
      appIdEnv: "MASWE_TEST_GITHUB_APP_ID",
      privateKeyEnv: "MASWE_TEST_GITHUB_APP_PRIVATE_KEY",
      allowedRepositories: ["owner/repo"],
    },
  });
}

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body, "utf8").digest("hex")}`;
}

function prPayload(headSha: string) {
  return {
    action: "synchronize",
    installation: { id: 44 },
    repository: { full_name: "owner/repo" },
    pull_request: {
      number: 28,
      head: { sha: headSha, ref: "maswe/issue-28" },
      base: { sha: HEAD_A },
    },
  };
}

function eventIdentity(run: RunRecord): unknown[] {
  return run.events.map((event) => ({
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    from: event.from,
    to: event.to,
    details: event.details,
  }));
}

async function advanceToPrReview(store: FileRunStore): Promise<RunRecord> {
  const run = await store.create("github reconciliation", "route the latest head", config());
  const transitions: Array<[WorkflowEventType, string]> = [
    ["START", "user"],
    ["BRAINSTORM_COMPLETED", "brainstormer"],
    ["APPROVE_BRAINSTORM", "user"],
    ["DESIGN_COMPLETED", "designer"],
    ["APPROVE_DESIGN", "user"],
    ["BUILD_COMPLETED", "builder"],
    ["CI_PASSED", "quality"],
    ["VERIFY_PASSED", "verifier"],
    ["PR_OPENED", "github-app"],
  ];
  for (const [type, actor] of transitions) await store.applyEvent(run, type, actor);
  run.workspace = {
    remote: "https://github.com/owner/repo.git",
    baseSha: HEAD_A,
    headSha: HEAD_A,
    branch: "maswe/issue-28",
    fingerprint: "fingerprint-a",
  };
  run.github = {
    installationId: 44,
    repository: "owner/repo",
    pullRequestNumber: 28,
    baseSha: HEAD_A,
    headSha: HEAD_A,
    branch: "maswe/issue-28",
    suspended: false,
  };
  run.evidence = {
    quality: { headSha: HEAD_A, passed: true, at: "2026-08-18T10:00:00.000Z" },
    verification: { headSha: HEAD_A, passed: true, at: "2026-08-18T10:01:00.000Z" },
    mergeReady: { headSha: HEAD_A, passed: true, at: "2026-08-18T10:02:00.000Z" },
  };
  await store.save(run);
  return run;
}

function storeWrapper(
  store: FileRunStore,
  overrides: Partial<Pick<RunStore, "save" | "applyEvent">>,
): RunStore {
  return {
    create: store.create.bind(store),
    save: overrides.save ?? store.save.bind(store),
    load: store.load.bind(store),
    list: store.list.bind(store),
    applyEvent: overrides.applyEvent ?? store.applyEvent.bind(store),
    writeArtifact: store.writeArtifact.bind(store),
    readArtifact: store.readArtifact.bind(store),
  };
}

interface AdapterHarness {
  cwd: string;
  store: FileRunStore;
  runId: string;
  adapter: GitHubAppAdapter;
  index: GitHubAssociationIndex;
  posts: Array<Record<string, unknown>>;
  setLiveHead(headSha: string): void;
}

async function adapterHarness(
  t: test.TestContext,
  options: {
    wrapStore?: (store: FileRunStore) => RunStore;
    bindAssociation?: boolean;
    associationWriteRecords?: (filePath: string, content: string) => Promise<void>;
    afterAssociationCommitBeforeRouting?: (runId: string) => Promise<void>;
    afterAssociationValidatedBeforeRouting?: (runId: string) => Promise<void>;
    afterAssociationRoutedBeforeChecks?: (runId: string) => Promise<void>;
    beforeCheckPost?: () => Promise<void>;
  } = {},
): Promise<AdapterHarness> {
  process.env[SECRET_ENV] = SECRET;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-github-reconcile-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await advanceToPrReview(store);
  const githubRoot = path.join(cwd, ".maswe", "github");
  const index = new GitHubAssociationIndex(githubRoot);
  if (options.bindAssociation !== false) {
    await index.bind({
      runId: run.id,
      installationId: 44,
      repository: "owner/repo",
      pullRequestNumber: 28,
      baseSha: HEAD_A,
      headSha: HEAD_A,
      branch: "maswe/issue-28",
    });
  }

  let liveHead = HEAD_A;
  let nextCheckId = 1;
  const posts: Array<Record<string, unknown>> = [];
  const http: GitHubHttpClient = {
    async request(method, url, requestOptions) {
      if (method === "GET" && url.includes("/pulls/")) {
        return {
          status: 200,
          headers: {},
          body: { head: { sha: liveHead }, state: "open" },
        };
      }
      if (method === "GET" && url.includes("/check-runs")) {
        return { status: 200, headers: {}, body: { check_runs: [] } };
      }
      if (method === "POST" && url.includes("/check-runs")) {
        await options.beforeCheckPost?.();
        posts.push(structuredClone(requestOptions?.body as Record<string, unknown>));
        return { status: 201, headers: {}, body: { id: nextCheckId++ } };
      }
      return { status: 200, headers: {}, body: { id: 1 } };
    },
  };
  const adapter = new GitHubAppAdapter({
    cwd,
    config: config(),
    store: options.wrapStore?.(store) ?? store,
    http,
    tokenProvider: async () => "test-token",
    synchronousWebhookDispatch: true,
    ...(options.associationWriteRecords
      ? { associationWriteRecords: options.associationWriteRecords }
      : {}),
    ...(options.afterAssociationCommitBeforeRouting
      ? { afterAssociationCommitBeforeRouting: options.afterAssociationCommitBeforeRouting }
      : {}),
    ...(options.afterAssociationValidatedBeforeRouting
      ? { afterAssociationValidatedBeforeRouting: options.afterAssociationValidatedBeforeRouting }
      : {}),
    ...(options.afterAssociationRoutedBeforeChecks
      ? { afterAssociationRoutedBeforeChecks: options.afterAssociationRoutedBeforeChecks }
      : {}),
  });
  return {
    cwd,
    store,
    runId: run.id,
    adapter,
    index,
    posts,
    setLiveHead(headSha) {
      liveHead = headSha;
    },
  };
}

async function deleteInstallation(adapter: GitHubAppAdapter, deliveryId: string): Promise<void> {
  const rawBody = JSON.stringify({ action: "deleted", installation: { id: 44 } });
  const result = await adapter.handleWebhook({
    deliveryId,
    eventName: "installation",
    signatureHeader: sign(rawBody),
    rawBody,
  });
  assert.equal(result.status, 200);
}

async function deliver(harness: AdapterHarness, headSha: string, deliveryId: string): Promise<void> {
  harness.setLiveHead(headSha);
  const rawBody = JSON.stringify(prPayload(headSha));
  await harness.adapter.handleWebhook({
    deliveryId,
    eventName: "pull_request",
    signatureHeader: sign(rawBody),
    rawBody,
  });
}

test("manual Phase A preserves index-only authorization suspension before bind", async (t) => {
  const harness = await adapterHarness(t);
  const before = await harness.store.load(harness.runId);
  await harness.index.suspend("owner/repo", 28, "authorization-revoked");

  await assert.rejects(
    harness.adapter.publishChecksForRun(harness.runId),
    /authorization.*revoked|association.*suspended/i,
  );

  assert.deepEqual(await harness.store.load(harness.runId), before);
  const indexed = await harness.index.find("owner/repo", 28);
  assert.equal(indexed?.suspended, true);
  assert.equal(indexed?.suspensionReason, "authorization-revoked");
  assert.equal(harness.posts.length, 0);
});

test("webhook does not mutate a run discovered only after its fenced identity snapshot", async (t) => {
  let listCalls = 0;
  const harness = await adapterHarness(t, {
    bindAssociation: false,
    wrapStore: (store) => ({
      create: store.create.bind(store),
      save: store.save.bind(store),
      load: store.load.bind(store),
      list: async () => {
        listCalls += 1;
        return listCalls === 1 ? [] : store.list();
      },
      applyEvent: store.applyEvent.bind(store),
      writeArtifact: store.writeArtifact.bind(store),
      readArtifact: store.readArtifact.bind(store),
    }),
  });
  const before = await harness.store.load(harness.runId);

  await deliver(harness, HEAD_B, "late-run-after-identity-snapshot");

  assert.deepEqual(await harness.store.load(harness.runId), before);
  assert.equal(await harness.index.find("owner/repo", 28), undefined);
});

test("github association failure matrix never rewrites an already-published workflow event", async (t) => {
  await t.test("run-save failure leaves the authoritative association and events unchanged", async (t) => {
    let failSave = true;
    const harness = await adapterHarness(t, {
      wrapStore: (store) => storeWrapper(store, {
        async save(run) {
          if (failSave && run.github?.headSha === HEAD_B) {
            failSave = false;
            throw new Error("simulated run-save failure");
          }
          await store.save(run);
        },
      }),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(deliver(harness, HEAD_B, "run-save-failure"), /run-save failure/);

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.deepEqual(recovered.github, before.github);
    assert.deepEqual(recovered.evidence, before.evidence);
  });

  await t.test("aggregate run-save outcome unknown never invokes association compensation", async (t) => {
    let rejectAfterPublication = true;
    let compensationSaveAttempts = 0;
    const harness = await adapterHarness(t, {
      wrapStore: (store) => storeWrapper(store, {
        async save(run) {
          if (rejectAfterPublication && run.github?.headSha === HEAD_B) {
            rejectAfterPublication = false;
            await store.save(run);
            const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError(
              "run record",
              new Error("simulated run directory sync failure"),
            );
            const nested = new Error("nested publication failure", { cause: outcomeUnknown });
            const aggregate = new AggregateError(
              [new Error("simulated run lock release failure"), nested],
              "run publication and release failed",
            );
            Object.defineProperty(aggregate, "cause", { value: aggregate });
            throw aggregate;
          }
          compensationSaveAttempts += 1;
          await store.save(run);
        },
      }),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "aggregate-run-save-outcome-unknown"),
      /publication and release failed/,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.equal(compensationSaveAttempts, 0);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.evidence, undefined);
    assert.equal((await harness.index.find("owner/repo", 28))?.headSha, HEAD_A);
  });

  await t.test("known index failure restores only prior association fields", async (t) => {
    const harness = await adapterHarness(t, {
      associationWriteRecords: async () => {
        throw new Error("simulated known index failure");
      },
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(deliver(harness, HEAD_B, "known-index-failure"), /known index failure/);

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.deepEqual(recovered.github, before.github);
    assert.deepEqual(recovered.evidence, before.evidence);
    assert.equal(recovered.state, before.state);
    assert.deepEqual(recovered.revalidation, before.revalidation);
  });

  await t.test("index outcome unknown never rolls back the published association snapshot", async (t) => {
    let failSync = true;
    const harness = await adapterHarness(t, {
      associationWriteRecords: (filePath, content) => writeDurableAtomic(
        filePath,
        content,
        "GitHub association index",
        {
          syncDirectory: async () => {
            if (!failSync) return;
            failSync = false;
            throw new Error("simulated index sync uncertainty");
          },
        },
      ),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "index-outcome-unknown"),
      DurableAtomicWriteOutcomeUnknownError,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.evidence, undefined);
    assert.equal((await harness.index.find("owner/repo", 28))?.headSha, HEAD_B);
  });

  await t.test("stop after association commit preserves the snapshot without routing an event", async (t) => {
    let stop = true;
    const harness = await adapterHarness(t, {
      afterAssociationCommitBeforeRouting: async () => {
        if (!stop) return;
        stop = false;
        throw new Error("simulated stop after association commit");
      },
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "stop-after-association"),
      /stop after association commit/,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.evidence, undefined);
    assert.equal(recovered.revalidation, undefined);

    await harness.adapter.publishChecksForRun(harness.runId);
    const routedAfterRecovery = await harness.store.load(harness.runId);
    assert.deepEqual(
      eventIdentity(routedAfterRecovery).slice(0, before.events.length),
      eventIdentity(before),
    );
    assert.equal(routedAfterRecovery.state, "CI_RUNNING");
    assert.equal(routedAfterRecovery.revalidation?.requestedHeadSha, HEAD_B);
  });

  await t.test("routing-event failure cannot roll back the already-committed association", async (t) => {
    let failRouting = true;
    const harness = await adapterHarness(t, {
      wrapStore: (store) => storeWrapper(store, {
        async applyEvent(run, type, actor, details) {
          const published = await store.applyEvent(run, type, actor, details);
          if (failRouting && type === "REVALIDATE_REQUESTED") {
            failRouting = false;
            throw new Error("simulated routing-event failure after publication");
          }
          return published;
        },
      }),
    });
    const before = await harness.store.load(harness.runId);

    await assert.rejects(deliver(harness, HEAD_B, "routing-event-failure"), /routing-event failure/);

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered).slice(0, before.events.length), eventIdentity(before));
    assert.equal(recovered.events.at(-1)?.type, "REVALIDATE_REQUESTED");
    assert.equal(recovered.github?.headSha, HEAD_B);
    assert.equal(recovered.revalidation?.requestedHeadSha, HEAD_B);
  });

  await t.test("concurrent event before known rollback is preserved and makes rollback refuse", async (t) => {
    let baseStore: FileRunStore;
    let runId = "";
    const harness = await adapterHarness(t, {
      associationWriteRecords: async () => {
        const concurrent = await baseStore.load(runId);
        await baseStore.applyEvent(concurrent, "MARK_MERGE_READY", "concurrent-user", {
          marker: "must-survive",
        });
        throw new Error("simulated index failure after concurrent event");
      },
    });
    baseStore = harness.store;
    runId = harness.runId;
    const before = await harness.store.load(harness.runId);

    await assert.rejects(
      deliver(harness, HEAD_B, "concurrent-event-before-rollback"),
      /changed before association rollback|concurrent event/,
    );

    const recovered = await harness.store.load(harness.runId);
    assert.deepEqual(eventIdentity(recovered).slice(0, before.events.length), eventIdentity(before));
    assert.equal(recovered.events.at(-1)?.type, "MARK_MERGE_READY");
    assert.deepEqual(recovered.events.at(-1)?.details, { marker: "must-survive" });
    assert.equal(recovered.github?.headSha, HEAD_B);
  });
});

test("github B then C at zero cycles retargets generation two without publishing B-bound success", async (t) => {
  const harness = await adapterHarness(t);

  await deliver(harness, HEAD_B, "head-b");
  const atB = await harness.store.load(harness.runId);
  assert.equal(atB.state, "CI_RUNNING");
  assert.equal(atB.revalidation?.generation, 1);
  assert.equal(atB.revalidation?.requestedHeadSha, HEAD_B);

  await deliver(harness, HEAD_C, "head-c");
  const atC = await harness.store.load(harness.runId);
  assert.equal(atC.state, "CI_RUNNING");
  assert.equal(atC.counters.buildVerifyCycles, 0);
  assert.equal(atC.revalidation?.returnState, "PR_REVIEW");
  assert.equal(atC.revalidation?.generation, 2);
  assert.equal(atC.revalidation?.requestedHeadSha, HEAD_C);
  assert.deepEqual(
    atC.events.filter((event) => event.type === "REVALIDATION_RETARGETED").map((event) => event.details),
    [{
      previousRequestedHeadSha: HEAD_B,
      requestedHeadSha: HEAD_C,
      generation: 2,
      returnState: "PR_REVIEW",
      source: "github",
    }],
  );
  const bBoundQualityOrVerification = harness.posts.filter((post) =>
    post.head_sha === HEAD_B &&
    (post.name === "MASWE / deterministic quality" ||
      post.name === "MASWE / independent verification"),
  );
  assert.ok(bBoundQualityOrVerification.length >= 2);
  assert.equal(
    bBoundQualityOrVerification.some((post) => post.conclusion === "success"),
    false,
  );
});

test("post-commit association fence blocks routing when authoritative identity changes", async (t) => {
  for (const mutation of [
    "index suspended before run record",
    "run record suspended before index",
    "active index head diverged",
  ] as const) {
    await t.test(mutation, async (t) => {
      let authoritativeStore: FileRunStore;
      let authoritativeIndex: GitHubAssociationIndex;
      const harness = await adapterHarness(t, {
        afterAssociationCommitBeforeRouting: async (runId) => {
          if (mutation === "index suspended before run record") {
            await authoritativeIndex.suspend(
              "owner/repo",
              28,
              "authorization-revoked",
            );
            return;
          }
          if (mutation === "run record suspended before index") {
            const concurrent = await authoritativeStore.load(runId);
            concurrent.github = {
              ...concurrent.github!,
              suspended: true,
              suspensionReason: "authorization-revoked",
            };
            await authoritativeStore.save(concurrent);
            return;
          }
          const committed = await authoritativeIndex.find("owner/repo", 28);
          assert.ok(committed);
          await authoritativeIndex.bind({
            runId: committed.runId,
            installationId: committed.installationId,
            repository: committed.repository,
            pullRequestNumber: committed.pullRequestNumber,
            baseSha: committed.baseSha,
            headSha: HEAD_C,
            branch: committed.branch,
          });
        },
      });
      authoritativeStore = harness.store;
      authoritativeIndex = harness.index;
      const before = await harness.store.load(harness.runId);

      await assert.rejects(
        deliver(harness, HEAD_B, `association-fence-${mutation.replaceAll(" ", "-")}`),
        /association.*changed|association.*active|routing/i,
      );

      const recovered = await harness.store.load(harness.runId);
      assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
      assert.equal(recovered.state, "PR_REVIEW");
      assert.equal(recovered.revalidation, undefined);
      assert.equal(harness.posts.length, 0);
    });
  }
});

test("installation suspension that wins after association validation publishes no routing event", async (t) => {
  let suspensionAdapter!: GitHubAppAdapter;
  const harness = await adapterHarness(t, {
    afterAssociationValidatedBeforeRouting: async () => {
      await deleteInstallation(
        suspensionAdapter,
        "installation-deleted-after-association-validation",
      );
    },
  });
  suspensionAdapter = new GitHubAppAdapter({
    cwd: harness.cwd,
    config: config(),
    store: harness.store,
    http: { async request() { throw new Error("installation suspension must not call GitHub"); } },
    tokenProvider: async () => {
      throw new Error("installation suspension must not create a token");
    },
    synchronousWebhookDispatch: true,
  });
  await suspensionAdapter.initialize();
  const before = await harness.store.load(harness.runId);

  await assert.rejects(
    deliver(harness, HEAD_B, "suspension-after-association-validation"),
    /association.*changed|association.*active|routing/i,
  );

  const recovered = await harness.store.load(harness.runId);
  assert.deepEqual(eventIdentity(recovered), eventIdentity(before));
  assert.equal(recovered.github?.suspended, true);
  assert.equal((await harness.index.find("owner/repo", 28))?.suspended, true);
  assert.equal(harness.posts.length, 0);
});

test("installation suspension started after routing cannot publish checks against suspended state", async (t) => {
  let harness!: AdapterHarness;
  let suspensionAdapter!: GitHubAppAdapter;
  let suspension: Promise<void> | undefined;
  let eventHistoryDuringCheckPublication: unknown[] | undefined;
  let staleCheckPosts = 0;
  harness = await adapterHarness(t, {
    afterAssociationRoutedBeforeChecks: async () => {
      suspension = deleteInstallation(
        suspensionAdapter,
        "installation-deleted-after-association-routing",
      );
    },
    beforeCheckPost: async () => {
      const authoritative = await harness.store.load(harness.runId);
      eventHistoryDuringCheckPublication = eventIdentity(authoritative);
      if (authoritative.github?.suspended) staleCheckPosts += 1;
    },
  });
  suspensionAdapter = new GitHubAppAdapter({
    cwd: harness.cwd,
    config: config(),
    store: harness.store,
    http: { async request() { throw new Error("installation suspension must not call GitHub"); } },
    tokenProvider: async () => {
      throw new Error("installation suspension must not create a token");
    },
    synchronousWebhookDispatch: true,
  });
  await suspensionAdapter.initialize();

  await deliver(harness, HEAD_B, "suspension-after-association-routing");
  assert.ok(suspension, "post-route suspension interleaving was not injected");
  await suspension;

  const recovered = await harness.store.load(harness.runId);
  assert.equal(staleCheckPosts, 0);
  assert.ok(eventHistoryDuringCheckPublication);
  assert.deepEqual(eventIdentity(recovered), eventHistoryDuringCheckPublication);
  assert.equal(recovered.events.at(-1)?.type, "REVALIDATE_REQUESTED");
  assert.equal(recovered.github?.suspended, true);
  assert.equal((await harness.index.find("owner/repo", 28))?.suspended, true);
  assert.ok(harness.posts.length > 0);
});

test("association rollback callbacks run in reverse and aggregate every known-failure callback error", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-known-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const order: string[] = [];
  const index = new GitHubAssociationIndex(path.join(cwd, "github"));

  let caught: unknown;
  try {
    await index.withTransaction(async (transaction) => {
      transaction.onRollback(async () => {
        order.push("first");
        throw new Error("first rollback failed");
      });
      transaction.onRollback(async () => {
        order.push("second");
        throw new Error("second rollback failed");
      });
      throw new Error("known association failure");
    });
  } catch (error) {
    caught = error;
  }

  assert.deepEqual(order, ["second", "first"]);
  assert.ok(caught instanceof AggregateError);
  assert.deepEqual(
    caught.errors.map((error) => (error as Error).message),
    ["known association failure", "second rollback failed", "first rollback failed"],
  );
});

test("association outcome unknown never invokes registered rollback callbacks", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-unknown-rollback-"));
  t.after(async () => rm(cwd, { recursive: true, force: true }));
  const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError(
    "GitHub association index",
    new Error("simulated directory sync failure"),
  );
  const rollbacks: string[] = [];
  const index = new GitHubAssociationIndex(path.join(cwd, "github"), {
    writeRecords: async () => {
      throw outcomeUnknown;
    },
  });

  await assert.rejects(
    index.withTransaction(async (transaction) => {
      transaction.onRollback(async () => {
        rollbacks.push("must-not-run");
      });
      transaction.bind({
        runId: "run-outcome-unknown",
        installationId: 44,
        repository: "owner/repo",
        pullRequestNumber: 28,
        baseSha: HEAD_A,
        headSha: HEAD_B,
        branch: "maswe/issue-28",
      });
    }),
    (error: unknown) => error === outcomeUnknown,
  );
  assert.deepEqual(rollbacks, []);
});

for (const nesting of ["AggregateError.errors", "Error.cause"] as const) {
  test(`association transaction treats nested outcome uncertainty in ${nesting} as non-compensable`, async (t) => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-issue28-nested-unknown-"));
    t.after(async () => rm(cwd, { recursive: true, force: true }));
    const outcomeUnknown = new DurableAtomicWriteOutcomeUnknownError(
      "GitHub association index",
      new Error("simulated directory sync failure"),
    );
    let nested: Error;
    if (nesting === "AggregateError.errors") {
      const aggregate = new AggregateError(
        [new Error("release failed"), outcomeUnknown],
        "association publication and release failed",
      );
      Object.defineProperty(aggregate, "cause", { value: aggregate });
      nested = aggregate;
    } else {
      nested = new Error("association publication wrapper", { cause: outcomeUnknown });
      Object.defineProperty(outcomeUnknown, "cause", { value: nested });
    }
    let rollbackCalls = 0;
    const index = new GitHubAssociationIndex(path.join(cwd, "github"), {
      writeRecords: async () => {
        throw nested;
      },
    });

    await assert.rejects(
      index.withTransaction(async (transaction) => {
        transaction.onRollback(async () => {
          rollbackCalls += 1;
        });
        transaction.bind({
          runId: `run-nested-${nesting === "Error.cause" ? "cause" : "aggregate"}`,
          installationId: 44,
          repository: "owner/repo",
          pullRequestNumber: 28,
          baseSha: HEAD_A,
          headSha: HEAD_B,
          branch: "maswe/issue-28",
        });
      }),
      (error: unknown) => error === nested,
    );
    assert.equal(rollbackCalls, 0);
  });
}
