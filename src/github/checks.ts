import type { RunRecord } from "../domain.ts";
import type { GitHubSideEffectStore } from "./side-effect-store.ts";
import { MASWE_CHECK_NAMES, type MasweCheckName } from "./types.ts";

export type CheckConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "timed_out"
  | "action_required";

export interface CheckOutcome {
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

export type WriteSideEffectKind = "checks" | "push" | "pull_request_write" | "comment_reply";

export function assertReadOnlyChecksMode(
  readOnlyChecks: boolean,
  kind: WriteSideEffectKind,
): void {
  if (!readOnlyChecks) return;
  if (kind === "checks") return;
  throw new Error(
    `GitHub App is in read-only check mode; refusing side effect kind '${kind}'`,
  );
}

export interface GitHubHttpClient {
  request(
    method: string,
    url: string,
    options?: { headers?: Record<string, string>; body?: unknown },
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }>;
}

function hasApprovedSpecArtifacts(run: RunRecord): boolean {
  if (!run.approvals.brainstorm || !run.approvals.design) return false;
  const logical = new Set(run.artifacts.map((a) => a.logicalName));
  return logical.has("02-brainstorm.md") && logical.has("03-design.md");
}

export function buildCheckConclusions(
  run: RunRecord,
  headSha: string,
): Record<MasweCheckName, CheckOutcome> {
  const quality = run.evidence?.quality;
  const verification = run.evidence?.verification;

  return {
    "MASWE / specification compliance": hasApprovedSpecArtifacts(run)
      ? {
          conclusion: "success",
          title: "Specification approved",
          summary: `Brainstorm and design approvals present for run ${run.id}.`,
        }
      : {
          conclusion: "action_required",
          title: "Specification incomplete",
          summary: "Approved brainstorm/design artifacts are required before specification compliance succeeds.",
        },
    "MASWE / deterministic quality":
      quality?.passed && quality.headSha === headSha
        ? {
            conclusion: "success",
            title: "Quality passed",
            summary: `Deterministic quality passed for head SHA ${headSha}.`,
          }
        : {
            conclusion: "neutral",
            title: "Quality not bound to this SHA",
            summary:
              quality?.headSha && quality.headSha !== headSha
                ? `Quality evidence is for ${quality.headSha}, not ${headSha}.`
                : `No passing quality evidence for head SHA ${headSha}.`,
          },
    "MASWE / independent verification":
      verification?.passed && verification.headSha === headSha
        ? {
            conclusion: "success",
            title: "Verification passed",
            summary: `Independent verification passed for head SHA ${headSha}.`,
          }
        : {
            conclusion: "neutral",
            title: "Verification not bound to this SHA",
            summary:
              verification?.headSha && verification.headSha !== headSha
                ? `Verification evidence is for ${verification.headSha}, not ${headSha}.`
                : `No passing verification evidence for head SHA ${headSha}.`,
          },
    "MASWE / review comments resolved": {
      conclusion: "neutral",
      title: "Review resolution deferred",
      summary: "Phase A read-only pilot does not resolve review comments yet.",
    },
  };
}

function idempotencyKey(
  owner: string,
  repo: string,
  pullRequestNumber: number,
  headSha: string,
  checkName: string,
  attempt: number,
): string {
  return `check-run:${owner}/${repo}/${pullRequestNumber}/${headSha}/${checkName}/${attempt}`;
}

function isRateLimited(status: number, headers: Record<string, string>, body: unknown): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  const remaining = headers["x-ratelimit-remaining"] ?? headers["X-RateLimit-Remaining"];
  if (remaining === "0") return true;
  const message =
    body && typeof body === "object" && "message" in body
      ? String((body as { message: unknown }).message)
      : "";
  return /rate limit/i.test(message);
}

export class CheckPublisher {
  private readonly http: GitHubHttpClient;
  private readonly sideEffects: GitHubSideEffectStore;
  private readonly readOnlyChecks: boolean;
  private readonly owner: string;
  private readonly repo: string;
  private readonly pullRequestNumber: number;
  private readonly token: string;
  private readonly attempt: number;

