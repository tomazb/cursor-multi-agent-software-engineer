import type { GitHubAppConfig, MasweConfig, RunRecord } from "../domain.ts";
import { DurableAtomicWriteOutcomeUnknownError } from "../durable-file.ts";
import { invalidateStaleEvidence } from "../git-workspace.ts";
import { RevalidationService } from "../revalidation.ts";
import type { RunStore } from "../store.ts";
import {
  GitHubAssociationIndex,
  type GitHubAssociationTransaction,
} from "./association.ts";
import {
  isRepoAllowed,
  githubStateRoot,
  parseOwnerRepo,
  pendingCancellationHeads,
  remoteMatchesRepository,
} from "./adapter-identities.ts";
export { remoteMatchesRepository } from "./adapter-identities.ts";
import { CheckPublisher, type GitHubHttpClient } from "./checks.ts";
import { GitHubDeliveryInbox } from "./delivery-inbox.ts";
import { GitHubSideEffectStore } from "./side-effect-store.ts";
import {
  initializeGitHubJournals,
  initializeLegacyCheckCreateJournals,
  withGitHubJournal,
} from "./journal.ts";
import type { GitHubInternalEvent } from "./types.ts";
import {
  prepareWebhookRequest,
  type WebhookHandleResult,
  type WebhookRequest,
} from "./webhook-request.ts";
export type { WebhookHandleResult, WebhookRequest } from "./webhook-request.ts";
import { GitHubWebhookDiagnosticError } from "./webhook-diagnostic.ts";
import { GitHubWebhookWorker } from "./webhook-worker.ts";
export {
  GitHubWebhookDiagnosticError,
  type GitHubWebhookDiagnosticCode,
} from "./webhook-diagnostic.ts";

function eventHistoryIdentity(events: RunRecord["events"]): string {
  return JSON.stringify(events.map((event) => ({
    id: event.id,
    at: event.at,
    type: event.type,
    actor: event.actor,
    from: event.from,
    to: event.to,
    details: event.details,
  })));
}

function associationRollbackInvariant(run: RunRecord): string {
  const record = structuredClone(run) as unknown as Record<string, unknown>;
  delete record.version;
  delete record.updatedAt;
  delete record.github;
  delete record.evidence;
  return JSON.stringify(record);
}

export class GitHubAppAdapter {
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly store: RunStore;
  private readonly http: GitHubHttpClient;
  private readonly tokenProvider: (installationId: number, repository: string) => Promise<string>;
  private readonly inbox: GitHubDeliveryInbox;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly associations: GitHubAssociationIndex;
  private readonly root: string;
  private readonly afterManualRunLoaded: ((runId: string) => Promise<void>) | undefined;
  private readonly beforeAssociationTransaction: ((deliveryId: string) => Promise<void>) | undefined;
  private readonly afterAssociationCommitBeforeRouting:
    ((runId: string) => Promise<void>) | undefined;
  private journalInitialization: Promise<void> | undefined;
  private inboxInitialization: Promise<void> | undefined;
  private readonly webhookWorker: GitHubWebhookWorker;
  private readonly synchronousWebhookDispatch: boolean;
  private readonly beforeInboxEnqueue: (() => Promise<void>) | undefined;
  private readonly onWebhookDiagnostic: ((error: unknown) => void) | undefined;

