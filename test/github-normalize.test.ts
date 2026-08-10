import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGitHubWebhook } from "../src/github/normalize.ts";
import {
  MalformedGitHubWebhookError,
  UnsupportedGitHubWebhookError,
} from "../src/github/types.ts";

test("normalize pull_request.synchronize into an internal event", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-1",
    eventName: "pull_request",
    payload: {
      action: "synchronize",
      installation: { id: 99 },
      repository: { full_name: "owner/repo" },
      pull_request: {
        number: 7,
        head: { sha: "abc123", ref: "feature" },
        base: { sha: "def456" },
      },
    },
  });
  assert.equal(event.type, "pull_request.synchronize");
  assert.equal(event.eventId, "del-1");
  assert.equal(event.repository, "owner/repo");
  assert.equal(event.installationId, 99);
  assert.equal(event.pullRequestNumber, 7);
  assert.equal(event.headSha, "abc123");
  assert.equal(event.baseSha, "def456");
  assert.equal(event.branch, "feature");
});

test("normalize validates repository shape before canonical case folding", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "case-fold",
    eventName: "pull_request",
    payload: {
      action: "opened",
      installation: { id: 99 },
      repository: { full_name: "Owner/Repo" },
      pull_request: {
        number: 12,
        head: { sha: "head", ref: "feature" },
        base: { sha: "base" },
      },
    },
  });

  assert.equal(event.repository, "owner/repo");
});

test("normalize installation.deleted", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-2",
    eventName: "installation",
    payload: {
      action: "deleted",
      installation: { id: 55 },
    },
  });
  assert.equal(event.type, "installation.deleted");
  assert.equal(event.installationId, 55);
});

test("normalize workflow_run as observe-only", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-3",
    eventName: "workflow_run",
    payload: {
      action: "completed",
      installation: { id: 1 },
      repository: { full_name: "owner/repo" },
      workflow_run: {
        head_sha: "deadbeef",
        conclusion: "success",
        status: "completed",
      },
    },
  });
  assert.equal(event.type, "workflow_run.completed");
  assert.equal(event.headSha, "deadbeef");
  assert.equal(event.observeOnly, true);
});

test("observe-only event families reject every non-completed action as unsupported", () => {
  const cases = [
    { eventName: "workflow_run", action: "requested" },
    { eventName: "workflow_run", action: "in_progress" },
    { eventName: "workflow_run", action: undefined },
    { eventName: "workflow_run", action: "other" },
    { eventName: "check_run", action: "created" },
    { eventName: "check_run", action: "rerequested" },
    { eventName: "check_run", action: "requested_action" },
    { eventName: "check_run", action: undefined },
    { eventName: "check_run", action: "other" },
    { eventName: "check_suite", action: "requested" },
    { eventName: "check_suite", action: "in_progress" },
    { eventName: "check_suite", action: "rerequested" },
    { eventName: "check_suite", action: undefined },
    { eventName: "check_suite", action: "other" },
  ] as const;

  for (const [index, candidate] of cases.entries()) {
    assert.throws(
      () =>
        normalizeGitHubWebhook({
          deliveryId: `del-observe-unsupported-${index}`,
          eventName: candidate.eventName,
          payload:
            candidate.action === undefined ? {} : { action: candidate.action },
        }),
      UnsupportedGitHubWebhookError,
      `${candidate.eventName}:${String(candidate.action)}`,
    );
  }
});

test("normalize rejects unsupported event names", () => {
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-4",
        eventName: "gollum",
        payload: {},
      }),
    UnsupportedGitHubWebhookError,
  );
});

test("normalize distinguishes an unsupported action from a malformed supported payload", () => {
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-unsupported-action",
        eventName: "pull_request",
        payload: {
          action: "labeled",
          installation: { id: 99 },
          repository: { full_name: "owner/repo" },
          pull_request: {
            number: 7,
            head: { sha: "abc123", ref: "feature" },
            base: { sha: "def456" },
          },
        },
      }),
    UnsupportedGitHubWebhookError,
  );

  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-malformed",
        eventName: "pull_request",
        payload: { action: "synchronize" },
      }),
    MalformedGitHubWebhookError,
  );
});

test("normalize installation_repositories.removed keeps all canonical repositories", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-5",
    eventName: "installation_repositories",
    payload: {
      action: "removed",
      installation: { id: 7 },
      repositories_removed: [
        { full_name: "Owner/One" },
        { full_name: "OWNER/Two" },
      ],
    },
  });
  assert.equal(event.type, "installation_repositories.removed");
  assert.deepEqual(event.repositories, ["owner/one", "owner/two"]);
  assert.equal(event.repository, "owner/one");
});
