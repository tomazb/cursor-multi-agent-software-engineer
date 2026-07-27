# Issue 19 Cursor CLI Failure Redaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent raw Cursor CLI stderr from entering durable MASWE failure state while retaining bounded, structured operator diagnostics.

**Architecture:** Bound diagnostic inspection before purpose-specific redaction, return typed safe failures from the Cursor CLI adapter, aggregate typed failures within fixed budgets, persist only an explicit bounded attempt subset, and re-sanitize failure-specific fields at orchestration/store persistence boundaries. Successful artifact handling remains unchanged.

**Tech Stack:** TypeScript ESM, Node.js 22 test runner, JSON Schema, Markdown documentation.

## Global Constraints

- Raw stderr is transient and must never be persisted, hashed, logged, attached, or returned in runtime metadata.
- Individual diagnostics are at most 2,048 Unicode code points; fallback aggregates are at most 8,192 Unicode code points.
- Normalize controls, redact, then truncate with `… [truncated]`.
- Preserve `invalid-transport-json`, `unsupported-response-shape`, and `missing-logical-output`.
- Keep state transitions in `src/state-machine.ts`; do not add provider imports to core workflow code.
- Every behavioral change starts with a failing test and ends with focused plus full verification.

## Independent-verifier correction amendment

Historical head with the authoritative independent-verifier `FAIL`:
`7b3ba017195e7ecde6722d748d678e98d567aaa9`.

This amendment preserves the original Issue #19 plan and adds the repair sequence required by the
independent verifier. It does not erase the earlier validation history.

### Task 6: Capture the independent failures

**Files:**
- Modify: `test/redaction.test.ts`
- Modify: `test/issue19-runtime-failure.test.ts`
- Modify: `test/issue19-persistence.test.ts`
- Modify: `test/schema.test.ts`

- [x] Add synthetic `github_pat_`, username-only URI, ordinary-email, scaling, match-heavy,
  durable-attempt, schema-v1, model-framing, and human/JSON CLI regressions.
- [x] Record the expected red failures outside the subprocess-suppressing workspace sandbox.
- [x] Commit tests only as `63c7c2b`.

### Task 7: Replace unbounded/ambiguous diagnostic matching

**Files:**
- Modify: `src/redaction.ts`
- Modify: `test/redaction.test.ts`

- [x] Replace the nested ambiguous assignment expression with a monotonic assignment scanner.
- [x] Add monotonic URI-authority and incomplete-private-key scanners.
- [x] Recognize synthetic `github_pat_` shapes and full userinfo for supported `scheme://` URIs.
- [x] Inspect at most output budget + 4,096 code points and never more than 12,288 before redaction.
- [x] Preserve the 2,048/8,192 output limits and close secrets crossing the retained boundary.
- [x] Commit the focused repair as `213edcf`.

### Task 8: Persist the bounded durable attempt subset

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/failure-diagnostics.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/store.ts`
- Modify: `src/run-rendering.ts`
- Modify: `schemas/run-record.schema.json`
- Modify: `test/issue19-persistence.test.ts`
- Modify: `test/schema.test.ts`

- [x] Add optional `failure.runtime` with at most eight attempts, total/omitted counts, and aggregate
  truncation.
- [x] Retain allowlisted code/model/message/exit/timeout/duration/transport/stderr/truncation fields.
- [x] Cap attempt messages at 512 and model display fields at 256 code points.
- [x] Normalize model display framing without changing the model passed to execution.
- [x] Reconstruct/sanitize the subset for run failure, `FAIL`, retry, migration, supersede, and CLI.
- [x] Commit the durable contract as `f82a6ac`.

### Task 9: Correct documentation and contracts

**Files:**
- Modify: `docs/SECURITY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `docs/superpowers/specs/2026-07-26-issue-19-redact-cursor-stderr-design.md`
- Modify: this plan
- Modify: `CHANGELOG.md`

- [x] Document the credential grammar, work window, scanner complexity rationale, durable schema,
  historical compatibility, model framing, limitations, and SDK exception follow-up.
- [x] Commit the corrected contracts as `b0a2c02`.

### Task 10: Revalidate and publish the correction

- [x] Run dependency install, focused suites, PR #15/Issue #12/Thermos/unauthorized-marker suites,
  full checks, both Issue #11 contention gates, build, dry pack, actual pack, and diff check.
- [x] Record old/new sanitizer medians and scaling on the same runtime environment.
- [x] Audit every synthetic canary across repository/generated/package/temporary state.
- [ ] Push the exact head and require exact-SHA CI.
- [ ] Request CodeRabbit, Codex, and Copilot; reply to and resolve the three live threads only after
  exact-head CI is green.
- [ ] Update the draft PR body without erasing the failed-head history.
- [ ] Create a new external-validation handoff for the corrected exact head.

