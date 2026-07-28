# Issue 17 — Harden doctor prompt-transport probe timeout semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Do not skip failing-test-first order. Keep commits focused and reviewable.

**Status:** `IMPLEMENTATION_PLAN_READY_FOR_REVIEW`

**Goal:** Implement the approved Issue #17 design so `maswe doctor` uses a bounded, validated, configurable probe timeout (`policy.doctorProbeTimeoutMs`) and emits deterministic typed doctor-check codes without expanding scope.

**Architecture:** Keep orchestration/runtime boundaries unchanged. Add one policy field to normalized config + schema, add typed doctor-check code vocabulary to `RuntimeDoctorResult`, and refactor `CursorCliRuntime.doctor()` classification/timeout wiring to emit exact approved codes while preserving independent cleanup reporting and existing process semantics.

**Tech Stack:** TypeScript ESM, Node `node:test` (`--experimental-strip-types`), JSON Schema 2020-12, npm scripts/CI defined in `package.json` and `.github/workflows/ci.yml`.

**Approved design inputs:**
- Design: `docs/superpowers/specs/2026-07-28-issue-17-doctor-probe-timeout-design.md`
- Approved baseline SHA: `277e14483c1d2ad280d67ee3262f3e8ef575e338`
- Design status gate: `DESIGN_FINAL_READY_FOR_APPROVAL`

---

## Agent-execution note

- This plan is implementation-only guidance; it does not authorize merge.
- Execute exactly on a branch created from the approved base SHA.
- Preserve owner-approved scope boundaries (no cleanup timeout hardening, no auth message heuristics, no process lifecycle redesign).
- Keep all checklist items **unchecked** until execution evidence is produced.

## Global constraints