  constructor(options: {
    http: GitHubHttpClient;
    sideEffects: GitHubSideEffectStore;
    readOnlyChecks: boolean;
    owner: string;
    repo: string;
    pullRequestNumber: number;
    token: string;
    attempt?: number;
  }) {
    this.http = options.http;
    this.sideEffects = options.sideEffects;
    this.readOnlyChecks = options.readOnlyChecks;
    this.owner = options.owner;
    this.repo = options.repo;
    this.pullRequestNumber = options.pullRequestNumber;
    this.token = options.token;
    this.attempt = options.attempt ?? 1;
  }

  async publishForHeadSha(
    run: RunRecord,
    headSha: string,
    options: { previousHeadSha?: string } = {},
  ): Promise<{ createdOrUpdated: string[] }> {
    assertReadOnlyChecksMode(this.readOnlyChecks, "checks");
    if (options.previousHeadSha && options.previousHeadSha !== headSha) {
      await this.invalidatePreviousSha(options.previousHeadSha);
    }

    const conclusions = buildCheckConclusions(run, headSha);
    const createdOrUpdated: string[] = [];
    for (const name of MASWE_CHECK_NAMES) {
      await this.upsertCheck(name, headSha, conclusions[name]);
      createdOrUpdated.push(name);
    }
    return { createdOrUpdated };
  }

  private async invalidatePreviousSha(previousHeadSha: string): Promise<void> {
    for (const name of MASWE_CHECK_NAMES) {
      const key = idempotencyKey(
        this.owner,
        this.repo,
        this.pullRequestNumber,
        previousHeadSha,
        name,
        this.attempt,
      );
      const existing = await this.sideEffects.get(key);
      if (!existing) continue;
      await this.patchCheck(existing.resourceId, previousHeadSha, {
        conclusion: "cancelled",
        title: "Superseded by newer head SHA",
        summary: `Invalidated because a newer head SHA was evaluated for PR #${this.pullRequestNumber}.`,
      });
    }
  }

  private async upsertCheck(
    name: MasweCheckName,
    headSha: string,
    outcome: CheckOutcome,
  ): Promise<void> {
    const key = idempotencyKey(
      this.owner,
      this.repo,
      this.pullRequestNumber,
      headSha,
      name,
      this.attempt,
    );
    const existing = await this.sideEffects.get(key);
    if (existing) {
      await this.patchCheck(existing.resourceId, headSha, outcome);
      return;
    }

    const response = await this.http.request(
      "POST",
      `https://api.github.com/repos/${this.owner}/${this.repo}/check-runs`,
      {
        headers: this.headers(),
        body: {
          name,
          head_sha: headSha,
          status: "completed",
          conclusion: outcome.conclusion,
          output: { title: outcome.title, summary: outcome.summary },
        },
      },
    );
    this.assertOk(response.status, response.headers, response.body);
    const id = (response.body as { id?: number }).id;
    if (typeof id !== "number") {
      throw new Error("GitHub check-run response missing id");
    }
    await this.sideEffects.put(key, { resourceId: id, kind: "check-run" });
  }

  private async patchCheck(
    checkRunId: number,
    headSha: string,
    outcome: CheckOutcome,
  ): Promise<void> {
    const response = await this.http.request(
      "PATCH",
      `https://api.github.com/repos/${this.owner}/${this.repo}/check-runs/${checkRunId}`,
      {
        headers: this.headers(),
        body: {
          head_sha: headSha,
          status: "completed",
          conclusion: outcome.conclusion,
          output: { title: outcome.title, summary: outcome.summary },
        },
      },
    );
    this.assertOk(response.status, response.headers, response.body);
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "maswe-github-app",
      "content-type": "application/json",
    };
  }

  private assertOk(
    status: number,
    headers: Record<string, string>,
    body: unknown,
  ): void {
    if (isRateLimited(status, headers, body)) {
      throw new Error("GitHub API rate limit exceeded");
    }
    if (status < 200 || status >= 300) {
      throw new Error(`GitHub Checks API request failed: HTTP ${status}`);
    }
  }
}