Local correction validation used Node `v24.18.0` on Linux `7.1.4-204.fc44.x86_64`. The failing
implementation's isolated three-repetition regression measured 20,000 and 40,000 adversarial code points at
342.58 ms and 1,350.66 ms median respectively (3.94x on doubling); a supplementary two-repetition observation
measured approximately 1.35 s and 5.39 s at 40,000 and 80,000. The bounded implementation measured 20,000,
40,000, and 80,000 code points at 0.478 ms, 0.311 ms, and 0.311 ms median respectively across seven
repetitions of 100 calls. Benchmarking supports, but does not replace, the source-level argument: bounded
prefix collection caps work before the monotonic scanners run, and the former nested ambiguous repetition no
longer exists.

The direct focused correction set passed 48/48. The PR #15, Issue #12, Thermos, and unauthorized-marker
compatibility set passed 98 tests with three opt-in skips. Both exact Issue #11 contention gates passed at 25
allocation iterations and 100 release iterations. The full suite and `npm run check` each reported 340 tests,
335 passing, five opt-in skips, and zero failures. Type checking, build, dry pack, actual pack (83 files),
archive inspection, diff checking, and the generated-state canary audit passed; deliberate fixtures remained
only in test source. After review-induced SDK, escaped-assignment, overlong-URI, framing-control, performance
probe, and rendering clarifications, the final local `npm run check` reported 345 tests, 340 passing, five
opt-in skips, and zero failures; both contention gates and the 83-file dry/actual pack audit passed again.

---

### Task 1: Redaction and deterministic diagnostic bounds

**Files:**
- Modify: `test/redaction.test.ts`
- Modify: `src/redaction.ts`

**Interfaces:**
- Produces: `sanitizeDiagnostic(input: string, maxCodePoints?: number): SanitizedDiagnostic`
- Produces: `FAILURE_DIAGNOSTIC_MAX_CODE_POINTS`, `FAILURE_AGGREGATE_MAX_CODE_POINTS`

- [ ] **Step 1: Write failing unit tests**

Add synthetic cases for GitHub/OpenAI/Slack tokens, authorization and standalone bearer values, URL userinfo,
assignments, AWS secrets, PEM blocks, query parameters, placement/multiplicity, controls, Unicode boundaries,
redaction-before-truncation, and deterministic repeated invocation.

- [ ] **Step 2: Run the redaction suite and record RED**

Run: `node --experimental-strip-types --test test/redaction.test.ts`

Expected: failures showing standalone bearer, URL credentials, assignments, query parameters, control
normalization, and bounded diagnostics are not implemented.

- [ ] **Step 3: Implement the smallest sanitizer**

Extend narrowly tested patterns in `redactSecrets()`. Implement control normalization and a code-point-aware
truncator whose returned `text` never exceeds its supplied maximum and whose `truncated` flag is deterministic.

- [ ] **Step 4: Run the redaction suite GREEN**

Run: `node --experimental-strip-types --test test/redaction.test.ts`

Expected: all redaction and boundary tests pass.

### Task 2: Typed Cursor CLI runtime failures

**Files:**
- Create: `test/issue19-runtime-failure.test.ts`
- Modify: `src/domain.ts`
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `src/runtimes/cursor-sdk.ts`
- Modify: `src/runtimes/mock.ts`
- Modify compatibility assertions in `test/rc-review-corrections.test.ts`

**Interfaces:**
- Produces: discriminated `RuntimeResult`
- Produces: `RuntimeFailureDiagnostic` and stable `RuntimeFailureCode`

- [ ] **Step 1: Write failing runtime cases**

Inject process results for non-zero empty stdout, non-zero structured stdout, timeout, large stderr,
authentication-like stderr, catalogue failure, doctor failure, and exit-zero decode failure. Assert no raw
secret in output/metadata, useful operational fields, fixed bounds, stable codes, and preserved decode codes.

- [ ] **Step 2: Run the runtime suite and record RED**

Run: `node --experimental-strip-types --test test/issue19-runtime-failure.test.ts test/thermos-issue12-blockers.test.ts`

Expected: Issue #19 tests fail because raw stderr appears in output/metadata and typed failure fields are absent.

- [ ] **Step 3: Implement typed safe results**

Classify Cursor outcomes using structured process fields only. Authentication-like prose remains useful inside
the redacted non-zero diagnostic but never controls classification. Never decode non-zero stdout as assistant
success. Return only sanitized diagnostic data and booleans such as `stderrPresent`; omit `stderr`.
Sanitize catalogue/doctor strings. Adapt SDK/mock construction to the discriminated result contract.

- [ ] **Step 4: Run runtime suites GREEN**

Run: `node --experimental-strip-types --test test/issue19-runtime-failure.test.ts test/cursor-cli-output.test.ts test/thermos-issue12-blockers.test.ts test/rc-review-corrections.test.ts`

