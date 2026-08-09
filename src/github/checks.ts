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
  return (
    logical.has("02-brainstorm.md") && logical.has("03-specification-and-design.md")
  );
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

function externalIdFor(key: string): string {
  // GitHub external_id is free-form; keep it stable and filesystem-safe length.
  return key.length <= 64 ? key : key.slice(0, 64);
}

export function isRateLimited(
  status: number,
  headers: Record<string, string>,
  body: unknown,
): boolean {
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

function rateLimitDelayMs(headers: Record<string, string>, attempt: number): number {
  const retryAfter = headers["retry-after"] ?? headers["Retry-After"];
  if (retryAfter && /^\d+$/.test(retryAfter)) {
    return Math.min(Number(retryAfter) * 1000, 30_000);
  }
  const reset = headers["x-ratelimit-reset"] ?? headers["X-RateLimit-Reset"];
  if (reset && /^\d+$/.test(reset)) {
    const until = Number(reset) * 1000 - Date.now();
    if (until > 0) return Math.min(until, 30_000);
  }
  return Math.min(250 * 2 ** attempt, 5_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private readonly maxRateLimitRetries: number;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: {
    http: GitHubHttpClient;
    sideEffects: GitHubSideEffectStore;
    readOnlyChecks: boolean;
    owner: string;
    repo: string;
    pullRequestNumber: number;
    token: string;
    attempt?: number;
    maxRateLimitRetries?: number;
    sleepFn?: (ms: number) => Promise<void>;
  }) {
    this.http = options.http;
    this.sideEffects = options.sideEffects;
    this.readOnlyChecks = options.readOnlyChecks;
    this.owner = options.owner;
    this.repo = options.repo;
    this.pullRequestNumber = options.pullRequestNumber;
    this.token = options.token;
    this.attempt = options.attempt ?? 1;
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 4;
    this.sleepFn = options.sleepFn ?? sleep;
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
      await this.patchCheck(existing.resourceId, {
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
    await this.sideEffects.withCreateLock(key, async () => {
      const externalId = externalIdFor(key);
      const existing = await this.sideEffects.get(key);
      if (existing) {
        await this.patchCheck(existing.resourceId, outcome);
        return;
      }

      const reconciled = await this.reconcileExistingCheck(name, headSha, externalId);
      if (reconciled !== undefined) {
        await this.sideEffects.put(key, { resourceId: reconciled, kind: "check-run" });
        await this.patchCheck(reconciled, outcome);
        return;
      }

      const response = await this.requestWithRateLimitRetry(
        "POST",
        `https://api.github.com/repos/${this.owner}/${this.repo}/check-runs`,
        {
          name,
          head_sha: headSha,
          external_id: externalId,
          status: "completed",
          conclusion: outcome.conclusion,
          output: { title: outcome.title, summary: outcome.summary },
        },
      );
      const id = (response.body as { id?: number }).id;
      if (typeof id !== "number") {
        const recovered = await this.reconcileExistingCheck(name, headSha, externalId);
        if (recovered === undefined) {
          throw new Error("GitHub check-run response missing id");
        }
        await this.sideEffects.put(key, { resourceId: recovered, kind: "check-run" });
        return;
      }
      await this.sideEffects.put(key, { resourceId: id, kind: "check-run" });
    });
  }

  private async reconcileExistingCheck(
    name: MasweCheckName,
    headSha: string,
    externalId: string,
  ): Promise<number | undefined> {
    const response = await this.requestWithRateLimitRetry(
      "GET",
      `https://api.github.com/repos/${this.owner}/${this.repo}/commits/${encodeURIComponent(headSha)}/check-runs?check_name=${encodeURIComponent(name)}&filter=latest`,
    );
    const checkRuns = (response.body as { check_runs?: Array<{ id?: number; external_id?: string }> })
      .check_runs;
    if (!Array.isArray(checkRuns)) return undefined;
    const match = checkRuns.find((run) => run.external_id === externalId && typeof run.id === "number");
    return match?.id;
  }

  private async patchCheck(checkRunId: number, outcome: CheckOutcome): Promise<void> {
    await this.requestWithRateLimitRetry(
      "PATCH",
      `https://api.github.com/repos/${this.owner}/${this.repo}/check-runs/${checkRunId}`,
      {
        status: "completed",
        conclusion: outcome.conclusion,
        output: { title: outcome.title, summary: outcome.summary },
      },
    );
  }

  private async requestWithRateLimitRetry(
    method: string,
    url: string,
    body?: unknown,
  ): Promise<{ status: number; headers: Record<string, string>; body: unknown }> {
    let lastHeaders: Record<string, string> = {};
    let lastBody: unknown;
    for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt += 1) {
      const response = await this.http.request(method, url, {
        headers: this.headers(),
        ...(body !== undefined ? { body } : {}),
      });
      if (!isRateLimited(response.status, response.headers, response.body)) {
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`GitHub Checks API request failed: HTTP ${response.status}`);
        }
        return response;
      }
      lastHeaders = response.headers;
      lastBody = response.body;
      if (attempt === this.maxRateLimitRetries) break;
      await this.sleepFn(rateLimitDelayMs(response.headers, attempt));
    }
    void lastBody;
    void lastHeaders;
    throw new Error("GitHub API rate limit exceeded");
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "user-agent": "maswe-github-app",
      "content-type": "application/json",
    };
  }
}
