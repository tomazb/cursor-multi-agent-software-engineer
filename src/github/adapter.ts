import path from "node:path";
import type { GitHubAppConfig, MasweConfig, RunRecord } from "../domain.ts";
import { invalidateStaleEvidence } from "../git-workspace.ts";
import type { RunStore } from "../store.ts";
import { GitHubAssociationIndex } from "./association.ts";
import { CheckPublisher, type GitHubHttpClient } from "./checks.ts";
import {
  GitHubDeliveryStore,
  type DeliveryMutationResult,
  type DeliveryStoreMonitor,
} from "./delivery-store.ts";
import { normalizeGitHubWebhook } from "./normalize.ts";
import { verifyGitHubWebhookSignature } from "./signature.ts";
import { GitHubSideEffectStore } from "./side-effect-store.ts";
import { initializeGitHubJournals } from "./journal.ts";
import {
  MalformedGitHubWebhookError,
  UnsupportedGitHubWebhookError,
  type GitHubInternalEvent,
} from "./types.ts";

export interface WebhookRequest {
  deliveryId: string;
  eventName: string;
  signatureHeader: string | undefined;
  rawBody: string;
}

export interface WebhookHandleResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; message?: string };
}

function githubRoot(cwd: string): string {
  return path.join(cwd, ".maswe", "github");
}

