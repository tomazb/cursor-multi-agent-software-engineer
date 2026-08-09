import type { GitHubInternalEvent, GitHubInternalEventType } from "./types.ts";

export interface NormalizeInput {
  deliveryId: string;
  eventName: string;
  payload: Record<string, unknown>;
  receivedAt?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function installationId(payload: Record<string, unknown>): number | undefined {
  const installation = asRecord(payload.installation);
  return typeof installation?.id === "number" ? installation.id : undefined;
}

function repositoryFullName(payload: Record<string, unknown>): string | undefined {
  const repository = asRecord(payload.repository);
  return typeof repository?.full_name === "string" ? repository.full_name : undefined;
}

function withOptional(
  base: GitHubInternalEvent,
  extras: {
    repository?: string | undefined;
    repositories?: string[] | undefined;
    installationId?: number | undefined;
    pullRequestNumber?: number | undefined;
    headSha?: string | undefined;
    baseSha?: string | undefined;
    branch?: string | undefined;
    observeOnly?: boolean | undefined;
    rawAction?: string | undefined;
  },
): GitHubInternalEvent {
  const event: GitHubInternalEvent = { ...base };
  if (extras.repository !== undefined) event.repository = extras.repository;
  if (extras.repositories !== undefined) event.repositories = extras.repositories;
  if (extras.installationId !== undefined) event.installationId = extras.installationId;
  if (extras.pullRequestNumber !== undefined) {
    event.pullRequestNumber = extras.pullRequestNumber;
  }
  if (extras.headSha !== undefined) event.headSha = extras.headSha;
  if (extras.baseSha !== undefined) event.baseSha = extras.baseSha;
  if (extras.branch !== undefined) event.branch = extras.branch;
  if (extras.observeOnly !== undefined) event.observeOnly = extras.observeOnly;
  if (extras.rawAction !== undefined) event.rawAction = extras.rawAction;
  return event;
}

const PR_ACTIONS = new Set([
  "opened",
  "synchronize",
  "reopened",
  "ready_for_review",
  "closed",
]);

export function normalizeGitHubWebhook(input: NormalizeInput): GitHubInternalEvent {
  if (!input.deliveryId?.trim()) {
    throw new Error("deliveryId is required");
  }
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const payload = input.payload ?? {};
  const action = typeof payload.action === "string" ? payload.action : undefined;

  if (input.eventName === "pull_request") {
    if (!action || !PR_ACTIONS.has(action)) {
      throw new Error(`Unsupported pull_request action: ${String(action)}`);
    }
    const pr = asRecord(payload.pull_request);
    const head = asRecord(pr?.head);
    const base = asRecord(pr?.base);
    const type = `pull_request.${action}` as GitHubInternalEventType;
    return withOptional(
      { eventId: input.deliveryId, type, receivedAt },
      {
        repository: repositoryFullName(payload),
        installationId: installationId(payload),
        pullRequestNumber: typeof pr?.number === "number" ? pr.number : undefined,
        headSha: typeof head?.sha === "string" ? head.sha : undefined,
        baseSha: typeof base?.sha === "string" ? base.sha : undefined,
        branch: typeof head?.ref === "string" ? head.ref : undefined,
        rawAction: action,
      },
    );
  }

  if (input.eventName === "push") {
    const ref = typeof payload.ref === "string" ? payload.ref : undefined;
    const branch = ref?.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined;
    return withOptional(
      { eventId: input.deliveryId, type: "push", receivedAt },
      {
        repository: repositoryFullName(payload),
        installationId: installationId(payload),
        headSha: typeof payload.after === "string" ? payload.after : undefined,
        branch,
      },
    );
  }

  if (input.eventName === "installation") {
    if (action !== "created" && action !== "deleted") {
      throw new Error(`Unsupported installation action: ${String(action)}`);
    }
    return withOptional(
      {
        eventId: input.deliveryId,
        type: action === "created" ? "installation.created" : "installation.deleted",
        receivedAt,
      },
      {
        installationId: installationId(payload),
        rawAction: action,
      },
    );
  }

  if (input.eventName === "installation_repositories") {
    if (action !== "added" && action !== "removed") {
      throw new Error(`Unsupported installation_repositories action: ${String(action)}`);
    }
    const listKey = action === "removed" ? "repositories_removed" : "repositories_added";
    const listed = Array.isArray(payload[listKey]) ? (payload[listKey] as unknown[]) : [];
    const repositories = listed
      .map((item) => asRecord(item)?.full_name)
      .filter((name): name is string => typeof name === "string" && name.includes("/"));
    return withOptional(
      {
        eventId: input.deliveryId,
        type:
          action === "added"
            ? "installation_repositories.added"
            : "installation_repositories.removed",
        receivedAt,
      },
      {
        installationId: installationId(payload),
        repository: repositories[0] ?? repositoryFullName(payload),
        repositories,
        rawAction: action,
      },
    );
  }

  if (input.eventName === "workflow_run") {
    const run = asRecord(payload.workflow_run);
    return withOptional(
      { eventId: input.deliveryId, type: "workflow_run.completed", receivedAt },
      {
        repository: repositoryFullName(payload),
        installationId: installationId(payload),
        headSha: typeof run?.head_sha === "string" ? run.head_sha : undefined,
        observeOnly: true,
        rawAction: action,
      },
    );
  }

  if (input.eventName === "check_run") {
    const checkRun = asRecord(payload.check_run);
    const suite = asRecord(checkRun?.check_suite);
    const headSha =
      typeof suite?.head_sha === "string"
        ? suite.head_sha
        : typeof checkRun?.head_sha === "string"
          ? checkRun.head_sha
          : undefined;
    return withOptional(
      { eventId: input.deliveryId, type: "check_run.completed", receivedAt },
      {
        repository: repositoryFullName(payload),
        installationId: installationId(payload),
        headSha,
        observeOnly: true,
        rawAction: action,
      },
    );
  }

  if (input.eventName === "check_suite") {
    const suite = asRecord(payload.check_suite);
    return withOptional(
      { eventId: input.deliveryId, type: "check_suite.completed", receivedAt },
      {
        repository: repositoryFullName(payload),
        installationId: installationId(payload),
        headSha: typeof suite?.head_sha === "string" ? suite.head_sha : undefined,
        observeOnly: true,
        rawAction: action,
      },
    );
  }

  throw new Error(`Unsupported GitHub webhook event: ${input.eventName}`);
}