  constructor(options: {
    cwd: string;
    config: MasweConfig;
    store: RunStore;
    http: GitHubHttpClient;
    tokenProvider: (installationId: number, repository: string) => Promise<string>;
    /** Test/embedded seam; the CLI starts recovery explicitly before listening. */
    autoStartWebhookWorker?: boolean;
    /** Deterministic legacy-dispatch seam used only by focused adapter tests. */
    synchronousWebhookDispatch?: boolean;
    /** Deterministic seam for durable handoff write/journal failures. */
    beforeInboxEnqueue?: () => Promise<void>;
    inboxOptions?: ConstructorParameters<typeof GitHubDeliveryInbox>[1];
    onWebhookDiagnostic?: (error: unknown) => void;
    /** Deterministic seam exposing due-aware worker sleeps. */
    onWebhookWorkerSchedule?: (delayMs: number) => void;
    /** Deterministic barrier after the manual command's initial snapshot, before its fence. */
    afterManualRunLoaded?: (runId: string) => Promise<void>;
    /** Deterministic barrier before a PR association transaction is acquired. */
    beforeAssociationTransaction?: (deliveryId: string) => Promise<void>;
    /** Deterministic crash seam after association commit and before workflow routing. */
    afterAssociationCommitBeforeRouting?: (runId: string) => Promise<void>;
    /** Deterministic test seam for association index commit failures. */
    associationWriteRecords?: (filePath: string, content: string) => Promise<void>;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.http = options.http;
    this.tokenProvider = options.tokenProvider;
    this.afterManualRunLoaded = options.afterManualRunLoaded;
    this.beforeAssociationTransaction = options.beforeAssociationTransaction;
    this.afterAssociationCommitBeforeRouting = options.afterAssociationCommitBeforeRouting;
    const root = githubStateRoot(options.cwd);
    this.root = root;
    this.inbox = new GitHubDeliveryInbox(root, options.inboxOptions);
    this.synchronousWebhookDispatch = options.synchronousWebhookDispatch ?? false;
    this.beforeInboxEnqueue = options.beforeInboxEnqueue;
    this.onWebhookDiagnostic = options.onWebhookDiagnostic;
    this.sideEffects = new GitHubSideEffectStore(root);
    this.associations = new GitHubAssociationIndex(
      root,
      options.associationWriteRecords
        ? { writeRecords: options.associationWriteRecords }
        : {},
    );
    this.webhookWorker = new GitHubWebhookWorker({
      inbox: this.inbox,
      enabled: options.autoStartWebhookWorker ?? false,
      dispatch: (event) => this.dispatch(event, this.githubApp()),
      onDiagnostic: (error) => this.emitWebhookDiagnostic(error),
      ...(options.onWebhookWorkerSchedule
        ? { onSchedule: options.onWebhookWorkerSchedule }
        : {}),
    });
  }

  /** Fail-closed journal preflight shared by webhook and manual publication. */
  private async initializePublicationJournals(): Promise<void> {
    this.journalInitialization ??= (async () => {
      await initializeGitHubJournals(this.root);
      await initializeLegacyCheckCreateJournals(this.root);
      await withGitHubJournal(this.root, "check-create", "preflight", async () => undefined);
      await withGitHubJournal(this.root, "publication", "preflight", async () => undefined);
    })();
    try {
      await this.journalInitialization;
    } catch (error) {
      this.journalInitialization = undefined;
      throw error;
    }
  }

  /**
   * Recover durable ingress only for the listener topology. A simultaneous manual publisher
   * preflights its own journals without reclaiming the listener's active delivery lease.
   */
  async initialize(): Promise<void> {
    void this.webhookSecret();
    this.inboxInitialization ??= (async () => {
      await this.initializePublicationJournals();
      await this.inbox.initialize();
    })();
    try {
      await this.inboxInitialization;
    } catch (error) {
      this.inboxInitialization = undefined;
      throw error;
    }
  }

  /** Fail-closed preflight for the manual check publisher's local journals. */
  async initializeManualPublisher(): Promise<void> {
    await this.initializePublicationJournals();
  }

  private githubApp(): GitHubAppConfig {
    const app = this.config.githubApp;
    if (!app?.enabled) {
      throw new Error("githubApp is not enabled in configuration");
    }
    return app;
  }

  private webhookSecret(): string {
    const envName = this.githubApp().webhookSecretEnv;
    const secret = process.env[envName];
    if (!secret) throw new Error("GitHub App webhook secret is missing");
    return secret;
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookHandleResult> {
    this.githubApp();
    const prepared = prepareWebhookRequest(request, this.webhookSecret());
    if (prepared.kind === "reject") return prepared.result;
    if (prepared.kind === "unsupported") {
      let ignored;
      try {
        await this.initialize();
        await this.beforeInboxEnqueue?.();
        ignored = await this.inbox.completeWithoutDispatch({
          deliveryId: prepared.deliveryId,
          eventName: prepared.eventName,
          receivedAt: prepared.receivedAt,
          rawBodyDigest: prepared.rawBodyDigest,
        });
      } catch (handoffError) {
        this.emitWebhookDiagnostic(new GitHubWebhookDiagnosticError(
          "GITHUB_WEBHOOK_HANDOFF_FAILED",
          {
            deliveryId: prepared.deliveryId,
            eventName: prepared.eventName,
            attempt: 0,
          },
          handoffError,
        ));
        return {
          status: 503,
          body: { ok: false, message: "durable webhook handoff unavailable" },
        };
      }
      if (ignored.outcome === "conflict") {
        return { status: 409, body: { ok: false, message: "delivery id conflict" } };
      }
      return { status: 200, body: { ok: true, message: "unsupported webhook ignored" } };
    }
    let enqueue;
    try {
      await this.initialize();
      await this.beforeInboxEnqueue?.();
      enqueue = await this.inbox.enqueue({
        deliveryId: prepared.deliveryId,
        eventName: prepared.eventName,
        receivedAt: prepared.event.receivedAt,
        rawBodyDigest: prepared.rawBodyDigest,
        event: prepared.event,
      });
    } catch (handoffError) {
      this.emitWebhookDiagnostic(new GitHubWebhookDiagnosticError(
        "GITHUB_WEBHOOK_HANDOFF_FAILED",
        {
          deliveryId: prepared.deliveryId,
          eventName: prepared.eventName,
          attempt: 0,
        },
        handoffError,
      ));
      return {
        status: 503,
        body: { ok: false, message: "durable webhook handoff unavailable" },
      };
    }
    if (enqueue.outcome === "conflict") {
      return { status: 409, body: { ok: false, message: "delivery id conflict" } };
    }
    if (enqueue.status === "completed" || enqueue.status === "legacy-completed") {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    if (this.synchronousWebhookDispatch) {
      const claimed = await this.inbox.claimNext();
      if (!claimed) {
        return { status: 202, body: { ok: true, duplicate: true } };
      }
      try {
        await this.dispatch(claimed.record.event, this.githubApp());
        await this.inbox.complete(claimed.record.deliveryId, claimed.record.leaseId);
        return { status: 200, body: { ok: true } };
      } catch (error) {
        await this.inbox.retry(claimed.record.deliveryId, claimed.record.leaseId);
        throw error;
      }
    }
    this.webhookWorker.wake();
    return {
      status: 202,
      body: {
        ok: true,
        ...(enqueue.outcome === "duplicate" ? { duplicate: true } : {}),
      },
    };
  }

  async startWebhookWorker(): Promise<void> {
    await this.initialize();
    this.webhookWorker.start();
  }

  private emitWebhookDiagnostic(error: unknown): void {
    try {
      this.onWebhookDiagnostic?.(error);
    } catch {
      // Diagnostics never alter durable queue state.
    }
  }

  async waitForWebhookIdle(timeoutMs = 10_000): Promise<void> {
    return this.webhookWorker.waitForIdle(timeoutMs);
  }

  async stopWebhookWorker(options: { drainMs?: number } = {}): Promise<void> {
    return this.webhookWorker.stop(options);
  }

  async publishChecksForRun(runId: string): Promise<RunRecord> {
    await this.initializeManualPublisher();
    const app = this.githubApp();
    const initial = await this.store.load(runId);
    if (!initial.github) {
      throw new Error(`Run ${runId} has no github association`);
    }
    await this.afterManualRunLoaded?.(runId);
    return this.withPublicationFence(
      initial.github.repository,
      initial.github.pullRequestNumber,
      async () => {
        const beforeLiveHead = await this.store.load(runId);
        if (!beforeLiveHead.github) {
          throw new Error(`Run ${runId} has no github association`);
        }
        if (
          beforeLiveHead.github.repository !== initial.github!.repository ||
          beforeLiveHead.github.pullRequestNumber !== initial.github!.pullRequestNumber
        ) {
          throw new Error(`Run ${runId} github association changed during publication`);
        }
        if (beforeLiveHead.github.suspended) {
          throw new Error(`Run ${runId} github association is suspended`);
        }
        if (!isRepoAllowed(app, beforeLiveHead.github.repository)) {
          throw new Error(`Repository ${beforeLiveHead.github.repository} is not allowlisted`);
        }
        const livePullRequest = await this.currentPullRequest(
          beforeLiveHead.github.repository,
          beforeLiveHead.github.pullRequestNumber,
          beforeLiveHead.github.installationId,
        );
        if (livePullRequest.state !== "open") {
          throw new Error(`Pull request ${beforeLiveHead.github.repository}#${beforeLiveHead.github.pullRequestNumber} is not open`);
        }
        const liveHead = livePullRequest.headSha;
        const publication = await this.associations.withTransaction(async (transaction) => {
          const run = await this.store.load(runId);
          if (!run.github) {
            throw new Error(`Run ${runId} has no github association`);
          }
          if (
            run.github.repository !== beforeLiveHead.github!.repository ||
            run.github.pullRequestNumber !== beforeLiveHead.github!.pullRequestNumber
          ) {
            throw new Error(`Run ${runId} github association changed during publication`);
          }
          if (run.github.suspended) {
            throw new Error(`Run ${runId} github association is suspended`);
          }
          const previousHeadSha = run.github.headSha || run.workspace?.headSha;
          if (!previousHeadSha) throw new Error(`Run ${runId} has no head SHA for checks`);
          const pendingHeadShas = pendingCancellationHeads(
            run.github.pendingCancellationHeadShas,
            previousHeadSha,
            liveHead,
          );
          if (liveHead !== previousHeadSha) {
            const before = structuredClone(run);
            invalidateStaleEvidence(run, liveHead);
            run.github = {
              ...run.github,
              headSha: liveHead,
              ...(pendingHeadShas.length > 0
                ? { pendingCancellationHeadShas: pendingHeadShas }
                : {}),
            };
            if (pendingHeadShas.length === 0) {
              delete run.github.pendingCancellationHeadShas;
            }
            await this.saveAssociationMutation(before, run, transaction);
          }
          transaction.bind({
            runId: run.id,
            installationId: run.github.installationId,
            repository: run.github.repository,
            pullRequestNumber: run.github.pullRequestNumber,
            baseSha: run.github.baseSha,
            headSha: liveHead,
            branch: run.github.branch,
          });
          return { run, previousHeadSha, pendingHeadShas };
        });
        const routed = await this.routeAssociationHead(
          publication.run.id,
          publication.previousHeadSha,
          liveHead,
        );
        await this.publishChecks(
          routed,
          routed.github!.repository,
          routed.github!.pullRequestNumber,
          liveHead,
          routed.github!.installationId,
          publication.pendingHeadShas,
        );
        return this.clearPublishedCancellationHeads(
          routed.id,
          routed.github!.repository,
          routed.github!.pullRequestNumber,
          liveHead,
          publication.pendingHeadShas,
        );
      },
    );
  }

  private async withPublicationFence<T>(
    repository: string,
    pullRequestNumber: number,
    callback: () => Promise<T>,
  ): Promise<T> {
    return withGitHubJournal(
      this.root,
      "publication",
      `${repository.toLowerCase()}#${pullRequestNumber}`,
      callback,
      { timeoutMs: 60_000 },
    );
  }

  private async rollbackRunMutation(
    before: RunRecord,
    attempted: RunRecord,
  ): Promise<void> {
    const current = await this.store.load(before.id);
    if (current.version === before.version) return;
    if (current.version !== attempted.version) {
      throw new Error(
        `Run ${before.id} changed before association rollback: expected ${attempted.version}, on disk ${current.version}`,
      );
    }
    if (
      eventHistoryIdentity(current.events) !== eventHistoryIdentity(attempted.events) ||
      associationRollbackInvariant(current) !== associationRollbackInvariant(attempted)
    ) {
      throw new Error(
        `Run ${before.id} changed before association rollback: attempted snapshot no longer matches`,
      );
    }
    const rollback = structuredClone(current);
    if (before.github === undefined) delete rollback.github;
    else rollback.github = structuredClone(before.github);
    if (before.evidence === undefined) delete rollback.evidence;
    else rollback.evidence = structuredClone(before.evidence);
    await this.store.save(rollback);
  }

  private async saveAssociationMutation(
    before: RunRecord,
    run: RunRecord,
    transaction: GitHubAssociationTransaction,
  ): Promise<void> {
    if (
      eventHistoryIdentity(run.events) !== eventHistoryIdentity(before.events) ||
      associationRollbackInvariant(run) !== associationRollbackInvariant(before)
    ) {
      throw new Error(
        `Run ${before.id} association transaction changed fields outside github/evidence`,
      );
    }
    try {
      await this.store.save(run);
    } catch (error) {
      if (error instanceof DurableAtomicWriteOutcomeUnknownError) throw error;
      try {
        await this.rollbackRunMutation(before, run);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          error instanceof Error ? error.message : "Run save failed",
          { cause: error },
        );
      }
      throw error;
    }
    const attempted = structuredClone(run);
    transaction.onRollback(() => this.rollbackRunMutation(before, attempted));
  }

  private async routeAssociationHead(
    runId: string,
    previousHeadSha: string | undefined,
    requestedHeadSha: string,
  ): Promise<RunRecord> {
    await this.afterAssociationCommitBeforeRouting?.(runId);
    const authoritative = await this.store.load(runId);
    const priorAssociationHeadSha =
      previousHeadSha !== requestedHeadSha ? previousHeadSha : undefined;
    const priorWorkspaceHeadSha =
      authoritative.workspace?.headSha !== requestedHeadSha
        ? authoritative.workspace?.headSha
        : undefined;
    const pendingPredecessor = authoritative.github?.pendingCancellationHeadShas?.find(
      (headSha) => headSha !== requestedHeadSha,
    );
    const routingPreviousHeadSha =
      authoritative.revalidation?.requestedHeadSha ??
      priorAssociationHeadSha ??
      priorWorkspaceHeadSha ??
      pendingPredecessor ??
      previousHeadSha ??
      authoritative.workspace?.headSha;
    if (!routingPreviousHeadSha) return authoritative;
    if (
      authoritative.revalidation === undefined &&
      authoritative.state !== "PR_READY" &&
      authoritative.state !== "PR_REVIEW"
    ) {
      return authoritative;
    }
    if (
      authoritative.revalidation === undefined &&
      routingPreviousHeadSha === requestedHeadSha
    ) {
      return authoritative;
    }
    await new RevalidationService(this.store).route(runId, {
      source: "github",
      previousHeadSha: routingPreviousHeadSha,
      requestedHeadSha,
      expectedRunVersion: authoritative.version,
      actor: "github-app",
    });
    return this.store.load(runId);
  }

  private async clearPublishedCancellationHeads(
    runId: string,
    repository: string,
    pullRequestNumber: number,
    publishedHeadSha: string,
    cancelledHeadShas: readonly string[],
  ): Promise<RunRecord> {
    if (cancelledHeadShas.length === 0) return this.store.load(runId);
    const cancelled = new Set(cancelledHeadShas);
    return this.associations.withTransaction(async (transaction) => {
      const run = await this.store.load(runId);
      if (
        !run.github ||
        run.github.repository !== repository ||
        run.github.pullRequestNumber !== pullRequestNumber ||
        run.github.headSha !== publishedHeadSha
      ) {
        throw new Error(`Run ${runId} github association changed during publication`);
      }
      const currentPending = run.github.pendingCancellationHeadShas ?? [];
      const remaining = currentPending.filter((headSha) => !cancelled.has(headSha));
      if (remaining.length !== currentPending.length) {
        const before = structuredClone(run);
        run.github = {
          ...run.github,
          ...(remaining.length > 0 ? { pendingCancellationHeadShas: remaining } : {}),
        };
        if (remaining.length === 0) delete run.github.pendingCancellationHeadShas;
        await this.saveAssociationMutation(before, run, transaction);
      }
      transaction.bind({
        runId: run.id,
        installationId: run.github.installationId,
        repository: run.github.repository,
        pullRequestNumber: run.github.pullRequestNumber,
        baseSha: run.github.baseSha,
        headSha: run.github.headSha,
        branch: run.github.branch,
        ...(run.github.suspended !== undefined ? { suspended: run.github.suspended } : {}),
      });
      return run;
    });
  }

  private async dispatch(event: GitHubInternalEvent, app: GitHubAppConfig): Promise<void> {
    if (event.type === "installation.deleted") {
      if (event.installationId !== undefined) {
        const suspended = await this.associations.suspendInstallation(event.installationId);
        await this.suspendRunRecords(suspended.map((record) => record.runId));
      }
      return;
    }

    if (event.type === "installation_repositories.removed") {
      if (event.installationId === undefined) return;
      const repositories =
        event.repositories && event.repositories.length > 0
          ? event.repositories
          : event.repository
            ? [event.repository]
            : [];
      const runIds: string[] = [];
      for (const repository of repositories) {
        const suspended = await this.associations.suspendRepository(
          event.installationId,
          repository,
        );
        runIds.push(...suspended.map((record) => record.runId));
      }
      await this.suspendRunRecords(runIds);
      return;
    }

    if (event.observeOnly) {
      return;
    }

    if (event.repository && !isRepoAllowed(app, event.repository)) {
      return;
    }

    if (
      event.type.startsWith("pull_request.") &&
      event.repository &&
      event.pullRequestNumber !== undefined &&
      event.headSha
    ) {
      await this.handlePullRequestEvent(event);
      return;
    }

    if (event.type === "push" && event.repository && event.branch && event.headSha) {
      await this.handlePushEvent(event);
    }
  }

  private async suspendRunRecords(runIds: string[]): Promise<void> {
    for (const runId of runIds) {
      let run: RunRecord;
      try {
        run = await this.store.load(runId);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") continue;
        if (error instanceof Error && /not found|missing/i.test(error.message)) continue;
        throw error;
      }
      if (!run.github) continue;
      if (
        run.github.suspended &&
        run.github.suspensionReason === "authorization-revoked"
      ) {
        continue;
      }
      run.github = {
        ...run.github,
        suspended: true,
        suspensionReason: "authorization-revoked",
      };
      await this.store.save(run);
    }
  }

  private async handlePushEvent(event: GitHubInternalEvent): Promise<void> {
    const repository = event.repository!;
    const branch = event.branch!;
    const headSha = event.headSha!;
    const associations = await this.associations.findAllByRepositoryBranch(repository, branch);
    const failures: unknown[] = [];
    for (const association of associations) {
      if (association.suspended) continue;
      const synthetic: GitHubInternalEvent = {
        ...event,
        type: "pull_request.synchronize",
        pullRequestNumber: association.pullRequestNumber,
        headSha,
        branch,
        repository,
        installationId: association.installationId,
      };
      try {
        await this.handlePullRequestEvent(synthetic);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        `Push invalidation failed for ${failures.length} pull request association(s)`,
      );
    }
  }

  private async currentPullRequest(
    repository: string,
    pullRequestNumber: number,
    installationId: number,
  ): Promise<{ headSha: string; state: "open" | "closed" }> {
    const { owner, repo } = parseOwnerRepo(repository);
    const token = await this.tokenProvider(installationId, repository);
    const response = await this.http.request(
      "GET",
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullRequestNumber}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
          "user-agent": "maswe-github-app",
        },
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Failed to resolve current PR head for ${repository}#${pullRequestNumber}: HTTP ${response.status}`,
      );
    }
    const body = response.body as { head?: { sha?: string }; state?: unknown };
    const head = body.head;
    if (typeof head?.sha !== "string" || !head.sha) {
      throw new Error(
        `Failed to resolve current PR head for ${repository}#${pullRequestNumber}: missing head.sha`,
      );
    }
    if (body.state !== "open" && body.state !== "closed") {
      throw new Error(
        `Failed to resolve current PR state for ${repository}#${pullRequestNumber}`,
      );
    }
    return { headSha: head.sha, state: body.state };
  }

  private async handlePullRequestEvent(event: GitHubInternalEvent): Promise<void> {
    const repository = event.repository!;
    const pullRequestNumber = event.pullRequestNumber!;
    const headSha = event.headSha!;
    const installationId = event.installationId;
    if (installationId === undefined || installationId <= 0) {
      throw new Error("pull_request event missing installation id");
    }
    await this.withPublicationFence(repository, pullRequestNumber, async () => {
      const livePullRequest = await this.currentPullRequest(
        repository,
        pullRequestNumber,
        installationId,
      );
      const liveHead = livePullRequest.headSha;
      if (liveHead !== headSha) {
        // Stale or out-of-order delivery: current PR head has already moved on.
        return;
      }
      const expectsClosed = event.type === "pull_request.closed";
      if (
        (expectsClosed && livePullRequest.state !== "closed") ||
        (!expectsClosed && livePullRequest.state !== "open")
      ) {
        // Same-SHA out-of-order lifecycle deliveries cannot invert the live PR state.
        return;
      }

      await this.beforeAssociationTransaction?.(event.eventId);
      const publication = await this.associations.withTransaction(async (transaction) => {
        const association = transaction.find(repository, pullRequestNumber);
        const reopeningClosure =
          event.type === "pull_request.reopened" &&
          association?.suspended === true &&
          association.suspensionReason === "pull-request-closed";
        if (association?.suspended && !reopeningClosure) {
          return { kind: "ignore" } as const;
        }

        if (event.type === "pull_request.closed") {
          const associatedRun = association
            ? await this.store.load(association.runId)
            : await this.findMatchingRun(repository, pullRequestNumber, event.branch, {
              allowPullRequestClosedSuspension: true,
            });
          if (associatedRun?.github) {
            const before = structuredClone(associatedRun);
            associatedRun.github = {
              ...associatedRun.github,
              suspended: true,
              suspensionReason: "pull-request-closed",
            };
            await this.saveAssociationMutation(before, associatedRun, transaction);
          }
          if (association) {
            transaction.suspend(
              repository,
              pullRequestNumber,
              "pull-request-closed",
            );
          } else if (associatedRun?.github) {
            transaction.bind({
              runId: associatedRun.id,
              installationId,
              repository,
              pullRequestNumber,
              baseSha: associatedRun.github.baseSha,
              headSha,
              branch: associatedRun.github.branch,
              suspended: true,
              suspensionReason: "pull-request-closed",
            });
          }
          return { kind: "ignore" } as const;
        }

        const run = association
          ? await this.store.load(association.runId)
          : await this.findMatchingRun(repository, pullRequestNumber, event.branch, {
            allowPullRequestClosedSuspension: event.type === "pull_request.reopened",
          });
        if (!run) return { kind: "unassociated" } as const;
        const reopeningRunClosure =
          event.type === "pull_request.reopened" &&
          run.github?.suspended === true &&
          run.github.suspensionReason === "pull-request-closed";
        if (
          run.github?.suspended &&
          !(reopeningClosure || reopeningRunClosure)
        ) {
          return { kind: "ignore" } as const;
        }
        const before = structuredClone(run);
        const previousHeadSha = run.github?.headSha ?? association?.headSha;
        const pendingHeadShas = pendingCancellationHeads(
          run.github?.pendingCancellationHeadShas,
          previousHeadSha,
          headSha,
        );
        invalidateStaleEvidence(run, headSha);
        run.github = {
          installationId,
          repository,
          pullRequestNumber,
          baseSha: event.baseSha ?? run.github?.baseSha ?? run.workspace?.baseSha ?? headSha,
          headSha,
          branch: event.branch ?? run.github?.branch ?? run.workspace?.branch ?? "unknown",
          suspended: false,
          ...(pendingHeadShas.length > 0
            ? { pendingCancellationHeadShas: pendingHeadShas }
            : {}),
        };
        await this.saveAssociationMutation(before, run, transaction);
        transaction.bind({
          runId: run.id,
          installationId,
          repository,
          pullRequestNumber,
          baseSha: run.github.baseSha,
          headSha,
          branch: run.github.branch,
        });
        return { kind: "publish", run, previousHeadSha, pendingHeadShas } as const;
      });

      if (publication.kind === "publish") {
        const routed = await this.routeAssociationHead(
          publication.run.id,
          publication.previousHeadSha,
          headSha,
        );
        await this.publishChecks(
          routed,
          repository,
          pullRequestNumber,
          headSha,
          installationId,
          publication.pendingHeadShas,
        );
        await this.clearPublishedCancellationHeads(
          routed.id,
          repository,
          pullRequestNumber,
          headSha,
          publication.pendingHeadShas,
        );
        return;
      }
      if (publication.kind === "ignore") return;

      const synthetic: RunRecord = {
        schemaVersion: 1,
        version: 1,
        id: "unassociated",
        title: "unassociated",
        request: "",
        repositoryPath: this.cwd,
        state: "PR_REVIEW",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        approvals: { brainstorm: false, design: false },
        counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
        config: this.config,
        artifacts: [],
        events: [],
        github: {
          installationId,
          repository,
          pullRequestNumber,
          baseSha: event.baseSha ?? headSha,
          headSha,
          branch: event.branch ?? "unknown",
          suspended: false,
        },
      };
      await this.publishChecks(synthetic, repository, pullRequestNumber, headSha, installationId);
    });
  }

  private async findMatchingRun(
    repository: string,
    pullRequestNumber: number,
    branch: string | undefined,
    options: { allowPullRequestClosedSuspension?: boolean } = {},
  ): Promise<RunRecord | undefined> {
    const runs = await this.store.list();
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

    // Exact PR association on the run record wins.
    for (const run of runs) {
      const recoverableClosure =
        options.allowPullRequestClosedSuspension === true &&
        run.github?.suspended === true &&
        run.github.suspensionReason === "pull-request-closed";
      if (terminal.has(run.state) || (run.github?.suspended && !recoverableClosure)) continue;
      if (
        run.github?.repository === repository &&
        run.github.pullRequestNumber === pullRequestNumber
      ) {
        return run;
      }
    }

    // Otherwise require exact remote + branch match (never repository-only).
    if (!branch) return undefined;
    for (const run of runs) {
      if (terminal.has(run.state) || run.github?.suspended) continue;
      if (run.github && run.github.repository === repository) {
        // Already associated to a different PR — do not steal.
        if (run.github.pullRequestNumber !== pullRequestNumber) continue;
      }
      if (
        remoteMatchesRepository(run.workspace?.remote, repository) &&
        run.workspace?.branch === branch
      ) {
        return run;
      }
    }
    return undefined;
  }

  private async publishChecks(
    run: RunRecord,
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    installationId: number,
    previousHeadShas: readonly string[] = [],
  ): Promise<void> {
    const app = this.githubApp();
    const { owner, repo } = parseOwnerRepo(repository);
    const token = await this.tokenProvider(installationId, repository);
    const publisher = new CheckPublisher({
      http: this.http,
      sideEffects: this.sideEffects,
      readOnlyChecks: app.readOnlyChecks,
      owner,
      repo,
      pullRequestNumber,
      token,
    });
    const options = previousHeadShas.length > 0 ? { previousHeadShas } : {};
    await publisher.publishForHeadSha(run, headSha, options);
  }
}
