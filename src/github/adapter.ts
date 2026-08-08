import path from "node:path";
import type { GitHubAppConfig, MasweConfig, RunRecord } from "../domain.ts";
import { invalidateStaleEvidence } from "../git-workspace.ts";
import type { RunStore } from "../store.ts";
import { GitHubAssociationIndex } from "./association.ts";
import { CheckPublisher, type GitHubHttpClient } from "./checks.ts";
import { GitHubDeliveryStore } from "./delivery-store.ts";
import { normalizeGitHubWebhook } from "./normalize.ts";
import { verifyGitHubWebhookSignature } from "./signature.ts";
import { GitHubSideEffectStore } from "./side-effect-store.ts";
import type { GitHubInternalEvent } from "./types.ts";

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

export class GitHubAppAdapter {
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly store: RunStore;
  private readonly http: GitHubHttpClient;
  private readonly tokenProvider: (installationId: number) => Promise<string>;
  private readonly deliveries: GitHubDeliveryStore;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly associations: GitHubAssociationIndex;

  constructor(options: {
    cwd: string;
    config: MasweConfig;
    store: RunStore;
    http: GitHubHttpClient;
    tokenProvider: (installationId: number) => Promise<string>;
  }) {
    this.cwd = options.cwd;
    this.config = options.config;
    this.store = options.store;
    this.http = options.http;
    this.tokenProvider = options.tokenProvider;
    const root = githubRoot(options.cwd);
    this.deliveries = new GitHubDeliveryStore(root);
    this.sideEffects = new GitHubSideEffectStore(root);
    this.associations = new GitHubAssociationIndex(root);
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
    const app = this.githubApp();
    if (!request.deliveryId?.trim() || !request.eventName?.trim()) {
      return { status: 400, body: { ok: false, message: "missing delivery or event headers" } };
    }
    if (!verifyGitHubWebhookSignature(this.webhookSecret(), request.rawBody, request.signatureHeader)) {
      return { status: 401, body: { ok: false, message: "invalid signature" } };
    }

    const claim = await this.deliveries.claim(request.deliveryId);
    if (claim.duplicate) {
      return { status: 200, body: { ok: true, duplicate: true } };
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(request.rawBody) as Record<string, unknown>;
    } catch {
      return { status: 400, body: { ok: false, message: "invalid JSON body" } };
    }

    const event = normalizeGitHubWebhook({
      deliveryId: request.deliveryId,
      eventName: request.eventName,
      payload,
    });

    await this.dispatch(event, app);
    return { status: 200, body: { ok: true } };
  }

  async publishChecksForRun(runId: string): Promise<RunRecord> {
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
    await this.publishChecks(run, run.github.repository, run.github.pullRequestNumber, headSha);
    return run;
  }

  private async dispatch(event: GitHubInternalEvent, app: GitHubAppConfig): Promise<void> {
    if (event.type === "installation.deleted") {
      if (event.installationId !== undefined) {
        await this.associations.suspendInstallation(event.installationId);
      }
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
      await this.handlePullRequestEvent(event, app);
    }
  }

  private async handlePullRequestEvent(
    event: GitHubInternalEvent,
    app: GitHubAppConfig,
  ): Promise<void> {
    const repository = event.repository!;
    const pullRequestNumber = event.pullRequestNumber!;
    const headSha = event.headSha!;
    const installationId = event.installationId ?? 0;

    let association = await this.associations.find(repository, pullRequestNumber);
    if (association?.suspended) {
      return;
    }

    let run: RunRecord | undefined;
    if (association) {
      run = await this.store.load(association.runId);
    } else {
      run = await this.findMatchingRun(repository, event.branch);
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
      const previousHeadSha = run.github?.headSha ?? association?.headSha;
      if (invalidateStaleEvidence(run, headSha)) {
        // Evidence cleared for the new event SHA.
      }
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
      if (association) {
        await this.associations.bind({
          runId: run.id,
          installationId,
          repository,
          pullRequestNumber,
          baseSha: run.github.baseSha,
          headSha,
          branch: run.github.branch,
        });
      }
      await this.publishChecks(run, repository, pullRequestNumber, headSha, previousHeadSha);
      return;
    }

    // Unassociated PR: still publish neutral checks so plumbing is visible.
    const synthetic = {
      schemaVersion: 1 as const,
      version: 1,
      id: "unassociated",
      title: "unassociated",
      request: "",
      repositoryPath: this.cwd,
      state: "PR_REVIEW" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      approvals: { brainstorm: false, design: false },
      counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
      config: this.config,
      artifacts: [],
      events: [],
    };
    void app;
    await this.publishChecks(synthetic, repository, pullRequestNumber, headSha);
  }

  private async findMatchingRun(
    repository: string,
    branch: string | undefined,
  ): Promise<RunRecord | undefined> {
    const runs = await this.store.list();
    const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED"]);
    for (const run of runs) {
      if (terminal.has(run.state)) continue;
      if (run.github?.repository === repository && !run.github.suspended) {
        return run;
      }
      if (branch && run.workspace?.branch === branch) {
        return run;
      }
      const remote = run.workspace?.remote ?? "";
      if (remote.includes(repository) || remote.endsWith(`${repository}.git`)) {
        if (!branch || run.workspace?.branch === branch) return run;
      }
    }
    return undefined;
  }

  private async publishChecks(
    run: RunRecord,
    repository: string,
    pullRequestNumber: number,
    headSha: string,
    previousHeadSha?: string,
  ): Promise<void> {
    const app = this.githubApp();
    const { owner, repo } = parseOwnerRepo(repository);
    const installationId = run.github?.installationId;
    const token =
      installationId !== undefined && installationId > 0
        ? await this.tokenProvider(installationId)
        : "unassociated-token";
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
