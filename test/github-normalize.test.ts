import assert from "node:assert/strict";
import test from "node:test";
import { normalizeGitHubWebhook } from "../src/github/normalize.ts";

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

test("normalize rejects unsupported event names", () => {
  assert.throws(
    () =>
      normalizeGitHubWebhook({
        deliveryId: "del-4",
        eventName: "gollum",
        payload: {},
      }),
    /unsupported/i,
  );
});

test("normalize installation_repositories.removed keeps all repositories", () => {
  const event = normalizeGitHubWebhook({
    deliveryId: "del-5",
    eventName: "installation_repositories",
    payload: {
      action: "removed",
      installation: { id: 7 },
      repositories_removed: [
        { full_name: "owner/one" },
        { full_name: "owner/two" },
      ],
    },
  });
  assert.equal(event.type, "installation_repositories.removed");
  assert.deepEqual(event.repositories, ["owner/one", "owner/two"]);
  assert.equal(event.repository, "owner/one");
});