function parseOwnerRepo(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository: ${repository}`);
  return { owner, repo };
}

function isRepoAllowed(config: GitHubAppConfig, repository: string | undefined): boolean {
  if (!repository) return false;
  return config.allowedRepositories.includes(repository);
}

function deliveryMutationRejected(
  operation: "completion" | "failure",
  deliveryId: string,
  result: Exclude<DeliveryMutationResult, { ok: true }>,
): Error {
  return new Error(
    `Delivery ${operation} rejected for ${deliveryId}: ${result.reason}`,
  );
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function preservePrimaryError(primary: unknown, cleanup: unknown): Error {
  const primaryError = asError(primary);
  const cleanupError = asError(cleanup);
  try {
    Object.defineProperty(primaryError, "deliveryCleanupError", {
      configurable: true,
      enumerable: false,
      value: cleanupError,
    });
    if (primaryError.cause === undefined) {
      Object.defineProperty(primaryError, "cause", {
        configurable: true,
        enumerable: false,
        value: cleanupError,
      });
    }
    return primaryError;
  } catch {
    return new AggregateError(
      [primaryError, cleanupError],
      primaryError.message,
      { cause: primaryError },
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Match only github.com remotes (HTTPS or SSH) to owner/repo. Plain HTTP is rejected. */
export function remoteMatchesRepository(
  remote: string | undefined,
  repository: string,
): boolean {
  if (!remote) return false;
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) {
    return `${https[1]}/${https[2]}`.toLowerCase() === repository.toLowerCase();
  }
  const sshScp = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshScp) {
    return `${sshScp[1]}/${sshScp[2]}`.toLowerCase() === repository.toLowerCase();
  }
  const sshUrl = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (sshUrl) {
    return `${sshUrl[1]}/${sshUrl[2]}`.toLowerCase() === repository.toLowerCase();
  }
  return false;
}

export class GitHubAppAdapter {
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly store: RunStore;
  private readonly http: GitHubHttpClient;
  private readonly tokenProvider: (
    installationId: number,
    repository: string,
  ) => Promise<string>;
  private readonly deliveries: GitHubDeliveryStore;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly associations: GitHubAssociationIndex;
  private readonly root: string;
  private initialization: Promise<void> | undefined;

  constructor(options: {
    cwd: string;
    config: MasweConfig;
    store: RunStore;
    http: GitHubHttpClient;
    tokenProvider: (installationId: number, repository: string) => Promise<string>;
    deliveryMonitor?: DeliveryStoreMonitor;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.http = options.http;
    this.tokenProvider = options.tokenProvider;
    const root = githubRoot(options.cwd);
    this.root = root;
    this.deliveries = new GitHubDeliveryStore(root, options.deliveryMonitor);
    this.sideEffects = new GitHubSideEffectStore(root);
    this.associations = new GitHubAssociationIndex(root);
  }

  /** Fail-closed filesystem/journal preflight shared by webhook and manual publication. */
  async initialize(): Promise<void> {
    this.initialization ??= initializeGitHubJournals(this.root);
    try {
      await this.initialization;
    } catch (error) {
      this.initialization = undefined;
      throw error;
    }
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
    if (!secret) throw new Error(`Missing webhook secret env ${envName}`);
    return secret;
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookHandleResult> {
    await this.initialize();
    const app = this.githubApp();
    if (!request.deliveryId?.trim() || !request.eventName?.trim()) {
      return { status: 400, body: { ok: false, message: "missing delivery or event headers" } };
    }
    if (!verifyGitHubWebhookSignature(this.webhookSecret(), request.rawBody, request.signatureHeader)) {
      return { status: 401, body: { ok: false, message: "invalid signature" } };
    }

    const claim = await this.deliveries.claim(request.deliveryId);
    if (claim.duplicate && claim.status === "completed") {
      return { status: 200, body: { ok: true, duplicate: true } };
    }
    if (claim.duplicate && claim.status === "processing") {
      return {
        status: 503,
        body: { ok: false, duplicate: true, message: "delivery already processing" },
      };
    }
    if (!claim.claimed || !claim.leaseId) {
      throw new Error(`Delivery claim returned an invalid state for ${request.deliveryId}`);
    }
    const leaseId = claim.leaseId;

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody) as unknown;
    } catch {
      const malformed = new MalformedGitHubWebhookError("invalid JSON body");
      await this.failDelivery(request.deliveryId, leaseId, malformed);
      return { status: 400, body: { ok: false, message: malformed.message } };
    }
    if (!isRecord(parsed)) {
      const malformed = new MalformedGitHubWebhookError(
        "webhook payload must be a JSON object",
      );
      await this.failDelivery(request.deliveryId, leaseId, malformed);
      return { status: 400, body: { ok: false, message: malformed.message } };
    }

    let event: GitHubInternalEvent;
    try {
      event = normalizeGitHubWebhook({
        deliveryId: request.deliveryId,
        eventName: request.eventName,
        payload: parsed,
      });
    } catch (error) {
      if (error instanceof UnsupportedGitHubWebhookError) {
        try {
          await this.completeDelivery(request.deliveryId, leaseId);
        } catch (completionError) {
          await this.failDelivery(request.deliveryId, leaseId, completionError);
          throw completionError;
        }
        return { status: 200, body: { ok: true, message: "unsupported webhook ignored" } };
      }
      if (error instanceof MalformedGitHubWebhookError) {
        await this.failDelivery(request.deliveryId, leaseId, error);
        return { status: 400, body: { ok: false, message: error.message } };
      }
      await this.failDelivery(request.deliveryId, leaseId, error);
      throw error;
    }

    try {
      await this.dispatch(event, app);
      await this.completeDelivery(request.deliveryId, leaseId);
      return { status: 200, body: { ok: true } };
    } catch (error) {
      await this.failDelivery(request.deliveryId, leaseId, error);
      throw error;
    }
  }

  private async completeDelivery(deliveryId: string, leaseId: string): Promise<void> {
    const completed = await this.deliveries.complete(deliveryId, leaseId);
    if (!completed.ok) {
      throw deliveryMutationRejected("completion", deliveryId, completed);
    }
  }

  private async failDelivery(
    deliveryId: string,
    leaseId: string,
    primaryError: unknown,
  ): Promise<void> {
    let cleanupError: unknown;
    try {
      const failed = await this.deliveries.fail(
        deliveryId,
        asError(primaryError).message,
        leaseId,
      );
      if (!failed.ok) {
        cleanupError = deliveryMutationRejected("failure", deliveryId, failed);
      }
    } catch (error) {
      cleanupError = error;
    }
    if (cleanupError !== undefined) {
      throw preservePrimaryError(primaryError, cleanupError);
    }
  }

  async publishChecksForRun(runId: string): Promise<RunRecord> {
    await this.initialize();
    const app = this.githubApp();
    const run = await this.store.load(runId);
    if (!run.github) {
      throw new Error(`Run ${runId} has no github association`);
    }
    if (run.github.suspended) {
      throw new Error(`Run ${runId} github association is suspended`);
    }
    if (!isRepoAllowed(app, run.github.repository)) {
      throw new Error(`Repository ${run.github.repository} is not allowlisted`);
    }
    const headSha = run.github.headSha || run.workspace?.headSha;
    if (!headSha) throw new Error(`Run ${runId} has no head SHA for checks`);
    await this.publishChecks(
      run,
      run.github.repository,
      run.github.pullRequestNumber,
      headSha,
      run.github.installationId,
    );
    return run;
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
      if (!run.github || run.github.suspended) continue;
      run.github = { ...run.github, suspended: true };
      await this.store.save(run);
    }
  }

  private async handlePushEvent(event: GitHubInternalEvent): Promise<void> {
    const repository = event.repository!;
    const branch = event.branch!;
    const headSha = event.headSha!;
    const associations = await this.associations.findAllByRepositoryBranch(repository, branch);
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
      await this.handlePullRequestEvent(synthetic);
    }
  }

  private async currentPullRequestHead(
    repository: string,
    pullRequestNumber: number,
    installationId: number,
  ): Promise<string> {
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
    const head = (response.body as { head?: { sha?: string } }).head;
    if (typeof head?.sha !== "string" || !head.sha) {
      throw new Error(
        `Failed to resolve current PR head for ${repository}#${pullRequestNumber}: missing head.sha`,
      );
    }
    return head.sha;
  }

  private async handlePullRequestEvent(event: GitHubInternalEvent): Promise<void> {
    const repository = event.repository!;
    const pullRequestNumber = event.pullRequestNumber!;
    const headSha = event.headSha!;
    const installationId = event.installationId;
    if (installationId === undefined || installationId <= 0) {
      throw new Error("pull_request event missing installation id");
    }

    let association = await this.associations.find(repository, pullRequestNumber);
    if (association?.suspended) {
      return;
    }

    if (association?.headSha && association.headSha !== headSha) {
      const liveHead = await this.currentPullRequestHead(
        repository,
        pullRequestNumber,
        installationId,
      );
      if (liveHead !== headSha) {
        // Stale out-of-order delivery: current PR head has already moved on.
        return;
      }
    }

    let run: RunRecord | undefined;
    if (association) {
      run = await this.store.load(association.runId);
    } else {
      run = await this.findMatchingRun(repository, pullRequestNumber, event.branch);
      if (run) {
        association = await this.associations.bind({
          runId: run.id,
          installationId,
          repository,
          pullRequestNumber,
          baseSha: event.baseSha ?? run.workspace?.baseSha ?? headSha,
          headSha,
          branch: event.branch ?? run.workspace?.branch ?? "unknown",
        });
      }
    }

    if (run) {
      if (run.github?.suspended) return;
      const previousHeadSha = run.github?.headSha ?? association?.headSha;
      invalidateStaleEvidence(run, headSha);
      run.github = {
        installationId,
        repository,
        pullRequestNumber,
        baseSha: event.baseSha ?? run.github?.baseSha ?? run.workspace?.baseSha ?? headSha,
        headSha,
        branch: event.branch ?? run.github?.branch ?? run.workspace?.branch ?? "unknown",
        suspended: false,
      };
      await this.store.save(run);
      await this.associations.bind({
        runId: run.id,
        installationId,
        repository,
        pullRequestNumber,
        baseSha: run.github.baseSha,
        headSha,
        branch: run.github.branch,
      });
      await this.publishChecks(
        run,
        repository,
        pullRequestNumber,
        headSha,
        installationId,
        previousHeadSha,
      );
      return;
    }

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
  }

  private async findMatchingRun(
    repository: string,
    pullRequestNumber: number,
    branch: string | undefined,
  ): Promise<RunRecord | undefined> {
    const runs = await this.store.list();
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);

    // Exact PR association on the run record wins.
    for (const run of runs) {
      if (terminal.has(run.state) || run.github?.suspended) continue;
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
    previousHeadSha?: string,
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
    const options = previousHeadSha && previousHeadSha !== headSha ? { previousHeadSha } : {};
    await publisher.publishForHeadSha(run, headSha, options);
  }
}
