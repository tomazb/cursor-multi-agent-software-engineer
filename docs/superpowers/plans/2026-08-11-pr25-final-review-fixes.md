# PR #25 Final Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the four validated final review findings without changing the GitHub App permission, persistence, or webhook contracts beyond stricter invalid-input rejection.

**Architecture:** Use one shared delivery-ID predicate at every HTTP, adapter, inbox, migration, and record-parsing boundary. Preserve the durable inbox layout and token API while making malformed inputs fail before side effects with stable errors. Preserve the original Phase A plan as a clearly labeled historical artifact.

**Tech Stack:** TypeScript ESM, Node built-ins, `node:test`, exact Node 24.18.0 and 22.22.2.

## Global Constraints

- Write every behavioral regression first and observe the expected RED failure before production edits.
- Delivery IDs remain restricted to `/^[A-Za-z0-9._-]+$/`; do not broaden the wire contract.
- Invalid direct inbox or adapter input must fail before filesystem initialization or writes.
- Do not change GitHub permissions, schemas, persisted fields, state transitions, or runtime dependencies.
- Run `npm run check` separately on exact Node 24.18.0 and exact Node 22.22.2 before completion.

---

### Task 1: Delivery-ID validation at every ingress boundary

**Files:**
- Create: `src/github/delivery-id.ts`
- Modify: `src/github/delivery-inbox.ts`, `src/github/delivery-inbox-record.ts`, `src/github/webhook-request.ts`, `src/github/webhook-server.ts`
- Test: `test/github-inbox-lease.test.ts`, `test/github-durable-ingress.test.ts`, `test/github-webhook-server.test.ts`

**Interfaces:**
- Produce `isSafeGitHubDeliveryId(value: unknown): value is string` with the exact existing grammar.
- `GitHubDeliveryInbox.enqueue()` and `completeWithoutDispatch()` throw `Error("Invalid GitHub delivery id")` before `initialize()` for invalid input.
- Direct adapter/webhook preparation returns HTTP 400 for an unsafe delivery ID without durable mutation.

- [ ] Add direct-inbox and signed-direct-adapter regressions and run them to prove RED.
- [ ] Add the shared predicate and replace duplicated validation at request, server, migration, and record boundaries.
- [ ] Re-run the focused inbox/adapter/server suites to prove GREEN.
- [ ] Commit as `fix: validate GitHub delivery ids at every ingress boundary`.

### Task 2: Installation-token response validation

**Files:**
- Modify: `src/github/token.ts`
- Test: `test/github-token.test.ts`

**Interfaces:**
- Keep `createInstallationAccessToken()` unchanged.
- Null, primitive, array, missing-token, and empty-token 2xx bodies throw `Error("Installation token response missing token")`.

- [ ] Add a table-driven malformed-response regression and run it to prove RED.
- [ ] Validate the response body as a non-null, non-array object before reading `token`.
- [ ] Re-run the token tests to prove GREEN.
- [ ] Commit as `fix: validate installation token responses`.

### Task 3: Historical plan and changelog correction

**Files:**
- Modify: `docs/superpowers/plans/2026-08-08-issue-3-github-app-readonly-checks.md`, `CHANGELOG.md`

- [ ] Mark the original plan historical and superseded by the 2026-08-09 recovery/hardening plan.
- [ ] State that its file map and checklist describe the original proposal, not current implementation status.
- [ ] Add an Unreleased changelog bullet for delivery-ID boundary validation and stable malformed-token errors.
- [ ] Commit as `docs: mark original GitHub App plan historical`.

### Task 4: Final verification and PR reconciliation

- [ ] Run the focused GitHub suites, typecheck, and `git diff --check`.
- [ ] Run `npm run check` with separately recorded provenance on exact Node 24.18.0 and 22.22.2.
- [ ] Run a fresh CodeRabbit committed-diff review against `main`; resolve every valid Critical/Major finding.
- [ ] Fast-forward the existing PR branch, push, wait for GitHub checks, and re-fetch review threads.
- [ ] Reply to and resolve any addressed in-scope threads; explain rejected or out-of-scope findings.

