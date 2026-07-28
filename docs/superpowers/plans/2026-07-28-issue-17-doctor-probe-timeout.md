# Issue 17 — Harden doctor prompt-transport probe timeout semantics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Do not skip failing-test-first order. Keep commits focused and reviewable.

**Status:** `IMPLEMENTATION_PLAN_REVISED_READY_FOR_APPROVAL`

**Goal:** Implement the approved Issue #17 design so `maswe doctor` uses a bounded, validated, configurable probe timeout (`policy.doctorProbeTimeoutMs`) and emits deterministic typed doctor-check codes without expanding scope.

**Architecture:** Keep orchestration/runtime boundaries unchanged. Add one policy field to normalized config + schema, add typed doctor-check code vocabulary to `RuntimeDoctorResult`, and refactor `CursorCliRuntime.doctor()` classification/timeout wiring to emit exact approved codes while preserving independent cleanup reporting and existing process semantics.

**Tech Stack:** TypeScript ESM, Node `node:test` (`--experimental-strip-types`), JSON Schema 2020-12, npm scripts/CI defined in `package.json` and `.github/workflows/ci.yml`.

**Approved design inputs:**
- Design: `docs/superpowers/specs/2026-07-28-issue-17-doctor-probe-timeout-design.md`
- Approved baseline SHA: `277e14483c1d2ad280d67ee3262f3e8ef575e338`
- Design status gate: `DESIGN_APPROVED_FOR_IMPLEMENTATION_PLANNING` (owner approved the design
  for implementation-plan preparation; implementation remains blocked pending explicit owner
  approval of this revised plan).

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
- Catalogue-discovery failure and role-resolution failure are distinct: `"model-resolution-failure"`
  is emitted **only** when `resolveLogicalModelId()` actually ran for a role and threw; a role
  check skipped because catalogue discovery failed uses `"skipped-prerequisite-failure"`.
- Post-version unexpected errors use a stable generic `doctor` check (`"doctor-unexpected-error"`);
  never emit a duplicate failed `cursor-cli` check after a successful `cursor-cli` check.
- `maswe doctor --json` emits the full `RuntimeDoctorResult`; exit status derives from `report.ok`
  in both human and JSON modes; no persistence/schema claim for `RuntimeDoctorResult`.
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
- Create: `test/issue17-doctor-cli-json.test.ts`
- Modify: `test/config.test.ts`
- Modify: `test/schema.test.ts`
- Modify: `test/linked-worktree-compat.test.ts`
- Modify: `test/compat-doctor.test.ts`
- Modify: `test/merge-blockers-round3.test.ts`
- Modify: `test/rc-review-corrections.test.ts`
- Modify: `test/ready-review-corrections.test.ts` (probe-timeout propagation now asserts `doctorProbeTimeoutMs`; also a CI gate)

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

**Files (required modifications — a concrete non-empty check literal or behavior requires change):**
- Modify: `src/domain.ts` — add `DoctorCheckCode`; add required `code` and optional `prerequisite` to `RuntimeDoctorResult.checks`.
- Modify: `src/runtimes/cursor-cli.ts` — every constructed check literal gains a `code` (classification refactor is Task 4).
- Modify: `src/runtimes/mock.ts` — the `mock-runtime` check literal gains `code: "ok"`.
- Modify: `src/runtimes/cursor-sdk.ts` — the `cursor-api-key` and `cursor-sdk` check literals gain `code`.
- Modify: `src/cli.ts` — add the `doctor --json` branch (exact behavior below).
- Create: `test/issue17-doctor-cli-json.test.ts` — CLI human + `--json` coverage (Task 3 renderer + Task 5/exit semantics).
- Modify: `test/issue17-doctor-probe-timeout.test.ts` — typed-code assertions.

**Files (inspect only — must NOT be modified merely because they reference `RuntimeDoctorResult`):**
- `test/orchestrator.test.ts` — delegates `doctor()` to a `MockRuntime`/delegate; constructs no check literal → **inspected, unchanged**.
- `test/commit-provenance.test.ts`, `test/failed-run-provenance.test.ts`, `test/evidence-freshness.test.ts` — return `new MockRuntime().doctor()`; construct no check literal → **inspected, unchanged**.
- `test/model-resolution.test.ts`, `test/issue19-persistence.test.ts`, `test/issue19-success-event-persistence.test.ts`, `test/rc-review-corrections.test.ts` (line ~308 stub) — return `{ ok: true, checks: [] }` (empty array satisfies the required `code` type trivially) → **inspected, unchanged for the empty stub**. (`rc-review-corrections.test.ts` is also touched for behavior assertions in Tasks 2/4/6.)
- `test/issue19-runtime-failure.test.ts` — inspect; change **only if** it constructs a non-empty doctor check literal that fails to compile.

