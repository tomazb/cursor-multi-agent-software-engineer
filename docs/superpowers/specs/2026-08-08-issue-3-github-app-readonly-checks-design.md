# Design: Issue #3 Phase A — Read-only GitHub App checks

**Issue:** [GitHub #3](https://github.com/tomazb/cursor-multi-agent-software-engineer/issues/3) (ROADMAP milestone v0.3 Phase A)  
**Date:** 2026-08-08  
**Status:** Approved for implementation

## Problem

v0.2 binds quality, verification, and merge-ready evidence to local git head SHAs, but GitHub never sees those conclusions. Issue #3 requires a GitHub App pilot that connects durable MASWE runs to pull requests and check runs without moving orchestration authority into webhook handlers or models. Shipping the entire milestone (push, PR create, comment replies, GitHub approvals, Actions ingestion) in one PR is too large; `docs/GITHUB_APP.md` already defines a read-only rollout step 1.

## Goals

- Authenticated webhook intake with `X-Hub-Signature-256` verification and `X-GitHub-Delivery` deduplication.
- Normalize GitHub payloads into internal typed events before business logic.
- Associate runs with repository, PR number, branch, base SHA, and head SHA.
- Publish four SHA-bound MASWE check runs from orchestrator evidence (read model).
- Invalidate prior check success when head SHA changes.
- Keep GitHub-specific code outside the orchestration core; adapter calls public `Orchestrator` operations only.
- Support read-only check mode (`readOnlyChecks: true`) that refuses Contents/PR/comment write APIs.
- Support concurrent Phase A processes only on one host and one coherent local filesystem with
  atomic no-clobber hard links.
- Integration tests for replay, forged signature, stale SHA, rate limit, installation/permission loss, and webhook ordering.

## Non-goals (deferred; still issue #3 Phase B)

- Digest-bound comment/label approvals
- Deterministic branch push and PR open/update
- Review comment ingest, evidence replies, thread resolution
- Actions artifact ingestion beyond observe → neutral summary
- PostgreSQL / queue / transactional outbox (v0.4 control plane)
- Monorepo split into `apps/github-app`, `apps/control-plane`, `packages/github` (documented target; deferred)

## Approaches considered

### 1 — Early monorepo (`apps/` + `packages/`)

Matches the proposed layout in `docs/GITHUB_APP.md`. Large structural change before behavior ships. **Rejected for Phase A.**

### 2 — Single-package `src/github/` adapter + webhook entry (chosen)

Keep the existing one-package CLI. Add `src/github/` for verify, dedupe, normalize, tokens, checks, association, and adapter. File-backed `.maswe/github/` for deliveries and idempotency. Extract to `apps/`/`packages/` with the v0.4 control plane. **Chosen.**

### 3 — Library-only stdin processor (no HTTP server)

Easier to host behind any gateway, weaker fit for a real App pilot. **Rejected.**

## Design

### Architecture

```text
GitHub webhook
  -> signature verify (raw body)
  -> delivery journal + lease-fenced ledger claim
  -> normalize to internal event
  -> GitHub adapter
       -> optional Orchestrator public ops (sync/associate; no auto-start)
       -> check publisher (Checks API only when readOnlyChecks)
```

Hard rules:

- Webhook handlers never call `state-machine` / `applyEvent` directly.
- Untrusted payload bodies never become shell commands.
- Quality commands remain trusted config only.
- `readOnlyChecks: true` is required when `githubApp.enabled` in this pilot.
- The webhook server and manual publisher initialize the root association journal and complete its
  hard-link capability probe before accepting work.
- Reusable CAS or `mkdir` ownership pathnames are not ownership identities.

### Package layout

| Path | Responsibility |
|------|----------------|
| `src/github/types.ts` | Internal events, check names, association types |
| `src/github/signature.ts` | Timing-safe HMAC SHA-256 verification |
| `src/github/journal.ts` | Hash-addressed immutable ownership journals and retained-path legacy migration |
| `src/github/delivery-store.ts` | Journal-protected, lease-fenced delivery ledger under `.maswe/github/deliveries/` |
| `src/github/side-effect-store.ts` | Journal-serialized idempotency key → GitHub resource id |
| `src/github/normalize.ts` | Raw payloads → internal events |
| `src/github/token.ts` | Installation JWT + token fetch (injectable HTTP) |
| `src/github/checks.ts` | Create/update four MASWE checks |
| `src/github/adapter.ts` | Event → orchestrator + checks; enforce read-only |
| `src/github/webhook-server.ts` | HTTP listener |
| `src/github/association.ts` | Run ↔ `(repository, pullRequestNumber)` index |

### Webhook events (Phase A)

| Event | Behavior |
|-------|----------|
| `pull_request` opened/synchronize/reopened/ready_for_review | Associate; refresh head SHA; invalidate evidence via existing sync path when a run exists; republish/cancel checks |
| `push` (PR head branch) | Same invalidation when not covered by synchronize |
| `check_run` / `check_suite` / `workflow_run` | Observe only → neutral summaries; no orchestration authority |
| `installation` / `installation_repositories` | Update allowlist; suspend associations on removal |
| Review comments / approval comments | Out of Phase A |

Forged signature → HTTP 401, zero writes. A completed duplicate returns 200 without repeating side
effects; a still-processing duplicate returns retryable HTTP 503.

### Check runs

Exact names:

1. `MASWE / specification compliance`
2. `MASWE / deterministic quality`
3. `MASWE / independent verification`
4. `MASWE / review comments resolved` (always `neutral` in Phase A)

Rules:

- Create/update only for the SHA actually evaluated.
- Success requires matching `run.evidence.*.headSha` (or approvals/artifacts for specification).
- New head SHA invalidates previous success.
- Idempotency key: `check-run:{repo}/{pr}/{headSha}/{checkName}/{attempt}`. `external_id` is the
  full SHA-256 digest of this complete key. Missing local side-effect state is reconciled using
  `filter=all`, `per_page=100`, and bounded pagination before any new create.

### Run association

Optional `RunRecord.github`:

- `installationId`, `repository` (`owner/repo`), `pullRequestNumber`, `baseSha`, `headSha`, `branch`, `suspended?`

Default lookup: non-terminal run matching `(repository, pullRequestNumber)` or branch/remote. If none, publish neutral “no MASWE run associated” checks. Do **not** auto-`start` builds from webhooks in Phase A.

### Persistence (pilot)

Under `.maswe/github/`:

- `deliveries/{deliveryId}.json`
- `side-effects/{idempotencyKey}.json`
- Association index for `(repository, pullRequestNumber)` → `runId`
- Installation allowlist snapshots
- `journals/{association|check-create|delivery}/{sha256(logical-key)}/.lock-journal-v3/` with
  immutable claims, releases, and temporary publication records
- Digest-bound `deliveries/{deliveryId}.json.suppression.*` audit markers that prevent retained
  failed-lease artifacts from suppressing a later retry

File-backed with atomic writes and immutable journal serialization. This is a same-host,
coherent-local-filesystem pilot, not the v0.4 authoritative run store or a distributed lock.
NFS, SMB, distributed FUSE, object-store mounts, and filesystems without atomic no-clobber hard
links are unsupported.

Upgrading from the earlier association/check-create lock formats is quiescent: stop every old
webhook server and manual publisher, start only the new binary, and retain each legacy path after a
digest- or stable-identity-bound migration marker is published. Mixed old/new active binaries are
unsupported.

### Config

```ts
githubApp?: {
  enabled: boolean;
  readOnlyChecks: boolean; // must be true when enabled in Phase A
  webhookSecretEnv: string;
  appIdEnv: string;
  privateKeyEnv: string;
  allowedRepositories: string[]; // empty = deny all
  webhookHost?: string;
  webhookPort?: number;
}
```

Installation tokens are acquired per event and never persisted.

### CLI

- `maswe github-webhook` — HTTP server
- `maswe github-publish-checks <run-id>` — manual mirror for dev/CI

### Failure / acceptance behavior

| Scenario | Behavior |
|----------|----------|
| Replay completed delivery | 200, no duplicate checks/runs |
| Duplicate live processing delivery | 503 so GitHub retries |
| Crash mid-delivery | Stale `processing` claim reclaimable after TTL; retry can complete; expired lease cannot complete/fail successor |
| Unsupported event/action | Complete as intentionally ignored and return 200 |
| Internal supported-event failure | Fail the exact lease, emit local diagnostics, and return generic HTTP 500 |
| Bad signature | 401, no state change |
| Stale SHA | No success for wrong SHA; invalidate evidence |
| Live-head lookup failure | Fail closed; do not store/process the event SHA |
| Non-GitHub / plain HTTP remote | Do not associate |
| Rate limit | Backoff; no false success |
| Concurrent check publishers | Immutable journal serialization per complete key; one POST per check; only ESRCH-proven dead lower owners are releasable |
| Installation removed | Suspend all listed repositories; redelivery reconciles already-suspended index into runs |
| Out-of-order webhooks | Latest head SHA wins when live head is resolved |
| Association mutation | Immutable journal serialization; exact-claim release only |
| GitHub HTTP call | Each token, live-head, Checks API, webhook-triggered, and manual request has a 30-second default deadline; rate-limit retries remain bounded |

### Testing

Mocked GitHub HTTP + file store:

1. Replay delivery → single side-effect record
2. Forged signature → no delivery claim
3. Stale SHA → no success on wrong SHA
4. Rate limit → backoff, idempotent retry
5. Installation removed → every listed repo suspended
6. Ordering SHA₁ then SHA₂ → SHA₁ cannot remain successful
7. Live-head HTTP failure → head unchanged
8. Concurrent publishers → four creates, not eight
9. Non-GitHub remote → no association
10. Stale processing delivery → reclaimable after TTL
11. Live processing duplicate → 503; completed/unsupported delivery → 200
12. Full-digest check identity and bounded multi-page reconciliation

## Commit strategy

1. Spec + plan docs
2. Domain/schema association + github config
3. Signature + delivery store
4. Normalize + association
5. Check publisher + idempotency
6. Adapter + webhook CLI + integration tests
7. Docs/roadmap/changelog + PR

## References

- `docs/GITHUB_APP.md`
- `docs/ROADMAP.md` v0.3
- `docs/adr/0005-deterministic-git-and-github-side-effects.md`
- `docs/ARCHITECTURE.md` §8, §12
