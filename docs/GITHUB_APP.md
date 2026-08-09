# GitHub App design

This document specifies the GitHub App integration. **Phase A (read-only checks)** is implemented in the single-package tree under `src/github/` (issue #3). The `apps/` / `packages/` layout below remains the **target** for the v0.4 control-plane split and is not required to run the Phase A pilot.

## Phase A status (implemented)

- CLI: `maswe github-webhook`, `maswe github-publish-checks <run-id>`
- Modules: `src/github/` (signature verify, delivery dedupe, normalize, association index, installation token helper, check publisher, adapter, webhook server)
- File-backed state under `.maswe/github/` (deliveries, side-effect idempotency keys, associations)
- Config: optional `githubApp` with `readOnlyChecks: true` required when enabled
- Check names: specification compliance, deterministic quality, independent verification, review comments resolved (always `neutral` in Phase A)
- Non-goals still deferred (Phase B / later): push, PR create/update, comment replies, digest-bound GitHub approvals, Actions artifact ingestion, Postgres control plane

## Objectives

- Turn GitHub issues, pull requests, reviews, comments, pushes, and check results into authenticated workflow events.
- Publish transparent check runs bound to the current head SHA.
- Resolve only in-scope review comments after deterministic CI and fresh verification.
- Use least-privilege installation tokens and idempotent side effects.
- Keep GitHub-specific code outside the orchestration core.

## Proposed components (v0.4+ target layout)

```text
apps/github-app/          # future extraction from src/github/
  webhook HTTP endpoint
  signature verification
  event normalization
  authorization
  delivery deduplication
  check-run publisher
  review reply/thread adapter

apps/control-plane/       # ROADMAP v0.4
  workflow API
  durable queue/workers
  PostgreSQL store
  artifact object store
  runtime adapters

packages/github/          # future shared library extraction
  typed GitHub event contracts
  installation-token client
  idempotent operations
```

Phase A equivalent paths today:

```text
src/github/
  webhook-server.ts
  signature.ts
  normalize.ts
  delivery-store.ts / side-effect-store.ts / association.ts
  checks.ts
  token.ts
  adapter.ts
```

## Repository permissions

Start with the minimum needed:

| Permission | Access | Purpose |
|---|---|---|
| Metadata | Read | Required by GitHub Apps |
| Contents | Read and write | Read repository and push a feature branch through deterministic publishing |
| Pull requests | Read and write | Read PR state, post replies, update branch metadata |
| Issues | Read and write | Optional issue intake and approval labels/comments |
| Checks | Read and write | Create and update MASWE check runs |
| Actions | Read | Observe workflow completion and artifacts |
| Commit statuses | Read | Consume existing CI status when needed |

Avoid administration, secrets, environments, deployments, and organization permissions in the initial release.

## Webhook events

Subscribe to:

- `pull_request`: opened, synchronize, reopened, closed, ready_for_review, converted_to_draft.
- `pull_request_review`: submitted, edited, dismissed.
- `pull_request_review_comment`: created, edited, deleted.
- `pull_request_review_thread`: resolved, unresolved where available.
- `issue_comment`: created for command/approval comments on PRs and issues.
- `push`: invalidate evidence on branch updates not represented by PR synchronize handling.
- `check_run` and `check_suite`: consume external CI results.
- `workflow_run`: consume GitHub Actions terminal status and artifacts when configured.
- `installation` and `installation_repositories`: maintain tenancy and repository access.

## Authentication and replay protection

1. Verify `X-Hub-Signature-256` against the raw request body.
2. Read `X-GitHub-Delivery` and store it under a unique constraint.
3. Reject timestamps outside an operational replay window where applicable.
4. Normalize the payload into an internal event before business logic.
5. Acquire an installation token only for the repository handling the event.
6. Record external request and response IDs without storing tokens.

## Internal event example

```json
{
  "eventId": "github-delivery-id",
  "type": "review_comment.created",
  "repository": "owner/repo",
  "installationId": 12345,
  "pullRequestNumber": 42,
  "headSha": "abc123",
  "commentId": 98765,
  "threadId": "PRRT_...",
  "author": "reviewer",
  "body": "Please cover the expired token case.",
  "receivedAt": "2026-07-22T12:00:00Z"
}
```

The review body is untrusted and never becomes a command.

## Check runs

Publish independent checks:

```text
MASWE / specification compliance
MASWE / deterministic quality
MASWE / independent verification
MASWE / review comments resolved
```

Every check run includes:

- Repository and PR.
- Head SHA.
- Run and attempt IDs.
- Requested and actual model when known.
- Links to approved artifacts.
- Summary of acceptance criteria and blocking findings.
- Conclusion: success, failure, neutral, cancelled, timed_out, or action_required.

A new head SHA invalidates all previous success conclusions. The app creates or updates checks only for the SHA that was actually evaluated.

## Approval model

Initial options, in increasing assurance:

1. Maintainer runs local `maswe approve` command.
2. Authorized user adds a configured label.
3. Authorized user comments `/maswe approve brainstorm <artifact-digest>`.
4. Web dashboard approval tied to GitHub identity and artifact digest.

Production should authorize users through repository permission or a configured team. The approval record must include actor, timestamp, artifact digest, and source event ID.

## Branch and worktree policy

- Use a dedicated branch `maswe/<run-id>-<slug>`.
- Builder executes in an isolated clone or worktree.
- Deterministic code, not the model, creates commits and pushes.
- Before push, verify the branch base and no disallowed files changed.
- Use optimistic checks to prevent overwriting reviewer or developer commits.
- On PR synchronize, determine whether the change came from MASWE or an external actor and invalidate/replan accordingly.

## Review-comment lifecycle

```mermaid
sequenceDiagram
  participant GH as GitHub
  participant App as GitHub App
  participant O as Orchestrator
  participant C as Classifier
  participant R as Resolver
  participant CI as CI
  participant V as Verifier

  GH->>App: review comment webhook
  App->>O: authenticated normalized event
  O->>C: read-only scope classification
  alt out of scope or ambiguous
    O->>GH: check action_required + explanatory reply
  else in scope
    O->>R: minimal edit in isolated branch
    R-->>O: resolution report
    O->>CI: deterministic checks for head SHA
    CI-->>O: pass/fail
    O->>V: fresh read-only verification
    V-->>O: verdict for head SHA
    O->>GH: reply with commit and evidence
    O->>GH: resolve thread only after policy pass
  end
```

## Idempotency

Each side effect has a stable key:

```text
check-run: repository/pr/head-sha/check-name/attempt
comment-reply: review-comment-id/resolution-attempt
branch-push: run-id/source-sha/artifact-digest
thread-resolution: thread-id/verified-head-sha
```

Store the key and resulting GitHub resource ID transactionally before acknowledging completion. Retries reuse or reconcile the existing resource.

## Failure behavior

- Signature or authorization failure: reject without workflow changes.
- Duplicate delivery: return success without repeating side effects. Only `completed` deliveries are terminal; stale `processing` claims (crash mid-handler) become reclaimable after a TTL so GitHub retries are not stuck as permanent duplicates. Each claim carries a lease nonce; `complete` writes attempt-scoped `.staging.<id>` before moving processing aside, publishes the canonical record via temp+`link` (never a truncated `wx` create), and recovers any mid-complete crash — including staging-before-move and truncated canonical — without discarding valid staging/reclaim copies. Mismatch restore uses exclusive install only (never POSIX rename-over). Rejected completion surfaces as a handler error (not HTTP 200).
- GitHub rate limit: retry according to reset and backoff headers.
- Stale head SHA: cancel current attempt and restart classification/verification for the new SHA. Live-head lookup failures fail closed (do not apply the event SHA).
- Exact PR identity: association matches only `github.com` remotes over HTTPS or SSH (`git@` / `ssh://git@…/`); plain HTTP and non-GitHub hosts are rejected.
- Concurrent check creates and association mutations use mkdir directory locks so a live owner never exposes an absence window; reclaim requires ESRCH and unchanged `owner.json` after the death check. Malformed locks are never reclaimed. Delivery CAS artifacts are attempt-scoped to avoid cross-attempt clobbering.
- Association index mutations use the same directory-lock reclaim and identity-bound release rules; age alone never authorizes lock deletion.
- Merge conflict: `WAITING_FOR_HUMAN` or a dedicated reconciliation stage.
- CI failure: builder/resolver correction loop under budget.
- Ambiguous review comment: `WAITING_FOR_HUMAN`.
- Permission change or installation removal: suspend every listed repository (including multi-repo `repositories_removed`) and reconcile run records even when the index was already suspended; run-save errors other than missing runs surface to the handler.

## Rollout plan

1. Read-only GitHub App that posts check summaries but cannot push.
2. Enable branch creation/push for allowlisted repositories.
3. Enable PR comment classification with human-approved resolution.
4. Enable automatic in-scope resolution for low-risk categories.
5. Add thread resolution only after observed reliability targets are met.
6. Add issue-driven intake and approval commands.