**Compile-driven rule:** For any test not listed as a required modification, the only permitted
reason to edit it is an actual TypeScript compile failure caused by the new required `code`
field. Inspect first; edit only if `npm run typecheck` fails on that file. Do not add `code` to
files that construct no non-empty doctor-check literal.

**Interfaces:**
- New union type `DoctorCheckCode` in `src/domain.ts`:
  - Emitted: `"ok"`, `"cursor-executable-unavailable"`, `"cursor-version-check-failure"`, `"catalogue-discovery-failure"`, `"model-resolution-failure"`, `"skipped-prerequisite-failure"`, `"probe-invocation-failure"`, `"probe-transport-timeout"`, `"cleanup-failure"`, `"doctor-unexpected-error"`
  - Reserved/non-emitted: `"auth-failure"`, `"process-termination-failure"`, `"probe-malformed-output"`, `"probe-invalid-terminal-marker"`
- `RuntimeDoctorResult.checks[*]` gains required `code: DoctorCheckCode`.
- `RuntimeDoctorResult.checks[*]` gains optional `prerequisite?: string`.

**Exact `src/cli.ts` `doctor --json` behavior:**
- In the `doctor` case, after `const report = await runtime.doctor();`:
  - if `has(args, "--json")`: `console.log(JSON.stringify(report, null, 2));`
  - else: keep the existing `for (const check of report.checks) { console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`); }` loop.
  - in both branches: `process.exitCode = report.ok ? 0 : 1;`
- No argument-parser change required (`positional()` already treats `--json` as a bare flag).
- The `--json` output is an in-process serialization of `RuntimeDoctorResult`; make **no**
  persistence or JSON-Schema claim for it.

**Steps:**
- [ ] Add `DoctorCheckCode` union in `src/domain.ts` using existing kebab-case string-literal convention.
- [ ] Extend `RuntimeDoctorResult` check shape with required `code` and optional `prerequisite`.
- [ ] Update the runtime check constructors that build non-empty checks (`cursor-cli`, `mock`, `cursor-sdk`) to supply required `code`.
- [ ] Add the `maswe doctor --json` branch to `src/cli.ts` exactly as specified above; keep human `PASS`/`FAIL` output and `report.ok`-derived exit status in both modes.
- [ ] Create `test/issue17-doctor-cli-json.test.ts` exercising the CLI entry point with the `mock` runtime (`MASWE_RUNTIME=mock`): assert human output lines, `--json` parseability, typed `code`/`prerequisite` visibility, and matching exit semantics (non-zero on failed report in both modes).
- [ ] Run `npm run typecheck`; for any non-required test file that fails to compile, add `code` only to the offending non-empty check literal.

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
  - `--version` **spawn rejected** with `error.code ∈ { ENOENT, EACCES, EPERM, ENOTDIR }` → `"cursor-executable-unavailable"`, then **terminate** the downstream check sequence (the thrown error propagates to the outer catch; no catalogue/model/probe checks are emitted).
  - `--version` process started; non-zero or timed-out result → `"cursor-version-check-failure"` (`cliOk = false`).
  - `--version` exit 0 → `"ok"` (`cliOk = true`).
- `doctor` check (generic identity):
  - An unexpected exception **after** the `cursor-cli` check was already recorded (e.g., a git error from `resolveDoctorProbeCwd()`) reaches the outer catch → emit a check named `doctor` with `"doctor-unexpected-error"`. **Never** emit a second `cursor-cli` check after a successful one.
- `model-catalogue` check:
  - `listModels()` (catalogue-only try/catch) ran and threw → `"catalogue-discovery-failure"`.
- `model-{role}` checks:
  - `resolveLogicalModelId()` ran for this role and threw → `"model-resolution-failure"`.
  - `model-catalogue` failed, so the role check did not execute → `"skipped-prerequisite-failure"`, `prerequisite: "model-catalogue"` (must **not** be `"model-resolution-failure"`).
- `prompt-transport-probe` skipped:
  - Code `"skipped-prerequisite-failure"`, `ok: false`, and stable prerequisite attribution.

**Exact `doctor()` classification refactor (removes the `resolveProjectModels()` trap):**

The current code (base SHA) wraps `listModels()`, `resolveProjectModels(config, catalogueIds)`,
and the per-role `resolveLogicalModelId()` loop in a **single** try/catch, so a role-resolution
throw from `resolveProjectModels()` is caught as a catalogue-discovery failure. Refactor to:

1. Isolate `listModels()` in a **catalogue-only** try/catch. On throw: emit `model-catalogue`
   `"catalogue-discovery-failure"` and, for each retained `model-{role}` check, emit
   `"skipped-prerequisite-failure"` with `prerequisite: "model-catalogue"`; do **not** attempt
   any role resolution.
2. After catalogue success, resolve **each role exactly once** via `resolveLogicalModelId(role.model, catalogueIds)`.
   Construct each `model-{role}` result from that role's **own** resolution attempt (`"ok"` on
   success, `"model-resolution-failure"` on that role's throw).
3. Capture the brainstormer's resolved exact ID from the **brainstormer role's own successful
   result** (not from an aggregate call).
4. **Remove the aggregate `resolveProjectModels()` call from the doctor path.** A model-resolution
   exception must never enter the catalogue-discovery catch. (If a separately justified use of
   `resolveProjectModels()` is later identified, document that justification; the default is
   removal.)
5. Keep the outer catch strictly for the `--version` spawn rejection (→ `cursor-cli`
   `"cursor-executable-unavailable"`) and for unexpected post-version exceptions (→ `doctor`
   `"doctor-unexpected-error"`), distinguishing the two by whether a `cursor-cli` check was
   already recorded.

**Stable `prerequisite` values (exact):**
- `"cursor-cli"` when the probe did not run because `--version` failed (non-zero/timed-out).
- `"model-catalogue"` when a role check or the probe did not run because catalogue discovery failed.
- `"model-brainstormer"` when catalogue exists but brainstormer exact-model resolution failed.

**Process-abstraction note:**
- Current `spawnCaptured()` rejection path already surfaces Node spawn errors as rejected `Error` objects with optional `code`; this is sufficient for ENOENT/EACCES/EPERM/ENOTDIR classification.
- Do **not** add `SpawnResult` fields or termination redesign in Issue #17.

**Steps:**
- [ ] Isolate `listModels()` in a catalogue-only try/catch and remove the aggregate `resolveProjectModels()` call from the doctor path.
- [ ] Resolve each role exactly once from its own attempt; capture the brainstormer exact ID from the brainstormer role's successful result.
- [ ] Classify `--version` spawn rejection as `cursor-cli` `"cursor-executable-unavailable"` (terminating downstream) and unexpected post-version exceptions as a `doctor` check `"doctor-unexpected-error"`; never emit a duplicate `cursor-cli` check after a successful one.
- [ ] Ensure non-zero/timed-out `--version` is `"cursor-version-check-failure"`, never executable-unavailable; skip catalogue/model checks; emit `prompt-transport-probe` skipped with `prerequisite: "cursor-cli"` (probe not spawned).
- [ ] Emit skipped `model-{role}` checks (`prerequisite: "model-catalogue"`) on catalogue failure instead of `"model-resolution-failure"`.
- [ ] Emit skipped `prompt-transport-probe` only when the probe was not executed; attach the exact prerequisite value.
- [ ] Add deterministic tests: catalogue failure (catalogue `"catalogue-discovery-failure"`; every retained role skipped with `prerequisite: "model-catalogue"`; no role reports resolution attempt; no `"model-resolution-failure"` emitted).
- [ ] Add deterministic tests: valid catalogue + one invalid non-brainstormer role (catalogue `"ok"`; only that role `"model-resolution-failure"`).
- [ ] Add deterministic tests: valid catalogue + invalid brainstormer (catalogue `"ok"`; brainstormer `"model-resolution-failure"`; probe skipped with `prerequisite: "model-brainstormer"`).
- [ ] Add deterministic tests: `--version` non-zero and `--version` timed-out (both `"cursor-version-check-failure"`; probe skipped with `prerequisite: "cursor-cli"`; probe `spawnFn` not invoked; no false model/catalogue/auth/transport classification).
- [ ] Add deterministic tests: `--version` spawn rejection ENOENT/EACCES (`"cursor-executable-unavailable"`; downstream terminated; only `cursor-cli` + `doctor-probe-cleanup` checks; no probe check).
- [ ] Add deterministic test: unexpected post-version error (e.g. `resolveDoctorProbeCwd()` throws after a successful `cursor-cli` check) yields a `doctor` check `"doctor-unexpected-error"` and no duplicate `cursor-cli` check.
- [ ] Add deterministic test: no `"model-resolution-failure"` code appears without an actual `resolveLogicalModelId()` attempt for that role.

---

## Task 5 — Replace hard-coded probe timeout and propagate exact normalized value

**Files:**
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `test/issue17-doctor-probe-timeout.test.ts`
- Modify: `test/compat-doctor.test.ts`
- Modify: `test/ready-review-corrections.test.ts` (probe-timeout propagation asserts `doctorProbeTimeoutMs`)

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
- Skipped prerequisite behavior and `prerequisite` values (`cursor-cli`, `model-catalogue`, `model-brainstormer`).
- `maswe doctor --json` surface: emits full `RuntimeDoctorResult`; exit from `report.ok` in both modes; no persistence/schema claim.
- Corrected probe-success semantics: a passing probe proves only that the command started, stdin was accepted, and the process exited zero within the timeout — not auth classification, output validity, structured decoding, marker validity, or descendant termination.
- Process-tree termination is best-effort and not observable.
- Explicit statement: only the prompt process is bounded (≤300s); the complete `maswe doctor` duration remains unbounded because worktree create/cleanup git operations have no deadline; cleanup timeout hardening remains follow-up.
- Authenticated validation procedure (separate from deterministic tests) uses `maswe doctor --json` to record codes; evidence expectations documented.

**Steps:**
- [ ] Update operator docs with configuration contract and runtime implications.
- [ ] Update architecture docs to reflect doctor typed-code classification and probe-timeout policy.
- [ ] Update artifact/contract docs to avoid overstating unsupported auth/process-termination distinctions.
- [ ] Add changelog entry for Issue #17 behavioral/contract change.

---

## Task 8 — Deterministic validation protocol

**Files:** no new source files; command evidence only.

**Commands already covered by `npm run check`** (`= npm run typecheck && npm test && npm run build`;
`npm test` runs `node --experimental-strip-types --test test/*.test.ts`, which already includes
`test/ready-review-corrections.test.ts` and the Issue #11 contention tests at their default
iteration counts):
- [ ] `npm ci --include=dev --ignore-scripts --no-audit --no-fund`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] `npm run check` (typecheck + full test suite + build; superset of the above)

**Focused runs (subset of the full suite; for fast iteration — not additional coverage):**
- [ ] `node --experimental-strip-types --test test/config.test.ts test/schema.test.ts test/linked-worktree-compat.test.ts`
- [ ] `node --experimental-strip-types --test test/issue17-doctor-probe-timeout.test.ts test/issue17-doctor-cli-json.test.ts test/compat-doctor.test.ts test/merge-blockers-round3.test.ts test/rc-review-corrections.test.ts test/ready-review-corrections.test.ts test/model-resolution.test.ts test/issue12-model-catalogue.test.ts test/issue19-runtime-failure.test.ts`

**Additional CI-only gates (NOT part of `npm run check`; must be run explicitly to match CI):**
- [ ] Focused ready-review regression (CI step "Ready-review regression tests"):
  ```bash
  node --experimental-strip-types --test test/ready-review-corrections.test.ts
  ```
- [ ] Issue #11 allocation contention repetition (CI env-driven; 25 iterations):
  ```bash
  MASWE_ISSUE11_ALLOCATION_ITERATIONS=25 \
  node --experimental-strip-types --test-name-pattern='allocation contention repetition' \
    test/issue11-lock-contention.test.ts
  ```
- [ ] Issue #11 owner/recovery/successor repetition (CI env-driven; 100 iterations):
  ```bash
  MASWE_ISSUE11_RELEASE_ITERATIONS=100 \
  node --experimental-strip-types --test-name-pattern='owner recovery successor repetition' \
    test/issue11-lock-contention.test.ts
  ```

**Packaging validation (must leave no generated artifact in the worktree):**
- [ ] `npm run pack:dry` (= `npm pack --dry-run`; lists contents without creating a tarball).
- [ ] `npm pack --json` **executed in a temporary directory** so the tarball is created outside
  the worktree, e.g.:
  ```bash
  tmp="$(mktemp -d)"; npm pack --json --pack-destination "$tmp"
  tar -tf "$tmp"/*.tgz   # verify expected dist/, schemas/, docs/package files
  rm -rf "$tmp"          # remove tarball + any extraction artifacts
  ```
  If `--pack-destination` is not used, remove the exact generated `.tgz` (and any extraction
  directory) from the worktree immediately after inspection.
- [ ] Confirm no `*.tgz`, extraction directory, or other temporary artifact remains in the worktree.
- [ ] `git diff --check`
- [ ] `git status --porcelain=v1` — must be clean (mechanically achievable because packaging
  artifacts were created outside the worktree or removed).

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
- [ ] Doctor check codes emitted for the run, recorded from `maswe doctor --json` (typed codes read from JSON, never inferred from human output).
- [ ] Cleanup outcome check code and message (from the same `--json` output).
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

## Acceptance traceability matrix (design AC1–AC35)

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
| AC24 | Catalogue failure never masquerades as role-resolution failure | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | On `listModels()` throw: `model-catalogue`=`catalogue-discovery-failure`; every retained `model-{role}`=`skipped-prerequisite-failure`/`model-catalogue`; no `model-resolution-failure` emitted |
| AC25 | Skipped role/probe checks use `prerequisite` attribution | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Skipped checks carry `prerequisite ∈ {cursor-cli, model-catalogue, model-brainstormer}` and do not assert own-subject failure |
| AC26 | `cursor-cli` is a supported `prerequisite` | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | Non-zero/timed-out `--version`: no model/catalogue checks; probe skipped `prerequisite: cursor-cli`; probe not spawned |
| AC27 | Spawn rejection terminates downstream | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | ENOENT/EACCES on `--version`: `cursor-cli`=`cursor-executable-unavailable`; only `cursor-cli`+`doctor-probe-cleanup` emitted |
| AC28 | Valid catalogue + one invalid role stays model-resolution failure | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | `model-catalogue`=`ok`; only failing role=`model-resolution-failure`; brainstormer case skips probe with `prerequisite: model-brainstormer` |
| AC29 | Aggregate `resolveProjectModels()` removed; no cross-catch leakage | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests + code inspection | `listModels()` isolated; each role resolved once; role throw never becomes catalogue failure |
| AC30 | Post-version unexpected error uses generic `doctor` identity | Task 4 | `src/runtimes/cursor-cli.ts` | `test/issue17-doctor-probe-timeout.test.ts` | Focused doctor tests | `resolveDoctorProbeCwd()` throw after `cursor-cli` ok → `doctor`=`doctor-unexpected-error`; no duplicate `cursor-cli` |
| AC31 | `maswe doctor --json` exposes full typed result | Task 3 | `src/cli.ts` | `test/issue17-doctor-cli-json.test.ts` | Focused CLI tests | JSON parses; each check has `name`/`ok`/`message`/`code`(+`prerequisite`); no schema/persistence claim |
| AC32 | JSON and human exit semantics match | Task 3 | `src/cli.ts` | `test/issue17-doctor-cli-json.test.ts` | Focused CLI tests | Exit derived from `report.ok` in both modes; failed report exits non-zero in both |
| AC33 | Exact CI-only gates run and are distinguished from `npm run check` | Task 8 | `.github/workflows/ci.yml` parity (no repo edit) | `test/ready-review-corrections.test.ts`, `test/issue11-lock-contention.test.ts` | Ready-review run; Issue #11 25/100-iter env gates; Node 22 + 22.22.2 | Command transcripts for each gate |
| AC34 | Packaging leaves no generated artifacts | Task 8 | n/a | n/a | `npm pack --json` in temp dir; artifact removed | Final `git status --porcelain=v1` clean; no `.tgz`/extraction dir |
| AC35 | Termination not claimed observable; probe-success not overstated | Tasks 4, 7 | `src/runtimes/cursor-cli.ts`, docs | `test/issue17-doctor-probe-timeout.test.ts` | Focused tests + doc review | No test/doc asserts guaranteed termination or auth/output validity from a passing probe |

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
