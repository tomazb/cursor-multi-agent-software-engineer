import {
  MalformedGitHubWebhookError,
  UnsupportedGitHubWebhookError,
  type GitHubInternalEvent,
  type GitHubInternalEventType,
} from "./types.ts";

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

function malformed(message: string): never {
  throw new MalformedGitHubWebhookError(message);
}

function requireAction(
  eventName: string,
  action: string | undefined,
  supported: ReadonlySet<string>,
): string {
  if (!action) malformed(`${eventName} action is required`);
  if (!supported.has(action)) {
    throw new UnsupportedGitHubWebhookError(`Unsupported ${eventName} action: ${action}`);
  }
  return action;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    malformed(`${field} must be a positive integer`);
  }
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    malformed(`${field} must be a non-empty string`);
  }
  return value;
}

function requireRepository(payload: Record<string, unknown>): string {
  const repository = requireString(repositoryFullName(payload), "repository.full_name");
  if (!repository.includes("/")) malformed("repository.full_name must use owner/repository form");
  return repository;
}

function requireInstallationId(payload: Record<string, unknown>): number {
  return requirePositiveInteger(installationId(payload), "installation.id");
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
    malformed("deliveryId is required");
  }
  const receivedAt = input.receivedAt ?? new Date().toISOString();
  const payload = input.payload ?? {};
  const action = typeof payload.action === "string" ? payload.action : undefined;

  if (input.eventName === "pull_request") {
    const supportedAction = requireAction("pull_request", action, PR_ACTIONS);
    const pr = asRecord(payload.pull_request);
    if (!pr) malformed("pull_request must be an object");
    const head = asRecord(pr?.head);
    if (!head) malformed("pull_request.head must be an object");
    const base = asRecord(pr?.base);
    if (!base) malformed("pull_request.base must be an object");
    const type = `pull_request.${supportedAction}` as GitHubInternalEventType;
    return withOptional(
      { eventId: input.deliveryId, type, receivedAt },
      {
        repository: requireRepository(payload),
        installationId: requireInstallationId(payload),
        pullRequestNumber: requirePositiveInteger(pr.number, "pull_request.number"),
        headSha: requireString(head.sha, "pull_request.head.sha"),
        baseSha: requireString(base.sha, "pull_request.base.sha"),
        branch: requireString(head.ref, "pull_request.head.ref"),
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "push") {
    const ref = requireString(payload.ref, "ref");
    if (!ref.startsWith("refs/heads/") || ref.length === "refs/heads/".length) {
      malformed("ref must identify a branch");
    }
    const branch = ref.slice("refs/heads/".length);
    return withOptional(
      { eventId: input.deliveryId, type: "push", receivedAt },
      {
        repository: requireRepository(payload),
        installationId: requireInstallationId(payload),
        headSha: requireString(payload.after, "after"),
        branch,
      },
    );
  }

  if (input.eventName === "installation") {
    const supportedAction = requireAction(
      "installation",
      action,
      new Set(["created", "deleted"]),
    );
    return withOptional(
      {
        eventId: input.deliveryId,
        type:
          supportedAction === "created" ? "installation.created" : "installation.deleted",
        receivedAt,
      },
      {
        installationId: requireInstallationId(payload),
        rawAction: supportedAction,
      },
    );
  }

  if (input.eventName === "installation_repositories") {
    const supportedAction = requireAction(
      "installation_repositories",
      action,
      new Set(["added", "removed"]),
    );
    const listKey =
      supportedAction === "removed" ? "repositories_removed" : "repositories_added";
    if (!Array.isArray(payload[listKey])) malformed(`${listKey} must be an array`);
    const listed = payload[listKey] as unknown[];
    const repositories = listed
      .map((item) => asRecord(item)?.full_name)
      .filter((name): name is string => typeof name === "string" && name.includes("/"));
    if (repositories.length !== listed.length) {
      malformed(`${listKey} entries must include full_name`);
    }
    return withOptional(
      {
        eventId: input.deliveryId,
        type:
          supportedAction === "added"
            ? "installation_repositories.added"
            : "installation_repositories.removed",
        receivedAt,
      },
      {
        installationId: requireInstallationId(payload),
        repository: repositories[0] ?? repositoryFullName(payload),
        repositories,
        rawAction: supportedAction,
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

  throw new UnsupportedGitHubWebhookError(
    `Unsupported GitHub webhook event: ${input.eventName}`,
  );
}
