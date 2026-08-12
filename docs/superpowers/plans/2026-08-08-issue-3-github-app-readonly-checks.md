# Issue #3 Phase A: Read-only GitHub App checks — Implementation Plan

> **Historical plan:** This 2026-08-08 proposal is superseded by the [2026-08-09 GitHub App recovery and review hardening plan](2026-08-09-github-app-recovery-and-review-hardening.md). The file map and task checklists below describe the original proposal at that point in time; they are not a statement of current implementation status.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. TDD. Commit after each task.

**Goal:** Ship read-only MASWE check runs bound to exact PR head SHAs via an authenticated webhook adapter that calls public orchestrator operations only.

**Architecture:** Keep the single npm package. Add `src/github/` for signature verification, delivery dedupe, event normalization, installation tokens, check publishing, and the adapter. Webhook CLI entry invokes the adapter; core `src/orchestrator.ts` stays free of Octokit/webhook parsing. File-backed state under `.maswe/github/` (not Postgres). `readOnlyChecks: true` refuses Contents/PR write APIs.

**Tech Stack:** TypeScript ESM, Node `node:test` + `--experimental-strip-types`, Node built-in `http` + `crypto` (prefer no new runtime deps). Mock GitHub HTTP in tests.

**Spec:** `docs/superpowers/specs/2026-08-08-issue-3-github-app-readonly-checks-design.md`

**Spec decisions (locked):** Issue #3 slice B (Phase A only); layout approach 2 (`src/github/`).

## Global Constraints

- Transitions only in `src/state-machine.ts`; GitHub code never authorizes transitions directly
- Untrusted webhook body text never becomes a shell command
- Checks may succeed only for the SHA that was evaluated; new head SHA invalidates prior success
- This PR does **not** implement push, PR create/update, comment replies, digest-bound GitHub approvals, or Postgres control plane
- Every behavior change needs tests + docs; `npm run check` before claiming done
- Node engines unchanged (`>=22.22.2 <23 || >=24.18.0 <25`)

## File map

| Path | Responsibility |
|------|----------------|
| `src/github/types.ts` | Internal event + check name + association types |
| `src/github/signature.ts` | `X-Hub-Signature-256` verify (timing-safe) |
| `src/github/delivery-store.ts` | Atomic claim of `X-GitHub-Delivery` under `.maswe/github/deliveries/` |
| `src/github/side-effect-store.ts` | Idempotency key → GitHub resource id |
| `src/github/normalize.ts` | Raw GitHub payloads → internal events |
| `src/github/token.ts` | Installation JWT + token fetch (injectable HTTP) |
| `src/github/checks.ts` | Create/update four MASWE checks; SHA + idempotency |
| `src/github/adapter.ts` | Map events → orchestrator ops + check mirror; enforce read-only |
| `src/github/webhook-server.ts` | HTTP listener |
| `src/github/association.ts` | Run ↔ `(repo, pr)` index |
| `src/domain.ts` / `schemas/run-record.schema.json` | Optional `github` association on `RunRecord` |
| `src/config.ts` / `schemas/config.schema.json` | `githubApp` config block |
| `src/cli-runner.ts` / `src/cli.ts` | `github-webhook`, `github-publish-checks` |
| `test/github-*.test.ts` | Unit + integration AC coverage |
| Docs | GITHUB_APP, ARCHITECTURE, ROADMAP, SECURITY, ARTIFACT_CONTRACTS, CHANGELOG, README |

## Check names (exact)

- `MASWE / specification compliance`
- `MASWE / deterministic quality`
- `MASWE / independent verification`
- `MASWE / review comments resolved` (always `neutral` in this PR)

---

### Task 0: Design spec + plan docs

- [x] Write approved design to `docs/superpowers/specs/2026-08-08-issue-3-github-app-readonly-checks-design.md`
- [x] Write this plan to `docs/superpowers/plans/2026-08-08-issue-3-github-app-readonly-checks.md`
- [ ] Commit

### Task 1: Domain + config + schemas (TDD)

**Files:** `src/domain.ts`, `src/config.ts`, schemas, examples, `docs/ARTIFACT_CONTRACTS.md`, tests

- [ ] Add optional `RunRecord.github`: `installationId`, `repository`, `pullRequestNumber`, `baseSha`, `headSha`, `branch`, `suspended?`
- [ ] Add `githubApp` config: `enabled`, `readOnlyChecks` (must be true when enabled), env var names, `allowedRepositories`, webhook listen defaults
- [ ] Update schemas, example config, ARTIFACT_CONTRACTS
- [ ] Tests: config assert rejects `readOnlyChecks: false`; association fields round-trip in store
- [ ] Commit

### Task 2: Signature + delivery store (TDD)

**Files:** `src/github/signature.ts`, `src/github/delivery-store.ts`, `test/github-signature.test.ts`, `test/github-delivery-store.test.ts`

- [ ] Failing tests: valid sig accepts; forged rejects; replay of same delivery id is no-op success
- [ ] Implement HMAC SHA-256 verify against raw body; atomic delivery claim files
- [ ] Commit

### Task 3: Normalize + association index (TDD)

**Files:** `src/github/types.ts`, `src/github/normalize.ts`, `src/github/association.ts`, tests

- [ ] Normalize `pull_request`, `push`, `installation*`, observe-only `workflow_run`/`check_*`
- [ ] Association lookup by `(repository, pullRequestNumber)` or branch/remote; suspend on installation removal
- [ ] Commit

### Task 4: Check publisher + side-effect idempotency (TDD)

**Files:** `src/github/checks.ts`, `src/github/side-effect-store.ts`, `src/github/token.ts`, tests

- [ ] Mock GitHub HTTP client
- [ ] Publish/update four checks for exact `headSha`; idempotent retry reuses stored check-run id
- [ ] Stale SHA cannot receive `success`; invalidate on new SHA
- [ ] Rate-limit → backoff without false success
- [ ] `readOnlyChecks` guard throws on push/PR/comment write attempts
- [ ] Commit

### Task 5: Adapter + webhook server + CLI (TDD)

**Files:** `src/github/adapter.ts`, `src/github/webhook-server.ts`, CLI, integration tests

- [ ] Adapter: verify→dedupe→normalize→associate→publish checks; no auto-`start`
- [ ] CLI: `maswe github-webhook`, `maswe github-publish-checks <run-id>`
- [ ] Integration tests: replay, forged sig, stale SHA, rate limit, installation loss, ordering
- [ ] Commit

### Task 6: Docs + changelog + PR

- [ ] Update GITHUB_APP, ARCHITECTURE §8, ROADMAP, SECURITY, README, CHANGELOG
- [ ] `npm run check`
- [ ] Push branch and `gh pr create` linking issue #3; note Phase B remaining

## Explicit follow-ups (not this PR; still issue #3)

- Digest-bound comment/label approvals
- Deterministic push + PR open/update
- Review comment ingest + evidence replies + human-approved resolve
- Actions artifact ingestion beyond observe→neutral
- Monorepo `apps/`/`packages/` split (v0.4 control plane)