Expected: all runtime and PR #15 structured-output regressions pass.

### Task 3: Orchestrator aggregation and durable-state safeguards

**Files:**
- Create: `test/issue19-persistence.test.ts`
- Modify: `src/orchestrator.ts`
- Modify: `src/store.ts`
- Modify: `src/cli.ts`
- Modify: `schemas/run-record.schema.json` only if the durable failure shape changes

**Interfaces:**
- Consumes: `RuntimeFailureDiagnostic`, `sanitizeDiagnostic`
- Produces: bounded per-model and aggregate failure rendering
- Produces: failure-specific `sanitizeRunForPersistence()` behavior

- [ ] **Step 1: Write failing integration tests**

Use a deliberately unsafe runtime stub. Drive start/fallback/failure, inspect returned and persisted `run.json`,
events, artifacts, retry `previousFailure`, supersede state, human/JSON CLI status, and both fallback policy
branches. Assert canaries are absent and model/code/exit/timeout metadata remains actionable.

- [ ] **Step 2: Run the persistence suite and record RED**

Run: `node --experimental-strip-types --test test/issue19-persistence.test.ts`

Expected: canaries appear in `run.failure`, `FAIL.details.reason`, retry history, and status output.

- [ ] **Step 3: Implement bounded structured aggregation**

Replace prose-only `ensureSuccess()` errors with an explicit runtime failure error carrying structured fields.
Bound each failure before adding it, stop aggregate construction at 8,192 code points, and sanitize thrown
runtime exceptions. `failRun()` sanitizes before assigning or applying events.

- [ ] **Step 4: Add persistence and CLI defense in depth**

Before store serialization, sanitize only `run.failure.message`, `FAIL.details.reason`, and
`RETRY_FROM_FAILED.details.previousFailure.message`. Defensively sanitize the human-rendered failure line.
Do not blanket-redact successful run fields or artifacts.

- [ ] **Step 5: Run integration and compatibility suites GREEN**

Run: `node --experimental-strip-types --test test/issue19-persistence.test.ts test/orchestrator.test.ts test/failed-run-provenance.test.ts test/store.test.ts test/schema.test.ts test/readonly-fingerprint.test.ts`

Expected: all persistence and existing workflow behavior passes.

### Task 4: Documentation and contracts

**Files:**
- Modify: `docs/SECURITY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `CHANGELOG.md`

**Interfaces:**
- Documents the exact transient boundary, persisted fields, limits, limitations, and no-raw-debug policy.

- [ ] **Step 1: Update documentation**

Document successful assistant output versus exit-zero decode failure versus non-zero process failure, the two
code-point bounds, operator metadata, redaction limitations, retry behavior, and the absence of a raw-debug
channel. Remove any operations guidance that says raw runtime stderr is persisted.

- [ ] **Step 2: Review claims against tests**

Search for `stderr`, `failure`, and `redact` in changed docs and ensure every security claim is enforced by a
test or explicitly described as best-effort.

### Task 5: Validation, review, and publication

**Files:**
- Modify only files justified by test/review findings.

**Interfaces:**
- Produces exact-head validation and draft PR evidence.

- [ ] **Step 1: Install and run focused validation**

Run `npm ci`, `npm run typecheck`, direct Issue #19 suites, structured decoder/runtime suites,
unauthorized-marker suites, Issue #12/Thermos suites, ready-review suite, and Issue #11 contention gates.

- [ ] **Step 2: Run complete validation**

Run `npm test`, `npm run build`, `npm run pack:dry`, `npm run check`, and `git diff --check`.

- [ ] **Step 3: Audit leaks and package**

Search the working tree excluding `.git`/`node_modules`, inspect `.maswe/runs`, `dist`, temporary fixtures, and
the `npm pack --dry-run` manifest. Confirm canaries occur only in deliberate test source/assertions and required
documentation examples.

- [ ] **Step 4: Run CodeRabbit review**

Run `coderabbit review --prompt-only --base main`, address critical/warning findings with a new failing
regression first, then repeat focused and full checks.

- [ ] **Step 5: Commit and push**

Inspect scope with `git status -sb` and the full diff. Create bounded commits, push
`issue/19-redact-cursor-stderr`, and record the exact head.

- [ ] **Step 6: Open draft PR and request reviews**

Open draft title `Redact persisted Cursor CLI failure diagnostics`, body containing `Closes #19` and all
requested evidence. Request CodeRabbit, Codex, and Copilot according to repository practice. Do not merge or
enable auto-merge.

- [ ] **Step 7: Bind CI to exact head**

Wait for exact-head checks, record run/job IDs and checked SHA, and stop as `BLOCKED_VALIDATION` if exact-head CI
cannot be established.