- Maintain runtime-core separation: only runtime adapters touch provider execution details.
- Keep `src/state-machine.ts` untouched unless strictly required (Issue #17 should not require changes there).
- No silent clamping/fallback for invalid `doctorProbeTimeoutMs`; fail closed at config validation.
- No message-text authentication inference.
- Reserved codes are type-only vocabulary in this issue; never emitted.
- Cleanup remains a separate check; primary probe failures must not be overwritten.
- No production behavior changes outside approved Issue #17 contract.

## Scope boundaries

### In scope

- `policy.doctorProbeTimeoutMs` config contract (default/bounds/validation/schema).
- Required typed doctor-check result codes and optional `prerequisite`.
- Deterministic doctor classification mapping and exact timeout propagation.
- Focused regression tests + compatibility test updates for doctor-result consumers.
- Documentation updates directly tied to this behavior/contract.

### Out of scope

- Emitting reserved codes (`auth-failure`, `process-termination-failure`, `probe-malformed-output`, `probe-invalid-terminal-marker`).
- Cleanup deadlines, total doctor wall-clock deadline, SIGTERM-first termination model.
- Structured probe-output parsing or marker validation expansion.
- Authenticated smoke lifecycle changes (Issue #18), output helper cleanup (Issue #16), or unrelated refactors.

---

## Task 1 — Capture approved baseline and add failing tests first

**Files:**
- Create: `test/issue17-doctor-probe-timeout.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/schema.test.ts`
- Modify: `test/linked-worktree-compat.test.ts`
- Modify: `test/compat-doctor.test.ts`
- Modify: `test/merge-blockers-round3.test.ts`
- Modify: `test/rc-review-corrections.test.ts`

**Interfaces exercised:**
- `migrateConfig()`, `assertConfig()`, `mergeConfigForTest()`
- `CursorCliRuntime.doctor()`
- `RuntimeDoctorResult` checks contract

**Fixture strategy (deterministic):**
- Use `CursorCliRuntime` `spawnFn` injection to control `--version`, `models`, and probe outcomes.
- Use existing `ensureProbeWorkspace` test seam for partial probe-worktree scenarios.
- Use deterministic timeout simulation (`timedOut: true`) instead of real-time sleeping.
- Use temporary git repos only where cleanup behavior requires real branch/worktree assertions.
- Use an explicit red/green loop for each behavior: write a failing test first (red), implement minimal code to pass (green), then refactor while staying green.

**Steps:**
- [ ] Re-capture implementation-start baseline in worktree: `git rev-parse HEAD`, `git branch --show-current`, `git status --porcelain=v1`, `git diff --check`.
- [ ] Add failing tests for config defaulting: omitted `doctorProbeTimeoutMs` normalizes to `60_000`.
- [ ] Add failing tests for explicit valid bounds: `1_000` and `300_000` accepted.
- [ ] Add failing tests for invalid values: below minimum, above maximum, zero, negative, fractional, non-finite, wrong JSON type, malformed representation.
- [ ] Add failing doctor-timeout propagation test proving exact `doctorProbeTimeoutMs` value is passed to prompt probe spawn options.
- [ ] Add failing regression test proving old `Math.min(5_000, commandTimeoutMs)` cap is removed.
- [ ] Add failing typed-code tests enforcing required `code` on emitted checks and strict allowed vocabulary usage.
- [ ] Add failing tests for skipped-prerequisite classification with stable prerequisite attribution.
- [ ] Add failing tests distinguishing executable unavailable vs executable starts and fails.
- [ ] Add failing tests distinguishing probe timeout vs non-timeout invocation failure.
- [ ] Add failing tests proving cleanup failure is reported independently and does not replace primary probe failure.
- [ ] Add failing tests proving no authentication inference from stderr/message text.
- [ ] Add failing tests asserting reserved codes are never emitted by Issue #17 paths.

---

## Task 2 — Add and validate the configuration contract

**Files:**
- Modify: `src/domain.ts` (policy field shape only in this task)
- Modify: `src/config.ts`
- Modify: `schemas/config.schema.json`
- Modify: `examples/config.example.json`
- Modify: `test/config.test.ts`
- Modify: `test/schema.test.ts`
- Modify: `test/linked-worktree-compat.test.ts`
- Modify: `test/rc-review-corrections.test.ts` (migrated config assertions if required)

**Interfaces:**
- `MasweConfig.policy.doctorProbeTimeoutMs: number` (normalized required field)
- `DEFAULT_CONFIG.policy.doctorProbeTimeoutMs = 60_000`
- `assertConfig()` integer + hard-bound enforcement
- JSON Schema `policy.properties.doctorProbeTimeoutMs` with `minimum: 1000`, `maximum: 300000`

**Steps:**
- [ ] Add `doctorProbeTimeoutMs: 60_000` to `DEFAULT_CONFIG.policy`.
- [ ] Extend `MasweConfig.policy` with required `doctorProbeTimeoutMs: number`.
- [ ] Keep raw config omission valid via `migrateConfig()` shallow merge behavior.
- [ ] Add `assertConfig()` hard validation: integer only, min `1_000`, max `300_000`, fail closed on all invalid values.
- [ ] Add schema property as optional raw field (not in `policy.required`) with integer min/max.
- [ ] Update example config to include explicit default field for operator discoverability.
- [ ] Ensure partial policy objects keep all defaults (including `doctorProbeTimeoutMs`) after migration.
- [ ] Re-run focused config/schema tests and keep failures only in unimplemented downstream tasks.

---

## Task 3 — Add typed doctor-result domain contract and wire consumers/renderers

**Files:**
- Modify: `src/domain.ts`
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `src/runtimes/mock.ts`
- Modify: `src/runtimes/cursor-sdk.ts`
- Modify: `src/cli.ts`
- Modify: `test/issue17-doctor-probe-timeout.test.ts`
- Modify: `test/compat-doctor.test.ts`
- Modify: `test/linked-worktree-compat.test.ts`
- Modify: `test/merge-blockers-round3.test.ts`
- Modify: `test/rc-review-corrections.test.ts`
- Modify: `test/issue19-runtime-failure.test.ts` (if needed to assert non-regression with added fields)
- Modify: RuntimeDoctorResult type-consumer tests:
  - `test/orchestrator.test.ts`
  - `test/commit-provenance.test.ts`
  - `test/failed-run-provenance.test.ts`
  - `test/evidence-freshness.test.ts`
  - `test/issue19-persistence.test.ts`
  - `test/issue19-success-event-persistence.test.ts`
  - `test/model-resolution.test.ts`

**Interfaces:**
- New union type `DoctorCheckCode` in `src/domain.ts`:
  - Emitted: `"ok"`, `"cursor-executable-unavailable"`, `"cursor-version-check-failure"`, `"catalogue-discovery-failure"`, `"model-resolution-failure"`, `"skipped-prerequisite-failure"`, `"probe-invocation-failure"`, `"probe-transport-timeout"`, `"cleanup-failure"`, `"doctor-unexpected-error"`
  - Reserved/non-emitted: `"auth-failure"`, `"process-termination-failure"`, `"probe-malformed-output"`, `"probe-invalid-terminal-marker"`
- `RuntimeDoctorResult.checks[*]` gains required `code: DoctorCheckCode`.
- `RuntimeDoctorResult.checks[*]` gains optional `prerequisite?: string`.

**Steps:**
- [ ] Add `DoctorCheckCode` union in `src/domain.ts` using existing kebab-case string-literal convention.
- [ ] Extend `RuntimeDoctorResult` check shape with required `code` and optional `prerequisite`.
- [ ] Update all runtime check constructors (`cursor-cli`, `mock`, `cursor-sdk`) to supply required `code`.
- [ ] Update CLI doctor rendering path to remain compatible with the new required field (and include code display if adopted here).
- [ ] Update tests and test-runtime stubs that construct non-empty doctor checks to include code fields.
- [ ] Ensure exhaustive handling in tests/helpers where code switching is introduced.

---

## Task 4 — Correct executable, catalogue, model, and prerequisite classification

**Files:**
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `test/issue17-doctor-probe-timeout.test.ts`
- Modify: `test/compat-doctor.test.ts`
- Modify: `test/model-resolution.test.ts`
- Modify: `test/issue12-model-catalogue.test.ts` (if additional catalogue failure assertion support is needed)

**Interfaces and deterministic mappings:**
- `cursor-cli` check:
  - Spawn reject with `error.code ∈ { ENOENT, EACCES, EPERM, ENOTDIR }` → `"cursor-executable-unavailable"`
  - Process started; non-zero or timed-out `--version` result → `"cursor-version-check-failure"`
  - Other unexpected exception → `"doctor-unexpected-error"`
- `model-catalogue` check:
  - Discovery operation ran and failed → `"catalogue-discovery-failure"`
- `model-{role}` checks:
  - Logical resolution attempt failed → `"model-resolution-failure"`
- `prompt-transport-probe` skipped:
  - Code `"skipped-prerequisite-failure"`, `ok: false`, and stable prerequisite attribution

**Stable `prerequisite` values (exact):**
- `"model-catalogue"` when probe did not run because catalogue discovery failed.
- `"model-brainstormer"` when catalogue exists but brainstormer exact-model resolution failed.

**Process-abstraction note:**
- Current `spawnCaptured()` rejection path already surfaces Node spawn errors as rejected `Error` objects with optional `code`; this is sufficient for ENOENT/EACCES/EPERM/ENOTDIR classification.
- Do **not** add `SpawnResult` fields or termination redesign in Issue #17.

**Steps:**
- [ ] Refactor `doctor()` to classify `--version` outcomes separately from outer unexpected failures.
- [ ] Ensure non-zero `--version` is never misclassified as executable-unavailable.
- [ ] Split catalogue-discovery failure from model-resolution failure in check generation.
- [ ] Emit skipped-probe check only when probe was not executed; attach exact prerequisite value.
- [ ] Add deterministic tests covering every mapping branch above.

---

## Task 5 — Replace hard-coded probe timeout and propagate exact normalized value

**Files:**
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `test/issue17-doctor-probe-timeout.test.ts`
- Modify: `test/compat-doctor.test.ts`

**Interfaces:**
- Remove: `Math.min(5_000, this.config.policy.commandTimeoutMs)`
- Use: `this.config.policy.doctorProbeTimeoutMs`

**Steps:**
- [ ] Replace probe spawn timeout assignment with the exact normalized config value.
- [ ] Remove all call-site fallback logic (`?? 60_000`) for probe timeout.
- [ ] Add test asserting default behavior is now effectively 60 seconds without sleeping 60 seconds.
- [ ] Add test asserting configured values (e.g., `1_000`, `15_000`, `300_000`) are propagated exactly.
- [ ] Add test asserting no hidden cap remains when `commandTimeoutMs` is lower/higher.
- [ ] Add test asserting timeout remains fail-closed (`"probe-transport-timeout"`).
- [ ] Add test asserting non-timeout non-zero exit remains `"probe-invocation-failure"`.

---

## Task 6 — Preserve independent cleanup reporting (no new cleanup deadline)

**Files:**
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `test/issue17-doctor-probe-timeout.test.ts`
- Modify: `test/merge-blockers-round3.test.ts`
- Modify: `test/rc-review-corrections.test.ts`

**Interfaces:**
- `cleanupDoctorProbeSafe()` result check must remain independent.
- Cleanup check codes:
  - success → `"ok"`
  - failure → `"cleanup-failure"`

**Steps:**
- [ ] Add tests proving cleanup check is present after probe success, timeout, and non-timeout invocation failure.
- [ ] Add test proving cleanup failure is emitted as its own check and does not overwrite primary probe code.
- [ ] Add test proving `report.ok` remains false if either primary check or cleanup fails.
- [ ] Confirm no cleanup timeout/global doctor deadline is introduced.

---

## Task 7 — Update documentation and contracts

**Files:**
- Modify: `docs/OPERATIONS.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md` (contract boundary clarification where needed)
- Modify: `CHANGELOG.md`
- Modify: `examples/config.example.json`

**Documentation requirements:**
- New `policy.doctorProbeTimeoutMs` field with default 60_000 and hard bounds 1_000..300_000.
- Explicit behavior change: old implicit 5-second cap replaced by default 60-second probe timeout.
- Typed code semantics and emitted vs reserved distinction.
- Skipped prerequisite behavior and `prerequisite` values.
- Explicit statement: no total doctor wall-clock bound yet; cleanup timeout hardening remains follow-up.
- Authenticated validation procedure (separate from deterministic tests) and evidence expectations.

**Steps:**
- [ ] Update operator docs with configuration contract and runtime implications.
- [ ] Update architecture docs to reflect doctor typed-code classification and probe-timeout policy.
- [ ] Update artifact/contract docs to avoid overstating unsupported auth/process-termination distinctions.
- [ ] Add changelog entry for Issue #17 behavioral/contract change.

---

## Task 8 — Deterministic validation protocol

**Files:** no new source files; command evidence only.

**Focused command set (derived from existing scripts/tests):**
- [ ] `npm ci --include=dev --ignore-scripts --no-audit --no-fund`
- [ ] `npm run typecheck`
- [ ] `node --experimental-strip-types --test test/config.test.ts test/schema.test.ts test/linked-worktree-compat.test.ts`
- [ ] `node --experimental-strip-types --test test/issue17-doctor-probe-timeout.test.ts test/compat-doctor.test.ts test/merge-blockers-round3.test.ts test/rc-review-corrections.test.ts test/model-resolution.test.ts test/issue12-model-catalogue.test.ts test/issue19-runtime-failure.test.ts`
- [ ] `node --experimental-strip-types --test test/orchestrator.test.ts test/commit-provenance.test.ts test/failed-run-provenance.test.ts test/evidence-freshness.test.ts test/issue19-persistence.test.ts test/issue19-success-event-persistence.test.ts`
- [ ] `npm test`
- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `npm run pack:dry`
- [ ] `npm pack --json`
- [ ] Inspect produced tarball contents (e.g., `tar -tf <generated-tgz>` and verify expected `dist/`, `schemas/`, docs/package files)
- [ ] `git diff --check`
- [ ] `git status --porcelain=v1`

**Node-version coverage:**
- [ ] Run deterministic validation on current Node 22 runtime (`node --version` recorded).
- [ ] Run CI-parity compatibility validation on exact Node `22.22.2`:
  - `export PATH="$HOME/.nvm/versions/node/v22.22.2/bin:$PATH"`
  - `node --version && npm --version`
  - `npm ci --include=dev --ignore-scripts --no-audit --no-fund`
  - `npm run check`
  - `npm run pack:dry`

---

## Task 9 — Authenticated validation (post-deterministic, evidence only)

**Files:** no committed code changes required; evidence captured in PR/issue comments.

**Required recorded fields:**
- [ ] Implementation commit SHA (`git rev-parse HEAD`).
- [ ] Cursor CLI version (`agent --version`).
- [ ] Selected exact model ID used by doctor probe.
- [ ] Effective `doctorProbeTimeoutMs` value.
- [ ] Elapsed probe time observation.
- [ ] Doctor check codes emitted for the run.
- [ ] Cleanup outcome check code and message.
- [ ] Before/after worktree + `maswe/doctor-*` branch inventory.
- [ ] Redacted command output excerpts.
- [ ] Environment limitations and caveats (single-run latency is observational, not provider guarantee).

**Procedure constraints:**
- [ ] Run only after deterministic suite passes.
- [ ] Do not treat a single live latency sample as generalized provider SLA.
- [ ] Keep authenticated evidence supplementary; deterministic tests remain primary acceptance evidence.

---

## Task 10 — PR and independent-validation handoff

**Files:** branch/PR metadata + review evidence; no unrelated source edits.

**Steps:**
- [ ] Create focused commits matching task boundaries and preserving test-first history.
- [ ] Publish branch `issue/17-doctor-probe-timeout`.
- [ ] Open draft PR referencing Issue #17 and approved design document.
- [ ] Ensure CI runs against exact PR head SHA (no stale-run acceptance).
- [ ] Request and address reviews from CodeRabbit, Copilot, Codex, and independent verifier per repository policy.
- [ ] Re-run deterministic validation after every head-changing commit.
- [ ] Provide exact final handoff SHA with command evidence and acceptance-matrix completion.
- [ ] Do not merge until all required checks/reviews apply to the exact final head.

---

## Commit boundaries (implementation phase)

1. **Plan/governance artifacts**
   - `docs/superpowers/specs/2026-07-28-issue-17-doctor-probe-timeout-design.md` (only if strictly needed corrections)
   - `docs/superpowers/plans/2026-07-28-issue-17-doctor-probe-timeout.md`
2. **Failing config/schema tests**
   - New/updated tests only (`config` + `schema` + migration/default checks).
3. **Config/schema implementation**
   - `src/domain.ts`, `src/config.ts`, `schemas/config.schema.json`, example config.
4. **Failing typed doctor-result/runtime tests**
   - Doctor classification + timeout + reserved-code non-emission tests.
5. **Domain/runtime implementation**
   - `src/domain.ts`, `src/runtimes/cursor-cli.ts`, `src/runtimes/mock.ts`, `src/runtimes/cursor-sdk.ts`, `src/cli.ts`.
6. **Documentation/contract updates**
   - `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `docs/ARTIFACT_CONTRACTS.md`, `CHANGELOG.md`.
7. **Validation corrections (if needed)**
   - Smallest possible follow-up commit with no scope expansion.

Do not squash away test-first commits unless explicitly authorized later.

---

## Acceptance traceability matrix (design AC1–AC23)

| AC | Requirement summary | Implementation task(s) | Source file(s) | Test file(s) | Validation command(s) | Expected evidence |
|---|---|---|---|---|---|---|
| AC1 | Remove hard-coded `Math.min(5_000, ...)` probe timeout path | Task 5 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | No `Math.min(5_000` in probe path; tests assert exact propagated timeout |
| AC2 | Add `doctorProbeTimeoutMs` + `DoctorCheckCode` + required `code` + optional `prerequisite` | Tasks 2, 3 | `src/domain.ts` | `test/issue17-doctor-probe-timeout.test.ts`, compatibility tests | `npm run typecheck` + focused tests | Type errors gone only after field/union/shape updates are complete |
| AC3 | Hard reject invalid timeout values in `assertConfig()` | Task 2 | `src/config.ts` | `test/config.test.ts`, `test/rc-review-corrections.test.ts` | Focused config tests | Invalid values throw with `doctorProbeTimeoutMs` validation error |
| AC4 | Default `doctorProbeTimeoutMs: 60_000` in `DEFAULT_CONFIG`; migrate omission to 60_000 | Task 2 | `src/config.ts`, `src/domain.ts` | `test/config.test.ts`, `test/linked-worktree-compat.test.ts` | Focused config tests | Omitted raw config yields normalized `60_000` exactly |
| AC5 | Schema property optional integer [1000, 300000] | Task 2 | `schemas/config.schema.json` | `test/schema.test.ts` | Focused schema tests | Schema accepts valid bound values and rejects out-of-range/wrong-type |
| AC6 | Probe spawn uses exact `this.config.policy.doctorProbeTimeoutMs` (no fallback) | Task 5 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Captured spawn options show exact normalized timeout |
| AC7 | Every doctor check literal includes required `code` | Task 3 | `src/runtimes/cursor-cli.ts`, `src/runtimes/mock.ts`, `src/runtimes/cursor-sdk.ts` | Compatibility tests touching doctor checks | `npm run typecheck` + focused doctor tests | Compile-time + runtime assertions show code present on emitted checks |
| AC8 | Deterministic tests assert `code` values (message text only for message-quality tests) | Task 1, Task 3 | test suite | `test/issue17-doctor-probe-timeout.test.ts`, updated doctor tests | Focused doctor tests | Assertions primarily use `check.code`, with labeled message-only tests |
| AC9 | Primary probe failure and cleanup failure both preserved independently | Task 6 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts`, `test/merge-blockers-round3.test.ts`, `test/rc-review-corrections.test.ts` | Focused doctor tests | Report contains separate failed checks with distinct codes |
| AC10 | Operations doc covers new timeout field + semantics | Task 7 | `docs/OPERATIONS.md` | Doc review (no unit tests) | Full validation + review checklist | Docs include default/range/independence/limitations text |
| AC11 | Timeout failure message contains effective timeout in ms | Task 5 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Timeout check message includes `timed out after <N>ms` |
| AC12 | Timeout remains hard failure with code `probe-transport-timeout` | Task 5 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Timed-out probe => `ok:false`, code `probe-transport-timeout` |
| AC13 | No claim/test of global doctor wall-clock bound | Task 6, Task 7 | `src/runtimes/cursor-cli.ts`, docs | `test/issue17-doctor-probe-timeout.test.ts` (no global-bound assertion) | Focused + doc review | Tests/documentation avoid asserting total bound |
| AC14 | Cleanup-timeout hardening remains explicit follow-up only | Task 7 | `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `CHANGELOG.md` | Doc review | Full validation + review checklist | Docs explicitly defer cleanup timeout changes |
| AC15 | Repository check pipeline passes | Task 8 | n/a | n/a | `npm run check` | Recorded command output for exact head |
| AC16 | Cleanup still always attempted via `finally` | Task 6 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts`, `test/merge-blockers-round3.test.ts` | Focused doctor tests | Cleanup check present after success/failure/timeout paths |
| AC17 | Skipped probe emits `skipped-prerequisite-failure`, `ok:false`, and stable `prerequisite`; not mislabeled model/auth/transport failure | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Skipped probe has exact code + prerequisite (`model-catalogue` or `model-brainstormer`) |
| AC18 | Executable unavailable distinct from started-but-failing version check | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | ENOENT/EACCES/EPERM/ENOTDIR map to unavailable; started non-zero/timeouts map to version-check-failure |
| AC19 | Emitted code predicates are deterministic and mutually exclusive | Task 4 | `src/runtimes/cursor-cli.ts`, `src/domain.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Branch coverage verifies one code per concrete condition |
| AC20 | Reserved codes remain non-emitted | Task 3, Task 4 | `src/domain.ts`, `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Reserved-code set is never observed in emitted checks |
| AC21 | No auth inference from message text; generic non-zero probe exit => invocation-failure | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Auth-like stderr still yields `probe-invocation-failure` |
| AC22 | Probe failure + cleanup failure remain separate; no overwrite/suppression | Task 6 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts`, `test/rc-review-corrections.test.ts` | Focused doctor tests | Output contains both checks/codes in same report |
| AC23 | Implementation plan/implementation do not claim reserved-code support | Tasks 3, 7, 10 | `src/domain.ts`, docs, PR notes | `test/issue17-doctor-probe-timeout.test.ts` | Focused tests + review checklist | Type includes reserved vocabulary; runtime/docs mark them non-emitted |

---

## Full validation protocol (execution handoff checklist)

1. Pre-change revalidation: baseline SHA, branch, worktree status, diff-check clean.
2. Apply failing-test commits before implementation commits.
3. Run focused tests after each task; keep failures localized.
4. Run full deterministic suite (`npm run check`) before review handoff.
5. Run Node `22.22.2` CI-parity compatibility command set.
6. Run package dry run and tarball content inspection.
7. Re-run `git diff --check` and ensure only approved files changed.
8. Capture exact head SHA + command outputs in PR description.
9. Run authenticated validation procedure after deterministic pass and capture required evidence fields.
10. Re-run deterministic validation after every head change during review resolution.

---

## PR and external-review handoff

- Branch: `issue/17-doctor-probe-timeout`
- PR type: Draft until deterministic + authenticated evidence is complete.
- Required reviewers/tools: CodeRabbit, Copilot, Codex, independent verifier.
- Policy: all review resolutions require revalidation on the new exact head SHA.
- Final handoff must include:
  - exact final commit SHA;
  - acceptance matrix completion evidence;
  - deterministic command transcript summary;
  - authenticated validation summary with redacted output and limitations.
