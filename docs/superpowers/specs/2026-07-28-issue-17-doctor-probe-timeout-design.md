# Issue 17: Harden Doctor Prompt-Transport Probe Timeout Semantics

## Status

- **Design gate:** `DESIGN_APPROVED_FOR_IMPLEMENTATION_PLANNING`
- **Owner approval of this design occurred before implementation-plan preparation.**
  Implementation remained (and remains) **blocked** pending explicit owner approval of the
  companion implementation plan
  (`docs/superpowers/plans/2026-07-28-issue-17-doctor-probe-timeout.md`,
  status `IMPLEMENTATION_PLAN_REVISED_READY_FOR_APPROVAL`). This document authorizes
  implementation-plan preparation only; it does **not** authorize implementation.
- This document is a design/specification only. No production code, tests, CI, or schema files
  have been modified. The corrected commit that carries this revision is a documentation-only
  plan-review commit.
- **Correction-pass revision (this pass):** A plan-review correction pass removed the residual
  semantic conflations that survived the earlier semantic-precision pass. Specifically: (a) a
  `model-{role}` check that did not execute because catalogue discovery failed is no longer
  classified as `"model-resolution-failure"`; it is a skipped check
  (`"skipped-prerequisite-failure"`, `prerequisite: "model-catalogue"`), and every statement
  saying a catalogue cascade is `"model-resolution-failure"` is removed. (b) `"cursor-cli"` is
  added to the stable prerequisite vocabulary with an exact contract for a failed `--version`
  and for an executable spawn rejection. (c) Post-version unexpected failures now use a stable
  generic `doctor` check identity (`"doctor-unexpected-error"`) instead of a duplicate
  `cursor-cli` check. (d) `maswe doctor --json` is specified as the deterministic surface for
  typed codes, with exact `src/cli.ts` behavior and a named CLI test file; all "if adopted
  here"/"if the CLI surfaces it" hedging is removed. (e) Factual corrections: the real config
  validation flow (`loadConfig()`/`mergeConfigForTest()`, no `loadAndValidateConfig()`), the
  unbounded total-doctor duration, the narrowed probe-success semantics, and best-effort
  (non-observable) process-tree termination. All previously approved timeout default, bounds,
  precedence, canonical-default-placement, compatibility, and cleanup-separation decisions are
  unchanged.
- **Revision summary:** Owner decisions UD1 (typed result codes), UD2 (hard validation bounds),
  and UD3 (cleanup timeout as separate follow-up) are incorporated. Canonical default placement,
  compatibility wording, and acceptance criteria are updated. All three open design questions
  from the original draft are resolved. The follow-up issue proposal for cleanup timeout
  hardening is appended.
- **Semantic-precision revision (this pass):** The typed `DoctorCheckCode` vocabulary is
  corrected to remove predicate conflations. A skipped prompt-transport probe is no longer
  labelled as `"model-resolution-failure"`; it receives a distinct `"skipped-prerequisite-failure"`
  status. Executable *absence* (`"cursor-executable-unavailable"`) is separated from an executable
  that starts and fails its `--version` check (`"cursor-version-check-failure"`). `"auth-failure"`
  and `"process-termination-failure"` are moved to a clearly marked reserved (non-emitted)
  vocabulary because the current Cursor CLI and `spawnCaptured()` interfaces cannot reliably
  classify them. `"probe-malformed-output"` and `"probe-invalid-terminal-marker"` are likewise
  reserved because Issue #17's probe uses `--output-format text` and performs no structured or
  marker parsing (that vocabulary is owned by Issue #16). A master emitted/reserved table with
  one deterministic emission predicate per code is added. All previously approved timeout
  default, bounds, precedence, canonical-default-placement, compatibility, and cleanup-separation
  decisions are unchanged.

---

## Repository baseline

- **Branch:** `main`
- **Exact base SHA:** `277e14483c1d2ad280d67ee3262f3e8ef575e338`
- **Baseline revalidation:** HEAD is confirmed at `277e14483c1d2ad280d67ee3262f3e8ef575e338`
  (unchanged from original design baseline). No relevant files have moved.
- **Relevant files inspected:**
  - `src/cli.ts` — `doctor` CLI entry point and `createRuntime` dispatch
  - `src/config.ts` — `DEFAULT_CONFIG`, `mergeConfig`, `assertConfig`, `migrateConfig`;
    default and validation of `policy.commandTimeoutMs` (600 000 ms),
    `policy.roleTimeoutMs` (1 800 000 ms); `maxRunDurationMs` as example of optional field
    absent from `DEFAULT_CONFIG`; `policy` shallow-merged via `{ ...base.policy, ...value.policy }`
  - `src/domain.ts` — `MasweConfig`, `RuntimeFailureCode` (kebab-case union type),
    `RuntimeDoctorResult` (current shape: `Array<{ name, ok, message }>`)
  - `src/runtimes/cursor-cli.ts` — `CursorCliRuntime.doctor()`,
    `resolveDoctorProbeCwd()`, `cleanupDoctorProbeSafe()`, `listModels()`, `execute()`,
    `safeDiagnosticText()`; confirmed `Math.min(5_000, commandTimeoutMs)` bug at line ~624;
    confirmed check names: `cursor-cli`, `prompt-transport`, `model-catalogue`, `model-{role}`,
    `prompt-transport-probe`, `doctor-probe-cleanup`
  - `src/process.ts` — `spawnCaptured()` including `killProcessTree()`, settlement grace, POSIX
    vs Windows termination
  - `src/git-workspace.ts` — `cleanupDoctorProbeResources()`, `ensureRunWorkspace()`
  - `schemas/config.schema.json` — authoritative config schema; JSON Schema draft 2020-12;
    no `doctorProbeTimeoutMs`; `policy.required` lists `commandTimeoutMs` and `roleTimeoutMs`
    but not `maxRunDurationMs`
  - `test/compat-doctor.test.ts` — basic transport-probe existence check
  - `test/merge-blockers-round3.test.ts` — probe cleanup correctness
  - `test/rc-review-corrections.test.ts` — cleanup failure, exact-model probe selection
  - `test/ready-review-corrections.test.ts` — git-repository probe timeout propagation
- **Validation commands run:**
  ```
  git rev-parse HEAD
  # → 277e14483c1d2ad280d67ee3262f3e8ef575e338
  git merge-base --is-ancestor 277e14483c1d2ad280d67ee3262f3e8ef575e338 HEAD
  # → exit 0 (baseline is an ancestor; HEAD == baseline exactly)
  git status --porcelain
  # → only the untracked design document under docs/superpowers/specs/
  ```
  This semantic-precision revision additionally re-inspected, at the same base SHA:
  - `src/process.ts` — confirmed `killProcessTree()` swallows all kill failures in `catch {}`
    blocks and that `SpawnResult` exposes no termination-failure field, so process-tree kill
    errors are **not observable** by the caller. Confirmed `child.on("error")` rejects the
    promise (so spawn lookup failures such as `ENOENT`/`EACCES` surface as thrown errors), a
    non-zero exit resolves with `exitCode !== 0`, and a timeout resolves with
    `exitCode: 124, timedOut: true`.
  - `src/runtimes/cursor-cli.ts` — reconfirmed the `doctor()` check construction: the skipped
    stdin probe currently pushes `ok: false` with only a message (no code); the `cursor-cli`
    check treats a non-zero `--version` and an outer-catch spawn error identically; the probe
    uses `--output-format text` and asserts only `exitCode === 0 && !timedOut` (no structured or
    marker parsing).
  - `test/compat-doctor.test.ts`, `test/merge-blockers-round3.test.ts`,
    `test/rc-review-corrections.test.ts`, `test/ready-review-corrections.test.ts` — reconfirmed
    that consumers currently switch on `check.name`, `check.ok`, and `check.message` only; none
    assert a `code` field yet. `test/rc-review-corrections.test.ts` constructs a mock runtime
    returning `{ ok: true, checks: [] }` (an empty `checks` array, which needs no `code`).
  No build or test suite was run during this design revision. Documentation-only validation
  was applied (see "Validation performed" in the final response).

---

## Problem statement

### Current behavior

In `CursorCliRuntime.doctor()` (`src/runtimes/cursor-cli.ts:624`), the prompt-transport probe
is spawned with:

```typescript
timeoutMs: Math.min(5_000, this.config.policy.commandTimeoutMs),
```

This clamps the probe deadline to **5 000 ms regardless of configuration**. Even if the operator
has set `policy.commandTimeoutMs` to 600 000 ms, the probe will use at most 5 000 ms.

All other timed operations in the doctor flow use `commandTimeoutMs` without a cap:
- `agent --version`: `commandTimeoutMs` (line 518)
- `agent models`: `commandTimeoutMs` (line 461)

The `execute()` method uses `request.timeoutMs ?? policy.roleTimeoutMs`, which is at least
30 minutes by default — far higher than the probe's effective 5 000 ms.

### Why it is unreliable

Issue #17 records that live Cursor CLI prompt-transport responses on the verified host
(`c59ae22782b865fda32a600440b707db0289da2e`) took approximately 7–14 seconds with a correctly
authenticated account. A 5-second hard cap therefore classifies a healthy, authenticated path as
failed.

The clamp is asymmetric: it applies **only** to the doctor probe, not to production `execute()`
calls. A Cursor installation that passes `maswe doctor` under 5 seconds might be healthy, but
one that reliably responds in 8 seconds will always fail doctor, even though the same invocation
would succeed in a real workflow run.

### Safety and operator impact

- False-positive failures discourage use of `maswe doctor` as a readiness gate.
- Operators cannot distinguish "the Cursor CLI is broken" from "the Cursor CLI is slow" without
  reading source code to discover the hard-coded cap.
- The cap is not documented in `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, or any ADR.
- Because the probe failure propagates to `report.ok === false` and `process.exitCode = 1`, CI
  pipelines treating `maswe doctor` as a gate will block on a healthy installation.

---

## Current-state analysis

### Call flow (verified at base SHA `277e144`)

```text
cli.ts: maswe doctor
  └─ createRuntime(config)            → CursorCliRuntime(config, { cwd })
  └─ runtime.doctor()
       ├─ spawnFn(command, ["--version"], { cwd, timeoutMs: commandTimeoutMs })
       │    → "cursor-cli" check
       ├─ checks.push("prompt-transport" check)   ← always ok; no probe yet
       ├─ listModels()
       │    └─ spawnFn(command, ["models"], { cwd, timeoutMs: commandTimeoutMs })
       │         → "model-catalogue" check (or per-role checks)
       ├─ resolveLogicalModelId() per role         → per-role model checks
       ├─ resolveDoctorProbeCwd()                  → creates ephemeral worktree if configured
       ├─ (if promptTransport === "stdin")
       │    spawnFn(command, probeArgs, {
       │      cwd: probeCwd,
       │      input: "maswe-stdin-probe",
       │      timeoutMs: Math.min(5_000, commandTimeoutMs)   ← BUG
       │    })
       │    → "prompt-transport-probe" check
       └─ finally: cleanupDoctorProbeSafe(probeCwd)
            └─ cleanupDoctorProbeResources(cwd, probeId, worktreePath)
                 ├─ git worktree remove --force <path>
                 └─ git branch -D maswe/<probeId>
            → "doctor-probe-cleanup" check
```

### Timeout sources (verified)

| Operation | Timeout used | Source |
|---|---|---|
| `agent --version` | `commandTimeoutMs` | `cursor-cli.ts:518` |
| `agent models` | `commandTimeoutMs` | `cursor-cli.ts:461` |
| prompt-transport probe | `Math.min(5_000, commandTimeoutMs)` | `cursor-cli.ts:624` ← BUG |
| `execute()` role run | `request.timeoutMs ?? roleTimeoutMs` | `cursor-cli.ts:345` |
| probe cleanup (git) | **none** | `git-workspace.ts:cleanupDoctorProbeResources` |

**Discrepancy from issue wording:** The issue states "a fixed 5-second timeout." The code is
`Math.min(5_000, commandTimeoutMs)`. If an operator sets `commandTimeoutMs` below 5 000 ms, the
probe uses that lower value — so the effective floor is actually `commandTimeoutMs`. However, the
default `commandTimeoutMs` is 600 000 ms, so the effective probe limit is always 5 000 ms under
the default configuration, confirming the issue report.

### Failure boundaries (current)

| Scenario | Check name(s) affected | Typed code? |
|---|---|---|
| `agent` executable missing or spawn error | "cursor-cli" (caught outer try) | None |
| `agent --version` non-zero | "cursor-cli" ok=false | None |
| `agent --version` timed out | "cursor-cli" ok=false | None |
| `agent models` failure | "model-catalogue" ok=false | None |
| Catalogue malformed rows | "model-catalogue" ok=false | None |
| Empty catalogue | "model-catalogue" ok=false | None |
| Per-role model resolution failure | "model-{role}" ok=false | None |
| Probe skipped (model resolution failed) | "prompt-transport-probe" ok=false | Hard string |
| Probe exit non-zero | "prompt-transport-probe" ok=false, message has exit code | None |
| Probe timed out | "prompt-transport-probe" ok=false, message has ", timed out" | None |
| Probe malformed output (text mode) | Not detected; text mode returns raw stdout; no content check | — |
| Worktree cleanup failed | "doctor-probe-cleanup" ok=false | None |
| Branch cleanup failed | "doctor-probe-cleanup" ok=false | None |

**Critical gaps:** There is no typed failure code for any doctor check — the typed
`RuntimeFailureCode` union is used only by `execute()`, not by `doctor()`. Authentication failure
is indistinguishable from a non-zero probe exit or timeout in the current check output. The
`RuntimeDoctorResult` schema carries only `{ name, ok, message }` per check; machine-readable
failure discrimination requires pattern-matching the human-readable `message` string, which is
not a stable contract.

### Cleanup behavior (current)

`cleanupDoctorProbeResources()` (`git-workspace.ts`):
1. `git worktree remove --force <worktreePath>` — if it fails, checks whether the directory is
   still a worktree; if yes, throws; if no, proceeds.
2. `rm -rf` the directory if it still exists (best-effort, ignores errors).
3. `git branch -D maswe/<probeId>` — if it fails, checks `git rev-parse --verify`; if branch
   still exists, throws.
4. **No timeout on any of these git commands.** A stalled NFS or locked git repository could
   cause `doctor()` to hang indefinitely in `finally`.

`cleanupDoctorProbeSafe()` wraps cleanup in a try/catch and returns a check result; it **never
throws**, so a cleanup failure does not prevent `doctor()` from returning, but it does add an
`ok: false` check.

### Test coverage (verified by inspection)

| Scenario | Test file | Covered? |
|---|---|---|
| Transport-probe check exists | `compat-doctor.test.ts` | ✓ |
| Cleanup removes worktree + branch | `merge-blockers-round3.test.ts` | ✓ |
| Cleanup failure visible as check | `rc-review-corrections.test.ts` | ✓ |
| Probe uses resolved exact model | `rc-review-corrections.test.ts` | ✓ |
| Default timeout selection for probe | — | ✗ |
| Configured timeout selection for probe | — | ✗ |
| Timeout precedence rules | — | ✗ |
| Response just before deadline | — | ✗ |
| Response just after deadline | — | ✗ |
| Hung child process cleanup | — | ✗ |
| Probe timeout → cleanup succeeds | — | ✗ |
| Probe timeout → cleanup fails | — | ✗ |
| Authentication failure before timeout | — | ✗ |
| Malformed output within timeout | — | ✗ |
| Zero leaked process/worktree/branch | — | ✗ (inferred from cleanup test) |

---

## Design goals and non-goals

### Goals

1. Replace the hard-coded `Math.min(5_000, commandTimeoutMs)` with an explicit, configurable,
   validated, and documented timeout contract.
2. Preserve fail-closed semantics: a timed-out probe is a failure, never a success.
3. Preserve process-tree and resource cleanup behaviour; do not weaken it to accommodate a
   longer timeout.
4. Add a stable, machine-readable `code` field to every doctor check result, enabling typed
   assertions in tests and CI consumers without message-text pattern matching.
5. Provide deterministic regression tests for every timeout-selection path; tests assert
   typed codes rather than message substrings except where message quality is itself under test.
6. Apply hard bounds validation in `assertConfig()`: reject every invalid value at load time.
7. Place the default timeout (`60_000` ms) in `DEFAULT_CONFIG` so the effective runtime value is
   always normalized before it reaches call sites.
8. Document the probe's guarantees and limitations in `docs/OPERATIONS.md`.
9. State the precise compatibility behavior: this is an intentional runtime behavior change
   to the default timeout.

### Non-goals

1. Make the probe unbounded or indefinitely retried.
2. Weaken catalogue completeness or exact-model validation.
3. Treat a timed-out probe as a successful readiness signal.
4. Add retry logic to the probe.
5. Refactor the general `execute()` timeout policy (out of scope; not tracked by Issue #16 —
   see traceability section for Issue #16's actual scope).
6. Modify the authenticated-smoke worktree lifecycle (Issue #18 scope).
7. Add SIGTERM-before-SIGKILL graceful termination to `spawnCaptured()` (would affect all
   callers; out of scope for this issue).
8. Add a timeout around `cleanupDoctorProbeResources()` (tracked as a separate follow-up —
   see "Cleanup Timeout Follow-up Proposal" section).
9. Add a total `maswe doctor` wall-clock deadline (separate follow-up).
10. Implement authenticated CI smoke tests (these are a separate validation procedure).

---

## Options considered

### Option A: Derive probe timeout from `commandTimeoutMs` (remove the cap entirely)

Use `commandTimeoutMs` directly for the probe, matching how `--version` and `models` are timed:

```typescript
timeoutMs: this.config.policy.commandTimeoutMs,
```

**Trade-offs:**
- Simplest change; zero new configuration surface.
- Probe timeout is automatically consistent with other command timeouts.
- Operators who have set `commandTimeoutMs` to a reasonable value (e.g., 60 000 ms) get a
  sensible probe timeout with no migration.
- **Risk:** `commandTimeoutMs` governs short-lived commands (`--version`, `models`). The probe
  is the first operation that sends a live prompt to the language model, which has very different
  latency characteristics. Using the same field conflates two different timeout domains.
- `commandTimeoutMs` defaults to 600 000 ms (10 minutes), which is far more permissive than
  necessary for a doctor probe and could cause long hangs in a degraded state.

### Option B: Introduce `policy.doctorProbeTimeoutMs` with a validated default and bounds

Add a dedicated `doctorProbeTimeoutMs` field to `policy`. Place the default in `DEFAULT_CONFIG`
so the field is always present after `migrateConfig()`; validate bounds in `assertConfig()`.

```typescript
timeoutMs: this.config.policy.doctorProbeTimeoutMs,  // always defined via DEFAULT_CONFIG
```

**Note:** The original draft described this as `?? 60_000` at the call site. Per the owner's
canonical-default-placement decision, the default is instead placed in `DEFAULT_CONFIG` so the
field is always defined after normalization and no call-site fallback is needed. See "Proposed
contract" for the final specification.

**Trade-offs:**
- Explicit contract; operator can tune the probe independently of command and role timeouts.
- The field name makes its purpose unambiguous in config and documentation.
- Adds one field to `MasweConfig`, `domain.ts`, `config.ts` (`DEFAULT_CONFIG`, `assertConfig`),
  and `schemas/config.schema.json`.
- Field is optional in raw user config (not in `policy.required`); existing configs without it
  receive the default via `DEFAULT_CONFIG` merge.
- **Risk:** Operators must discover a third timeout field. However, `OPERATIONS.md` can direct
  them to it clearly.
- The default of 60 000 ms safely covers observed 7–14 second latencies with a 4× margin,
  while remaining bounded and finite.

### Option C: Derive probe timeout from `roleTimeoutMs`

Mirror the `execute()` path:

```typescript
timeoutMs: this.config.policy.roleTimeoutMs,
```

**Trade-offs:**
- Semantically the closest match to actual Cursor prompt-transport work.
- `roleTimeoutMs` defaults to 1 800 000 ms (30 minutes), which is far too permissive for a
  quick readiness check. A stalled Cursor process could hold `doctor()` for 30 minutes.
- Conflates a readiness-check probe with a full workflow role execution.
- **Rejected.** The default is unreasonably long for a diagnostic probe.

### Option D: Keep the cap but make the cap configurable

Keep `Math.min(<cap>, commandTimeoutMs)` but add an operator-settable `doctorProbeCap`:

```typescript
timeoutMs: Math.min(config.policy.doctorProbeCap ?? 60_000, commandTimeoutMs),
```

**Trade-offs:**
- Preserves the `Math.min` defensive structure.
- `commandTimeoutMs` still acts as a ceiling, which is not obviously useful and adds confusion.
- The `Math.min` with `commandTimeoutMs` still allows a very small `commandTimeoutMs` to
  override the cap in unexpected ways.
- **Rejected.** The two-floor structure adds complexity without clarity.

---

## Proposed contract

### Timeout precedence

```text
Effective probe timeout =
    config.policy.doctorProbeTimeoutMs
    (always a validated integer in [1_000, 300_000], set to 60_000 by DEFAULT_CONFIG
     when the operator does not supply the field)
```

The effective probe timeout is a normalized, always-defined `number` on the merged config
object. Runtime code reads `this.config.policy.doctorProbeTimeoutMs` directly. There is no
`?? 60_000` at the call site.

The probe timeout is **independent** of `commandTimeoutMs` and `roleTimeoutMs`. It is not
derived from either. The probe timeout is the total wall-clock budget from the moment
`spawnFn` is called until either a `close` event is received or the settlement grace period
expires.

### Bounds

| Bound | Value | Rationale |
|---|---|---|
| Minimum | 1 000 ms | Prevents trivially short budgets that would always time out |
| Maximum | 300 000 ms (5 minutes) | Keeps the prompt-probe process deadline finite; the complete doctor command remains unbounded because probe-worktree creation and cleanup have no independent deadlines. |
| Default | 60 000 ms | 4× margin over the 14-second upper bound observed in issue evidence |

`assertConfig()` applies these as **hard validation constraints**. The following all constitute
configuration errors that must be rejected at load time:

| Invalid value | Rejection reason |
|---|---|
| Below 1 000 ms | Less than minimum |
| Above 300 000 ms | Exceeds maximum |
| Zero | Less than minimum (also non-positive) |
| Negative | Less than minimum |
| Non-integer (e.g., `1.5`) | Must be an integer |
| Non-finite (NaN, Infinity, -Infinity) | Must be finite |
| Non-number type (e.g., `"60000"`) | Must be a number |
| Malformed in JSON (e.g., `"60_000"`) | JSON schema type mismatch |

**No advisory warnings, silent clamping, or fallback to the default** when the operator
explicitly supplies an invalid value. The operator must correct the configuration before the
tool can run.

**Expected validation error:** `assertConfig()` throws a descriptive `Error` with the message:
```text
policy.doctorProbeTimeoutMs must be an integer between 1000 and 300000
```

**Configuration validation flow (actual, verified at base SHA):**

| Function | Behavior |
|---|---|
| `migrateConfig(raw)` | Starts from `cloneDefaults()`, applies defaults and shallow-merges the raw config. Returns a normalized `MasweConfig`. **Does not validate** (never calls `assertConfig()`). |
| `mergeConfig(raw)` | Returns `applyEnvironment(migrateConfig(raw))` — applies environment overrides. **Does not call `assertConfig()`.** |
| `loadConfig(cwd, explicitPath?)` | Reads the project config file, calls `mergeConfig(raw)`, and **then calls `assertConfig()`**. This is the CLI load path (`src/cli.ts` `doctor`/`start`). |
| `mergeConfigForTest(raw)` | Calls `migrateConfig(raw)` and **then calls `assertConfig()`**. This is the test/helper path. |

Therefore `doctorProbeTimeoutMs` validation runs wherever `assertConfig()` runs: through
`loadConfig()` on the real CLI path and through `mergeConfigForTest()` on the test path.
`mergeConfig()` alone does **not** validate. There is **no** `loadAndValidateConfig()` function
in the codebase; do not reference one. The raw JSON schema (`schemas/config.schema.json`)
independently enforces `type: integer`, `minimum: 1000`, and `maximum: 300000` for tools that
run schema validation before TypeScript execution.

### Canonical default placement

`DEFAULT_CONFIG` in `src/config.ts` **must** include `doctorProbeTimeoutMs: 60_000` explicitly:

```typescript
policy: {
  // ... existing fields ...
  doctorProbeTimeoutMs: 60_000,
}
```

The `migrateConfig()` function starts from `cloneDefaults()` and shallow-merges the user
`policy` object via `{ ...base.policy, ...(value.policy ?? {}) }`. When the user does not
supply `doctorProbeTimeoutMs`, the base default `60_000` survives the merge. When the user
does supply it, their value replaces the default. `assertConfig()` then validates whatever
value is present.

**Interaction with partial policy objects:** A user config that specifies only
`policy.commandTimeoutMs` will still receive `doctorProbeTimeoutMs: 60_000` from the shallow
merge, because the spread preserves all un-overridden fields from `base.policy`. This is
consistent with the behavior of `commandTimeoutMs` and `roleTimeoutMs`.

**TypeScript type:** `MasweConfig.policy.doctorProbeTimeoutMs` must be declared as `number`
(non-optional) in `src/domain.ts`, because after `migrateConfig()` the field is always present.
The field is optional in the JSON schema (`policy.required` does not include it) because users
are not required to specify it in their config files.

### Deadline coverage

The probe timeout is the wall-clock budget for the probe **process**; whatever the Cursor CLI
does inside that window (any authentication handshake, any internal catalogue re-check, prompt
transport of `maswe-stdin-probe`, model response round trip, and reading text output) all shares
the single budget. Issue #17's probe does **not** parse or validate that output — it reads text
and inspects only the exit code and timeout state. The budget therefore bounds the elapsed time
of the invocation; it does **not** imply the probe verifies any of those internal steps
succeeded (see "Misleading readiness risk").

The probe timeout does **not** cover:
- Worktree or branch creation (`resolveDoctorProbeCwd()`) — these use existing git operations
  without a new deadline (acknowledged gap; tracked in cleanup follow-up)
- Worktree and branch cleanup (`cleanupDoctorProbeResources()`) — see below

### Scope statement: Issue #17 deadline bounds the prompt-transport invocation only

> The Issue #17 deadline bounds the prompt-transport invocation. It does not establish a strict
> upper bound for the complete `maswe doctor` command because the existing resource-cleanup
> phase has no independent timeout.

Issue #17 does not add:

- a timeout around `cleanupDoctorProbeResources()`;
- SIGTERM-before-SIGKILL escalation;
- a total `maswe doctor` wall-clock deadline;
- new cleanup cancellation infrastructure.

A dedicated follow-up issue is proposed to track cleanup timeout hardening. See
"Cleanup Timeout Follow-up Proposal" below.

### Typed result codes

**Owner decision UD1 applies:** message-text pattern matching is not an acceptable
machine-readable contract. A stable, typed `code` field is required on every doctor check
result. See the "Typed Code Contract" section below for the full vocabulary and mapping.

### Multiple-failure representation

When the probe fails AND cleanup also fails, both failures are preserved as independent checks
with independent codes:

- `report.checks` contains `"prompt-transport-probe" ok=false, code: "probe-transport-timeout"`
  AND `"doctor-probe-cleanup" ok=false, code: "cleanup-failure"`.
- `report.ok === false` (any failed check causes this).
- No failure suppresses, aggregates, or overwrites another.
- The primary probe failure and the cleanup failure are separately visible to all consumers.

---

## Typed Code Contract

### Type definition

Following the existing `RuntimeFailureCode` pattern (kebab-case string literal union;
no TypeScript enums — see `docs/DEVELOPMENT.md` re: strip-types constraint):

```typescript
export type DoctorCheckCode =
  // ── Emitted by Issue #17 (each has a deterministic current predicate) ──
  | "ok"
  | "cursor-executable-unavailable"
  | "cursor-version-check-failure"
  | "catalogue-discovery-failure"
  | "model-resolution-failure"
  | "skipped-prerequisite-failure"
  | "probe-invocation-failure"
  | "probe-transport-timeout"
  | "cleanup-failure"
  | "doctor-unexpected-error"
  | "cursor-sdk-credential-missing"
  | "cursor-sdk-unavailable"
  // ── Reserved for forward compatibility; NOT emitted by Issue #17 ──
  | "auth-failure"
  | "process-termination-failure"
  | "probe-malformed-output"
  | "probe-invalid-terminal-marker";
```

The union has **16 members: 12 emitted by Issue #17 and 4 reserved**. Reserved members are
retained in the type so that a future issue can begin emitting them without a breaking
vocabulary change, but Issue #17 must never construct a check with a reserved code. The
authoritative per-code emission contract is the "Emitted vs. reserved code table" below.

**Naming rationale:** Uses the same kebab-case string literal convention as `RuntimeFailureCode`
(`cursor-cli-non-zero`, `cursor-cli-timeout`, etc.) in `src/domain.ts`. Prefixed by domain
area rather than check name to allow multiple checks to share vocabulary entries and to remain
stable if check names change.

### Updated `RuntimeDoctorResult`

```typescript
export type DoctorCheckPrerequisite =
  | "cursor-cli"
  | "model-catalogue"
  | "model-brainstormer";

export interface RuntimeDoctorResult {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
    code: DoctorCheckCode;
    /**
     * Present only on a check that did not execute because an earlier
     * prerequisite check failed. Names the prerequisite check that caused the
     * skip (one of "cursor-cli", "model-catalogue", or "model-brainstormer").
     * Absent on every check that actually executed.
     */
    prerequisite?: DoctorCheckPrerequisite;
  }>;
}
```

Making `code` a required (non-optional) field provides compile-time exhaustiveness: every code
path in `doctor()` that constructs a check object must supply a code. TypeScript will fail to
compile any check literal that omits `code`.

#### Skipped-check execution-state decision

A check that did not execute is represented as a skipped check. In Issue #17 the skipped checks
are: (a) each `model-{role}` check when `model-catalogue` failed, and (b) the stdin
`prompt-transport-probe` when `cursor-cli`, `model-catalogue`, or the brainstormer role failed
before it. Each skipped check is represented as follows:

- `ok: false` — doctor readiness for that path was **not** established, so `report.ok` must be
  `false`. A skipped check is not a pass.
- `code: "skipped-prerequisite-failure"` — this is the signal that distinguishes "did not run"
  from "ran and failed". No separate boolean `executed`/`ran` field is added. The `code` field
  already carries the execution state precisely, so **the smallest correct model change is to
  reuse `code` rather than introduce a parallel execution-state flag.**
- `prerequisite?: DoctorCheckPrerequisite` — an optional field naming the prerequisite check that
  caused the skip, retaining enough structured information for machine consumers to attribute the
  skip without message parsing. It is optional, so existing check literals that always execute
  are unaffected and no consumer is forced to read it.

A skipped check message **must not** assert that prompt transport, authentication, model
resolution, or catalogue discovery independently failed. It states only that the probe was not
executed and names the failed prerequisite (e.g.,
`"stdin prompt probe not executed: prerequisite check 'model-brainstormer' failed."`). The
prerequisite's own failed check (e.g., `model-brainstormer` with
`code: "model-resolution-failure"`) remains separately present and carries the real cause.

**Compatibility of this model change:** adding the required `code` field is a compile-time
breaking change for any code that *constructs* a non-empty `RuntimeDoctorResult` check literal
(the runtime adapters `src/runtimes/cursor-cli.ts`, `src/runtimes/mock.ts`, and
`src/runtimes/cursor-sdk.ts`); it is additive for consumers that only *read* checks
(`src/cli.ts`). Test stubs that return `{ ok: true, checks: [] }` (an empty `checks` array) or
delegate to another runtime's `doctor()` construct no non-empty check literal and require no
change.
Adding the optional `prerequisite` field is fully additive and breaks nothing. `RuntimeDoctorResult`
is an in-process TypeScript interface only; it is not serialized to any schema, so there is no
wire-format or persisted-artifact break.

### Code vocabulary

Emitted codes (Issue #17 constructs checks with these):

| Code | Meaning |
|---|---|
| `"ok"` | The check passed. The probe or resource-check it represents succeeded. |
| `"cursor-executable-unavailable"` | The configured `agent` executable could **not be started**: a deterministic OS-level lookup or spawn failure (executable-not-found / `ENOENT`, permission-denied-at-spawn / `EACCES`/`EPERM`, or `ENOTDIR`). This establishes the command cannot run at all. It is **not** inferred from any non-zero exit. |
| `"cursor-version-check-failure"` | The `agent` executable **started** but its `--version` check did not succeed: it exited non-zero, or it timed out (`timedOut === true`). The executable exists and is runnable; the version check itself failed. |
| `"catalogue-discovery-failure"` | The model catalogue (`agent models`) could not be retrieved or was malformed. |
| `"model-resolution-failure"` | A configured logical model ID could not be resolved to a catalogue ID because `resolveLogicalModelId()` **actually ran for that role and threw**. Emitted **only** by a `model-{role}` check that attempted resolution. A `model-{role}` check that did **not** execute (because catalogue discovery failed first) is never `"model-resolution-failure"`; it is `"skipped-prerequisite-failure"` with `prerequisite: "model-catalogue"`. |
| `"skipped-prerequisite-failure"` | A check **did not execute** because an earlier prerequisite check failed. Currently emitted by `model-{role}` checks (when `model-catalogue` failed) and by `prompt-transport-probe` (when `cursor-cli`, `model-catalogue`, or a specific `model-{role}` failed). This is not a failure of the skipped check's own subject; it records only that the check was not run and (via `prerequisite`) which check blocked it. |
| `"probe-invocation-failure"` | The prompt-transport probe process **started and exited non-zero without timing out** (`exitCode !== 0 && !timedOut`). This is the fallback for a generic non-zero probe exit, including authentication failures that the Cursor CLI does not expose as a distinct machine-readable discriminator. |
| `"probe-transport-timeout"` | The prompt-transport probe did not complete within `doctorProbeTimeoutMs` (`timedOut === true`). |
| `"cleanup-failure"` | Worktree removal, branch deletion, or temporary resource cleanup failed in `cleanupDoctorProbeResources()`. |
| `"doctor-unexpected-error"` | The `doctor()` flow threw an unexpected exception **after** the `cursor-cli` version check completed (e.g., a git error from `resolveDoctorProbeCwd()` or an unforeseen process-layer exception reaching the outer `catch`), **or** a pre-cursor-cli-check spawn rejection whose error code is not in the known executable-unavailability set (`ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`). It is emitted on a stable generic **`doctor`** check — never as a second `cursor-cli` check — and honestly signals that the doctor flow aborted without asserting which specific component was at fault. |
| `"cursor-sdk-credential-missing"` | The `CursorSdkRuntime` detected that the `CURSOR_API_KEY` environment variable is absent. The API key configuration is missing; key *presence* does not prove authentication success, and absence is not `"auth-failure"`. Emitted on the `cursor-api-key` check. |
| `"cursor-sdk-unavailable"` | The `CursorSdkRuntime` detected that `@cursor/sdk` could not be imported (the dynamic `import()` threw). This is a package-availability failure, not an executable lookup failure; it is not `"cursor-executable-unavailable"`. Emitted on the `cursor-sdk` check. |

Reserved codes (defined for forward compatibility; **Issue #17 must not emit any of these**):

| Code | Reserved because | Future owner |
|---|---|---|
| `"auth-failure"` | The Cursor CLI does not expose a reliable, machine-readable authentication discriminator; auth failures currently present as generic non-zero probe exits and are emitted as `"probe-invocation-failure"`. | A future issue that adopts a tested, stable provider auth contract. |
| `"process-termination-failure"` | `spawnCaptured()`/`killProcessTree()` swallow all kill errors and `SpawnResult` exposes no termination-failure field, so a failed process-tree kill is **not observable** by the caller. | The cleanup / process-lifecycle follow-up (see "Cleanup Timeout Follow-up Proposal"). |
| `"probe-malformed-output"` | Issue #17's probe uses `--output-format text` and asserts only `exitCode === 0 && !timedOut`; it performs no structured-output parsing, so there is no current predicate. | Issue #16 (output-shape / marker-failure codes). |
| `"probe-invalid-terminal-marker"` | Same as above — no terminal-marker contract is validated by Issue #17's probe. | Issue #16 (marker-failure codes). |

### Authentication failure note

**Issue #17 does not emit `"auth-failure"`.** The Cursor CLI does not currently expose a typed,
machine-readable authentication discriminator over its exit interface or structured output.
Authentication failures present as generic non-zero exits from the probe and are therefore
classified as `"probe-invocation-failure"` — the honest fallback for an undistinguished non-zero
probe exit.

Required evidence before `"auth-failure"` may ever be emitted (by a future issue, not #17):

- A stable, provider-supported machine-readable signal — a documented authentication-specific
  exit code, or a documented structured-output field — that the repository explicitly accepts
  and covers with tests as a provider contract.

That evidence does **not** currently exist. Consequently:

- `"auth-failure"` is retained only in the reserved (non-emitted) vocabulary section.
- **Message-text heuristics alone must never produce `"auth-failure"`.** Matching human-readable
  CLI phrases (e.g., "unauthorized", "login") is explicitly disallowed as a classification basis
  unless and until the repository adopts and tests a stable provider contract. Human-readable
  messages are not a contract and can change without notice.

Tests must not assert authentication classification from message substrings, and Issue #17 must
not claim any authentication-classification capability the Cursor CLI interface does not support.

### Check-to-code mapping

Every row below has exactly one code and the predicates are mutually exclusive, so any single
concrete doctor execution outcome maps deterministically.

| Check name | Condition | Code | `prerequisite` |
|---|---|---|---|
| `cursor-cli` | `--version` exits 0 | `"ok"` | — |
| `cursor-cli` | `--version` process starts but exits non-zero (`exitCode !== 0 && !timedOut`) | `"cursor-version-check-failure"` | — |
| `cursor-cli` | `--version` starts but times out (`timedOut === true`, `exitCode === 124`) | `"cursor-version-check-failure"` | — |
| `cursor-cli` | `--version` spawn rejected with lookup/permission error (`ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`) — executable cannot be started | `"cursor-executable-unavailable"` | — |
| `doctor` | Unexpected exception **after** a completed `cursor-cli` version check (e.g., `resolveDoctorProbeCwd()` git error) reaches the outer catch, **or** a pre-cursor-cli-check spawn rejection with a non-executable-unavailability error code | `"doctor-unexpected-error"` | — |
| `prompt-transport` | Always pushed as informational ok | `"ok"` | — |
| `model-catalogue` | `listModels()` succeeds | `"ok"` | — |
| `model-catalogue` | `listModels()` throws | `"catalogue-discovery-failure"` | — |
| `model-{role}` | `resolveLogicalModelId()` ran for this role and succeeded | `"ok"` | — |
| `model-{role}` | `resolveLogicalModelId()` ran for this role and threw | `"model-resolution-failure"` | — |
| `model-{role}` | Did **not** execute because `model-catalogue` failed | `"skipped-prerequisite-failure"` | `"model-catalogue"` |
| `prompt-transport-probe` | Not executed because `cursor-cli` (`--version`) failed | `"skipped-prerequisite-failure"` | `"cursor-cli"` |
| `prompt-transport-probe` | Not executed because `model-catalogue` failed | `"skipped-prerequisite-failure"` | `"model-catalogue"` |
| `prompt-transport-probe` | Not executed because the brainstormer role resolution failed | `"skipped-prerequisite-failure"` | `"model-brainstormer"` |
| `prompt-transport-probe` | probe exits 0 and `!timedOut` | `"ok"` | — |
| `prompt-transport-probe` | `timedOut === true` | `"probe-transport-timeout"` | — |
| `prompt-transport-probe` | `exitCode !== 0 && !timedOut` (includes undistinguished auth failures) | `"probe-invocation-failure"` | — |
| `doctor-probe-cleanup` | All cleanup succeeded | `"ok"` | — |
| `doctor-probe-cleanup` | Any cleanup step failed | `"cleanup-failure"` | — |
| `cursor-api-key` (`CursorSdkRuntime`) | `CURSOR_API_KEY` is present | `"ok"` | — |
| `cursor-api-key` (`CursorSdkRuntime`) | `CURSOR_API_KEY` is absent | `"cursor-sdk-credential-missing"` | — |
| `cursor-sdk` (`CursorSdkRuntime`) | `@cursor/sdk` imports successfully | `"ok"` | — |
| `cursor-sdk` (`CursorSdkRuntime`) | importing `@cursor/sdk` throws | `"cursor-sdk-unavailable"` | — |

**Note on `"cursor-cli"` outcomes:** A non-zero `--version` exit and a `--version` timeout both
mean the executable *started* — they map to `"cursor-version-check-failure"`, never to
`"cursor-executable-unavailable"`. Unavailability is asserted **only** when the OS could not
start the `--version` process at all (spawn rejection with a lookup/permission error code). The
message string may include timing or exit detail; classification does not depend on message text.

**Note on `model-{role}` classification:** `"model-resolution-failure"` is emitted **only** when
`resolveLogicalModelId()` actually ran for that role and threw. A `model-{role}` check that did
not execute because catalogue discovery failed first is a **skipped** check
(`"skipped-prerequisite-failure"`, `prerequisite: "model-catalogue"`), never
`"model-resolution-failure"`. There is no "cascade" classification: a role check that never ran
cannot report a resolution failure.

**Note on `doctor` (unexpected error) identity:** An unexpected exception that surfaces **after**
the `cursor-cli` version check completed (for example, a git error thrown by
`resolveDoctorProbeCwd()`) is attached to a stable generic `doctor` check with
`"doctor-unexpected-error"` — **not** to a second `cursor-cli` check. The doctor flow must never
emit a duplicate failed `cursor-cli` check after a successful `cursor-cli` check. Only a failure
of the `--version` spawn itself (before any `cursor-cli` check is recorded) is attributed to
`cursor-cli` (`"cursor-executable-unavailable"`).

**Note on probe output validation:** Issue #17's probe uses `--output-format text` and asserts
only `exitCode === 0 && !timedOut`. It performs no structured-output or terminal-marker parsing,
so it never emits `"probe-malformed-output"` or `"probe-invalid-terminal-marker"` (reserved for
Issue #16). A probe that starts and exits non-zero — for any reason the CLI does not distinguish,
including authentication — maps to `"probe-invocation-failure"`.

### Stable prerequisite vocabulary

The `prerequisite` field, when present on a skipped check, names one of the following stable
prerequisite check identities. This vocabulary is stable and must be used exactly:

| `prerequisite` value | Meaning |
|---|---|
| `"cursor-cli"` | The `agent --version` check failed, so no catalogue/model/probe work was performed. |
| `"model-catalogue"` | Catalogue discovery (`listModels()`) failed, so role resolution and the probe did not run. |
| `"model-brainstormer"` | Catalogue succeeded but the brainstormer role's exact-model resolution failed, so the prompt probe (which needs the resolved brainstormer model) did not run. |

**Executable spawn-rejection contract (exact):** When the `agent --version` **spawn itself is
rejected** (`ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`), the doctor flow records the `cursor-cli`
check with `"cursor-executable-unavailable"` and **terminates the downstream check sequence**:
no `model-catalogue`, `model-{role}`, or `prompt-transport-probe` checks are emitted (the
exception propagates directly to the outer catch, skipping the catalogue and probe blocks). The
`doctor-probe-cleanup` check from the `finally` block is still emitted. This is the chosen
contract; it matches the current control flow, where a thrown `--version` spawn error bypasses
all downstream check construction. A skipped `prompt-transport-probe` with
`prerequisite: "cursor-cli"` is emitted **only** in the distinct case where `--version`
*started* and returned a non-zero/timed-out result (`cliOk === false`) — there the flow
continues, skips the `if (cliOk)` catalogue/model block, and reaches the probe block, which
records the skipped probe.

**Pre-version outer-catch classification (exact):** The outer `catch` of `doctor()` handles two
distinct cases depending on whether a `cursor-cli` check has already been recorded:

- **Before any `cursor-cli` check exists** (i.e., the `--version` spawn was rejected before the
  check was pushed):
  - If the rejection error has `error.code ∈ { "ENOENT", "EACCES", "EPERM", "ENOTDIR" }`:
    emit a `cursor-cli` check with `code: "cursor-executable-unavailable"`; terminate downstream.
  - For any other thrown value — including a rejection whose `error.code` is unknown (e.g.,
    `"EMFILE"`, `"ENOMEM"`), a plain `Error` without a `code`, or a non-`Error` rejection:
    emit a **`doctor`** check with `code: "doctor-unexpected-error"`; terminate downstream.
    Never emit a `cursor-cli` check for these cases.
- **After a `cursor-cli` check already exists** (version check completed or failed, and
  subsequent code threw unexpectedly):
  - Emit a **`doctor`** check with `code: "doctor-unexpected-error"`.
  - Never emit a second `cursor-cli` check.

In all outer-catch paths, downstream execution terminates (no further catalogue/model/probe
checks are pushed), cleanup is still reported via `finally`, and no duplicate `cursor-cli` check
is emitted.

### Emitted vs. reserved code table

This is the authoritative mapping. Each code has one owning check and one unambiguous emission
condition. Given one concrete doctor execution outcome, exactly one code applies per check.

| Code | Owning check | Exact emission condition | Emitted by Issue #17? | Notes |
|---|---|---|---|---|
| `"ok"` | any check | The check executed and passed | Yes | Success. |
| `"cursor-executable-unavailable"` | `cursor-cli` | Outer catch before `cursor-cli` check exists: spawn rejected with `ENOENT`/`EACCES`/`EPERM`/`ENOTDIR` | Yes | Never inferred from a non-zero exit. |
| `"cursor-version-check-failure"` | `cursor-cli` | Process started but `--version` exited non-zero **or** timed out | Yes | Executable is runnable; version check failed. |
| `"catalogue-discovery-failure"` | `model-catalogue` | `listModels()` threw (catalogue unavailable or malformed) | Yes | — |
| `"model-resolution-failure"` | `model-{role}` | `resolveLogicalModelId()` ran for this role and threw | Yes | Emitted **only** by a role check that attempted resolution. A role check skipped because catalogue discovery failed is `"skipped-prerequisite-failure"`, never this code. |
| `"skipped-prerequisite-failure"` | `model-{role}`, `prompt-transport-probe` | The check did not execute because a prerequisite check failed | Yes | `ok: false`; `prerequisite` names the blocking check (`"cursor-cli"`, `"model-catalogue"`, or `"model-brainstormer"`). Does not assert the skipped check's subject failed. |
| `"probe-invocation-failure"` | `prompt-transport-probe` | Probe started and exited non-zero without timing out | Yes | Fallback for undistinguished non-zero exit, including auth. |
| `"probe-transport-timeout"` | `prompt-transport-probe` | Probe did not complete within `doctorProbeTimeoutMs` (`timedOut === true`) | Yes | Message includes the effective timeout in ms. |
| `"cleanup-failure"` | `doctor-probe-cleanup` | `cleanupDoctorProbeResources()` threw | Yes | Preserved independently of the probe result. |
| `"doctor-unexpected-error"` | `doctor` | Outer catch before `cursor-cli` check exists with a non-executable-unavailability error, or any unexpected exception after `cursor-cli` check completed | Yes | Honest catch-all on a stable generic `doctor` check; never a duplicate `cursor-cli` check. |
| `"cursor-sdk-credential-missing"` | `cursor-api-key` (`CursorSdkRuntime`) | `CURSOR_API_KEY` environment variable is absent | Yes | Configuration missing; not `"auth-failure"`. Key presence does not prove auth success. |
| `"cursor-sdk-unavailable"` | `cursor-sdk` (`CursorSdkRuntime`) | Dynamic `import("@cursor/sdk")` throws | Yes | Package-availability failure; not `"cursor-executable-unavailable"` (no executable lookup). |
| `"auth-failure"` | *(reserved)* | Would require a stable, tested provider auth discriminator | **No — reserved** | Not observable today; #17 emits `"probe-invocation-failure"` instead. Future issue. |
| `"process-termination-failure"` | *(reserved)* | Would require the process abstraction to surface kill failures | **No — reserved** | Not observable: `killProcessTree()` swallows errors; `SpawnResult` has no field. Owned by cleanup/process-lifecycle follow-up. |
| `"probe-malformed-output"` | *(reserved)* | Would require structured-output parsing of the probe | **No — reserved** | #17 probe uses text output; no parsing. Owned by Issue #16. |
| `"probe-invalid-terminal-marker"` | *(reserved)* | Would require terminal-marker validation of the probe | **No — reserved** | #17 probe validates no marker contract. Owned by Issue #16. |

### Compatibility analysis for existing consumers

Existing consumers of `RuntimeDoctorResult`:

1. **`src/cli.ts`** — reads `checks[].ok`, `checks[].name`, and `checks[].message` to format
   terminal output; it does not construct check literals. Adding a required `code` field is
   **additive** for `cli.ts`; no compile break. `cli.ts` is modified in this issue only to add
   the `doctor --json` branch (see "CLI surface"), not because of the type change.

2. **Runtime adapters that construct non-empty checks** — `src/runtimes/cursor-cli.ts`,
   `src/runtimes/mock.ts`, and `src/runtimes/cursor-sdk.ts` build check literals and **will fail
   TypeScript compilation** until `code` is added to each literal. This is the intended
   compile-time enforcement of the typed contract.

3. **`test/compat-doctor.test.ts`, `test/merge-blockers-round3.test.ts`,
   `test/rc-review-corrections.test.ts`, `test/ready-review-corrections.test.ts`** — these
   **read** the result of `runtime.doctor()` (asserting on `name`/`ok`/`message`); they do not
   construct non-empty check literals, so the required `code` field does **not** break their
   compilation. They may receive **behavioral** updates to assert new typed codes/timeouts (e.g.,
   `ready-review-corrections` asserts `doctorProbeTimeoutMs` propagation), but they are not
   compile-forced by the type change.

4. **Empty-check / delegating stubs** — `test/model-resolution.test.ts`,
   `test/issue19-persistence.test.ts`, `test/issue19-success-event-persistence.test.ts`, and the
   `test/rc-review-corrections.test.ts` stub return `{ ok: true, checks: [] }` (empty array
   satisfies the required `code` type trivially); `test/orchestrator.test.ts`,
   `test/commit-provenance.test.ts`, `test/failed-run-provenance.test.ts`, and
   `test/evidence-freshness.test.ts` delegate to another runtime's `doctor()`. None construct a
   non-empty check literal, so none require a `code`-driven change. They are **inspected but
   unchanged** unless a genuine compile failure appears.

5. **New CLI test** — `test/issue17-doctor-cli-json.test.ts` (new) exercises `maswe doctor` and
   `maswe doctor --json` via the CLI entry point with the mock runtime.

**This is not a serialization breaking change.** `RuntimeDoctorResult` is a TypeScript
interface used only within the in-process runtime; it is not persisted to `run-record.schema.json`
or any external format. Consumers that consume `RuntimeDoctorResult` via TypeScript types will
see compile-time errors that enforce correctness; there are no silently-broken runtime callers.

---

## CLI surface: `maswe doctor` and `maswe doctor --json`

The typed `DoctorCheckCode` vocabulary is exposed deterministically through the CLI. This is the
approved direction (no "if adopted" hedging): the typed codes and `prerequisite` values are
surfaced to operators and tests via a machine-readable JSON mode.

### Human-readable output (unchanged)

`maswe doctor` (no `--json`) keeps its current human-readable output for backward compatibility.
The current implementation (`src/cli.ts`) prints one line per check:

```text
${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}
```

This line format is preserved exactly. Human output does **not** print the `code`; the exact
contract is `PASS|FAIL <name>: <message>` and no implementation may append codes or any other
fields to the human line. Typed codes are exposed only through `maswe doctor --json`. Existing
operators and any scripts that parse `PASS`/`FAIL` lines are unaffected.

### JSON output (`maswe doctor --json`)

`maswe doctor --json` emits the **complete `RuntimeDoctorResult`** serialized as JSON to stdout,
using `JSON.stringify(report, null, 2)` (consistent with the existing `status`/`start --json`
rendering). The emitted object includes:

- `ok` (the top-level `report.ok` boolean);
- `checks`, an array in which every element includes:
  - `name`
  - `ok`
  - `message`
  - `code` (a `DoctorCheckCode` value)
  - `prerequisite` (present only on skipped checks).

`--json` is already tolerated by the CLI argument parser (`positional()` in `src/cli.ts` treats
`--json` as a bare flag), so adding the branch requires no argument-parsing change.

### Exit status (both modes)

Exit status is derived from `report.ok` in **both** human and JSON modes:
`process.exitCode = report.ok ? 0 : 1`. A failed report exits non-zero even when `--json` is
used, so CI can gate on the exit code and separately parse the JSON for typed codes. `--json`
must not alter the exit semantics.

### Exact `src/cli.ts` behavior

In the `doctor` case, after `const report = await runtime.doctor();`:

- if `--json` is present: `console.log(JSON.stringify(report, null, 2));`
- else: keep the existing per-check `PASS`/`FAIL` line loop.
- in both branches: `process.exitCode = report.ok ? 0 : 1;`

This mirrors the existing `has(args, "--json")` pattern already used by `status` and `start`.

### No persistence or schema claim

`RuntimeDoctorResult` (and therefore the `--json` output) is **not** a persisted artifact and is
**not** governed by `schemas/run-record.schema.json` or any other JSON Schema. The `--json`
output is a convenience serialization of an in-process value; this design makes **no**
persistence, schema, or wire-format stability claim for it beyond the CLI behavior described here.

### CLI test coverage

CLI behavior is covered by a dedicated CLI test file, **`test/issue17-doctor-cli-json.test.ts`**
(new; there is no existing CLI-entrypoint test for `doctor`). The exact test file is fixed here
and must not be left to the builder. It exercises the CLI entry point deterministically with
**two fixtures**; both use the real CLI entry point with no live Cursor credentials.

**Passing fixture** (`MASWE_RUNTIME=mock`): exercises the mock runtime; asserts human
`PASS <name>: <message>` format and `--json` output is parseable JSON with `ok: true` and every
check carrying `code: "ok"`; both human and `--json` modes exit 0.

**Failing/prerequisite fixture** (temporary project configuration using `runtime.kind:
"cursor-cli"` with a temporary executable that starts successfully and exits non-zero for
`--version`): asserts that both human and `--json` modes exit non-zero; JSON contains
`cursor-cli` / `"cursor-version-check-failure"` and `prompt-transport-probe` /
`"skipped-prerequisite-failure"` / `prerequisite: "cursor-cli"`; the actual prompt probe is
not invoked. This fixture covers the failed-report and skipped-prerequisite behaviors;
**the mock fixture alone does not cover them.**

Use existing child-process helpers and temporary executable patterns. Do not add failure
switches to production `MockRuntime`. The mock runtime's `doctor()` result must include the
required `code` field so tests can assert typed codes without a live Cursor CLI.

---

## Process lifecycle

### Classification structure (refactored `doctor()` control flow)

The revised classification isolates each failure domain so no exception is misattributed. The
implementation plan (Task 4) specifies the exact refactor; the design contract is:

```text
doctor()
  ├─ TRY spawn agent --version
  │    ├─ spawn rejected (ENOENT/EACCES/EPERM/ENOTDIR)
  │    │    → "cursor-cli" ok=false, code: "cursor-executable-unavailable"
  │    │    → TERMINATE downstream (no catalogue/model/probe checks); go to finally
  │    ├─ spawn rejected with any other error (unknown code, EMFILE, ENOMEM, plain Error, non-Error)
  │    │    → "doctor" ok=false, code: "doctor-unexpected-error"
  │    │    → TERMINATE downstream; go to finally
  │    ├─ started, exit≠0 or timedOut
  │    │    → "cursor-cli" ok=false, code: "cursor-version-check-failure" (cliOk=false)
  │    └─ started, exit=0
  │         → "cursor-cli" ok=true, code: "ok" (cliOk=true)
  ├─ if (cliOk):
  │    ├─ TRY listModels()                          ← catalogue-only try/catch
  │    │    catch → "model-catalogue" code: "catalogue-discovery-failure"
  │    │           + each "model-{role}" code: "skipped-prerequisite-failure",
  │    │             prerequisite: "model-catalogue"   (did NOT attempt resolution)
  │    └─ on catalogue success: resolve EACH role exactly once
  │         ├─ role resolves → "model-{role}" code: "ok"
  │         └─ role throws   → "model-{role}" code: "model-resolution-failure"
  │         (capture brainstormer's resolved exact ID from its OWN successful result)
  ├─ DETERMINE blocking probe prerequisite (before any probe-resource creation):
  │    ├─ cliOk === false              → prerequisite: "cursor-cli"
  │    ├─ catalogueOk === false        → prerequisite: "model-catalogue"
  │    └─ brainstormerResolved === false → prerequisite: "model-brainstormer"
  ├─ if promptTransport !== "stdin" OR blocking prerequisite exists:
  │    ├─ if blocking prerequisite exists:
  │    │    → emit "prompt-transport-probe" ok=false, code: "skipped-prerequisite-failure",
  │    │         prerequisite: <blocking check>
  │    │    (do NOT call resolveDoctorProbeCwd(); do NOT create worktree or branch)
  │    └─ if promptTransport !== "stdin":
  │         (no probe check to emit; no probe-resource creation needed)
  ├─ else (stdin probe will actually execute):
  │    ├─ resolveDoctorProbeCwd()   ← if this throws, outer catch →
  │    │                               "doctor" code: "doctor-unexpected-error"
  │    ├─ spawnFn(probe, { timeoutMs: doctorProbeTimeoutMs })
  │    │    ├─ exit=0 && !timedOut → code: "ok"
  │    │    ├─ timedOut            → code: "probe-transport-timeout"
  │    │    └─ exit≠0 && !timedOut → code: "probe-invocation-failure"
  │    └─ (cleanup via finally)
  └─ finally: cleanupDoctorProbeSafe()
       → "doctor-probe-cleanup" code: "ok"/"cleanup-failure"
       (if no probe-resource was created: reports no ephemeral resource was created)
```

Key invariants enforced by this structure:

- A **catalogue** exception is caught only by the `listModels()` catch; it can never be produced
  by a role-resolution throw.
- A **role-resolution** exception is confined to that role's own check; it never enters the
  catalogue catch and never produces `"catalogue-discovery-failure"`.
- The aggregate `resolveProjectModels()` call is **removed from the doctor path** (it previously
  wrapped both catalogue discovery and role resolution in one try, which is exactly the
  misclassification this design forbids). The brainstormer's resolved exact ID is taken from the
  brainstormer role's own successful resolution result.
- An unexpected error **after** the `cursor-cli` check is attributed to a stable generic
  `doctor` check (`"doctor-unexpected-error"`) — never a duplicate `cursor-cli` check.
- A pre-version spawn rejection whose `error.code` is not in the executable-unavailability set
  also uses `doctor`/`"doctor-unexpected-error"` — never a `cursor-cli` check.
- **`resolveDoctorProbeCwd()` is called only when the stdin probe will actually execute** — after
  confirming that no blocking prerequisite exists and that `promptTransport === "stdin"`. A
  skipped probe cannot be replaced by a worktree-creation error because worktree creation is
  never attempted when the probe is skipped.
- When `promptTransport !== "stdin"`, no probe-resource creation occurs at all.

### Normal execution path

```text
doctor()
  ├─ agent --version (commandTimeoutMs)
  ├─ agent models    (commandTimeoutMs)
  ├─ per-role model resolution
  ├─ resolveDoctorProbeCwd()         → ephemeral worktree (if configured)
  ├─ spawnFn(probe, { timeoutMs: effectiveProbeTimeout })
  │    ← responds within deadline
  │    exitCode=0, timedOut=false
  │    → "prompt-transport-probe" ok=true
  └─ finally: cleanupDoctorProbeSafe()
       → "doctor-probe-cleanup" ok=true
  return { ok: true, checks }
```

### Timeout path

```text
spawnFn(probe, { timeoutMs: effectiveProbeTimeout })
  ← deadline expires
  → spawnCaptured onTimeout():
       killProcessTree(child.pid)         // SIGKILL to process group (POSIX)
                                          // taskkill /T /F (Windows)
       destroy stdin/stdout/stderr
       settlementGrace = setTimeout(settleTimeout, 1_000)
  ← child closes (or settlementGrace fires)
  → SpawnResult { exitCode: 124, timedOut: true, durationMs }

  → check: "prompt-transport-probe" ok=false, code: "probe-transport-timeout"
    message: "stdin prompt probe timed out after Nms in cwd <path>…"
```

### Termination escalation

`spawnCaptured()` goes **directly to SIGKILL** (POSIX: `process.kill(-pid, "SIGKILL")`) with no
prior SIGTERM. This is the current behavior and is preserved by this design. The 1 000 ms
settlement grace (`SETTLEMENT_GRACE_MS`) provides time for pipe-holding descendants to drain.

**Termination failure is not observable by Issue #17.** `killProcessTree()` (src/process.ts)
swallows every kill error inside `catch {}` blocks, and `SpawnResult` exposes no
termination-failure field. The caller (`doctor()`) therefore cannot detect that a process-tree
kill failed. Consequently:

- Issue #17 **cannot** emit `"process-termination-failure"`; that code is reserved.
- Surfacing termination failures requires changing the process abstraction (adding a
  termination-outcome field to `SpawnResult` and having `killProcessTree()` report errors). That
  change is out of scope for Issue #17 and is assigned to the cleanup / process-lifecycle
  follow-up.
- No SIGTERM-before-SIGKILL redesign is authorized by this revision.

If a future issue makes termination failure observable, it must preserve the **primary** probe
failure (timeout or invocation failure) as its own check and surface the termination failure as a
separate, independent check — neither may overwrite the other. Precedence for the primary probe
check remains: `"probe-transport-timeout"` when `timedOut === true`, otherwise
`"probe-invocation-failure"`.

### Cleanup after timeout

`cleanupDoctorProbeSafe()` is called in `finally` regardless of probe outcome. A timed-out probe
does not bypass cleanup.

```text
finally:
  cleanupDoctorProbeSafe(probeCwd)
    ├─ git worktree remove --force <worktreePath>  (no timeout — existing gap)
    ├─ git branch -D maswe/<probeId>               (no timeout — existing gap)
    └─ return check { name: "doctor-probe-cleanup", code: "ok"/"cleanup-failure", ok: true/false, message }
```

### Multiple-failure handling

When the probe times out and cleanup also fails, both failures are preserved:
- `report.checks` contains `"prompt-transport-probe" ok=false, code: "probe-transport-timeout"`
  AND `"doctor-probe-cleanup" ok=false, code: "cleanup-failure"`.
- `report.ok === false` (any failed check causes this).
- No failure is suppressed or aggregated.

The three distinct failure classes — the **primary probe failure** (`"probe-transport-timeout"`
or `"probe-invocation-failure"`), a **process-termination failure** (reserved; not emitted by
#17), and a **cleanup failure** (`"cleanup-failure"`) — must never overwrite one another. Each is
a separate check with its own code. Issue #17 emits the primary probe failure and the cleanup
failure independently; the termination failure remains reserved until the process-lifecycle
follow-up makes it observable, at which point it must be added as a further independent check.

---

## Configuration and compatibility

### New field: `policy.doctorProbeTimeoutMs`

| Attribute | Value |
|---|---|
| Type | `integer` (non-optional in TypeScript after `migrateConfig`; optional in raw user config) |
| In `DEFAULT_CONFIG` | yes — `doctorProbeTimeoutMs: 60_000` |
| Default | `60_000` ms (provided by `DEFAULT_CONFIG`, not by a call-site fallback) |
| Minimum | `1_000` ms |
| Maximum | `300_000` ms |
| Schema | `schemas/config.schema.json` → `policy.properties.doctorProbeTimeoutMs` |
| TypeScript | `MasweConfig.policy.doctorProbeTimeoutMs: number` (non-optional) in `src/domain.ts` |

### Default config placement

`DEFAULT_CONFIG` in `src/config.ts` **must** include `doctorProbeTimeoutMs: 60_000` explicitly:

```typescript
policy: {
  // ... existing fields ...
  doctorProbeTimeoutMs: 60_000,
}
```

Because `migrateConfig()` starts from `cloneDefaults()` and shallow-merges `policy` via
`{ ...base.policy, ...(value.policy ?? {}) }`, the field is always present in the merged
config at `60_000` unless the user explicitly overrides it. Runtime code uses
`this.config.policy.doctorProbeTimeoutMs` directly — no `?? 60_000` fallback.

The field is declared as `doctorProbeTimeoutMs: number` (non-optional) in `MasweConfig.policy`
because it is always populated through the defaults path before validation. The JSON schema
does **not** add it to `policy.required` (users need not provide it in their config files).

**Test:** A config loaded with `migrateConfig({})` must produce exactly
`policy.doctorProbeTimeoutMs === 60_000`.

### Compatibility statement

- **Existing valid configuration files remain accepted.** No user-facing configuration
  migration is required.
- **The default effective probe timeout changes from 5 000 ms to 60 000 ms.** This is an
  intentional runtime behavior change, not a backward-compatible bug fix. Operators who relied
  on the previous 5-second implicit cap must review their setup.
- **Operational effect:** Under the new default, a failing or unavailable prompt transport
  may take up to 60 000 ms to report failure, compared with 5 000 ms previously. Healthy,
  authenticated environments where provider latency exceeds 5 000 ms (e.g., the observed
  7–14 second range from Issue #17 evidence) will no longer be misclassified as failed.
- **Explicit operator configuration** can select any value within [1 000, 300 000] ms.
  No existing configuration specifying `doctorProbeTimeoutMs` exists; this is a new field.

### `assertConfig()` changes

`assertConfig()` must validate `doctorProbeTimeoutMs` unconditionally (it is always present
after `migrateConfig()`). Add after the existing `commandTimeoutMs` and `roleTimeoutMs` checks:

```typescript
if (
  !Number.isInteger(config.policy.doctorProbeTimeoutMs) ||
  config.policy.doctorProbeTimeoutMs < 1_000 ||
  config.policy.doctorProbeTimeoutMs > 300_000
) {
  throw new Error(
    "policy.doctorProbeTimeoutMs must be an integer between 1000 and 300000",
  );
}
```

Note: the `!== undefined` guard from the original draft is removed because the field is always
defined after `migrateConfig()`. `Number.isInteger` already rejects NaN, Infinity, and
non-integer values.

### Schema addition

In `schemas/config.schema.json`, under `policy.properties`:

```json
"doctorProbeTimeoutMs": { "type": "integer", "minimum": 1000, "maximum": 300000 }
```

The field is not added to `policy.required`; it is optional in raw user config. The schema
`minimum` and `maximum` constraints align with `assertConfig()` hard bounds.

---

## Testing strategy

All tests are deterministic and do not require a live Cursor CLI. They use the
`spawnFn` injection seam already present in `CursorCliRuntime`. **Tests must assert `code`
values from the typed `DoctorCheckCode` vocabulary, not message substrings, except in tests
that explicitly verify message quality.**

### 1. Timeout selection and canonical defaulting

| Test | Assertion |
|---|---|
| `migrateConfig({})` | `policy.doctorProbeTimeoutMs === 60_000` |
| `migrateConfig({ policy: { doctorProbeTimeoutMs: 15_000 } })` | `policy.doctorProbeTimeoutMs === 15_000` |
| `migrateConfig({ policy: { commandTimeoutMs: 2_000 } })` | `policy.doctorProbeTimeoutMs === 60_000` (independent of commandTimeoutMs) |
| Probe spawned with default config | Spawn call receives `timeoutMs: 60_000` |
| Probe spawned with `doctorProbeTimeoutMs: 300_000` | Spawn call receives `timeoutMs: 300_000` |
| Probe spawned with `doctorProbeTimeoutMs: 1_000` | Spawn call receives `timeoutMs: 1_000` |

### 2. Hard bounds validation

| Test | Assertion |
|---|---|
| `doctorProbeTimeoutMs: 0` | `assertConfig` throws with `doctorProbeTimeoutMs` in message |
| `doctorProbeTimeoutMs: -1` | `assertConfig` throws |
| `doctorProbeTimeoutMs: 999` | `assertConfig` throws (below minimum) |
| `doctorProbeTimeoutMs: 300_001` | `assertConfig` throws (above maximum) |
| `doctorProbeTimeoutMs: NaN` | `assertConfig` throws |
| `doctorProbeTimeoutMs: Infinity` | `assertConfig` throws |
| `doctorProbeTimeoutMs: 1.5` | `assertConfig` throws (non-integer) |
| `doctorProbeTimeoutMs: "60000"` | Loaded via `migrateConfig` from JSON → schema or type rejection |
| `doctorProbeTimeoutMs: 1_000` | `assertConfig` passes (minimum accepted) |
| `doctorProbeTimeoutMs: 300_000` | `assertConfig` passes (maximum accepted) |

### 3. Typed code assertions

Machine-oriented tests assert `code` (and, for the skipped case, `prerequisite`), never message
text.

| Test | Asserts |
|---|---|
| Probe exits 0 and `!timedOut` | `code === "ok"` |
| `spawnFn` returns `{ timedOut: true }` | `code === "probe-transport-timeout"` |
| `spawnFn` returns `{ exitCode: 1, timedOut: false }` | `code === "probe-invocation-failure"` |
| Valid catalogue + one invalid **non-brainstormer** role (`resolveLogicalModelId` throws for that role only) | `model-catalogue` `code === "ok"`; **only** that `model-{role}` has `code === "model-resolution-failure"`; every other role `code === "ok"` |
| Valid catalogue + invalid **brainstormer** role | `model-catalogue` `code === "ok"`; `model-brainstormer` `code === "model-resolution-failure"`; `prompt-transport-probe` `code === "skipped-prerequisite-failure"`, `prerequisite === "model-brainstormer"`, `ok === false` |
| **Catalogue discovery fails** (`listModels()` throws) | `model-catalogue` `code === "catalogue-discovery-failure"`; **every** retained `model-{role}` check has `code === "skipped-prerequisite-failure"`, `prerequisite === "model-catalogue"` — asserted to be **not** `"model-resolution-failure"`; **no** `model-{role}` reports having attempted resolution |
| No role-resolution-failure without an actual attempt | Across the catalogue-failure outcome, assert no emitted check has `code === "model-resolution-failure"` (nothing resolved a role) |
| Skipped-probe distinction | The failed prerequisite (e.g. `model-brainstormer`) still carries `"model-resolution-failure"` as its own separate check; the skipped probe's message does not claim prompt transport, auth, model resolution, or catalogue discovery independently failed |
| `agent --version` starts but exits non-zero | `cursor-cli` check `code === "cursor-version-check-failure"` (not `"cursor-executable-unavailable"`); **no** `model-catalogue`/`model-{role}` check emitted; `prompt-transport-probe` `code === "skipped-prerequisite-failure"`, `prerequisite === "cursor-cli"`; probe `spawnFn` **not** invoked; no false model/catalogue/auth/transport classification |
| `agent --version` times out (`timedOut: true`) | Same as non-zero `--version`: `cursor-cli` `code === "cursor-version-check-failure"`; probe skipped with `prerequisite === "cursor-cli"`; probe `spawnFn` not invoked |
| `spawnFn` rejects with `Error{ code: "ENOENT" }` (executable not found) | `cursor-cli` check `code === "cursor-executable-unavailable"`; downstream check sequence terminates — **no** `model-catalogue`/`model-{role}`/`prompt-transport-probe` checks; `doctor-probe-cleanup` check still present; no false model/catalogue/auth/transport classification |
| `spawnFn` rejects with `Error{ code: "EACCES" }` (permission denied at spawn) | `cursor-cli` check `code === "cursor-executable-unavailable"`; downstream terminated as above |
| `spawnFn` rejects with `Error{ code: "EMFILE" }` (unknown/other spawn error) | **`doctor`** check with `code === "doctor-unexpected-error"`; no `cursor-cli` check emitted |
| `spawnFn` rejects with a plain `Error` (no `code` property) | **`doctor`** check with `code === "doctor-unexpected-error"`; no `cursor-cli` check emitted |
| `spawnFn` rejects with a non-`Error` thrown value | **`doctor`** check with `code === "doctor-unexpected-error"`; no `cursor-cli` check emitted |
| `resolveDoctorProbeCwd()` throws a non-spawn error (e.g., git error) **after** a successful `cursor-cli` check | A **`doctor`** check with `code === "doctor-unexpected-error"` is emitted; there is **no** second `cursor-cli` check (no duplicate failed `cursor-cli` after the successful one) |
| `listModels()` throws | `model-catalogue` check `code === "catalogue-discovery-failure"` |
| `cleanupDoctorProbeResources` throws | `doctor-probe-cleanup` check `code === "cleanup-failure"` |
| Reserved codes are never emitted | Across all the above outcomes, no emitted check has `code ∈ { "auth-failure", "process-termination-failure", "probe-malformed-output", "probe-invalid-terminal-marker" }` |
| Authentication is not inferred from messages | Given a probe that exits non-zero with an "unauthorized"-style stderr, the check `code === "probe-invocation-failure"`, **never** `"auth-failure"` |
| Probe-resource gating: non-zero version → no `ensureProbeWorkspace` call | `--version` fails: `resolveDoctorProbeCwd()` / `ensureProbeWorkspace` is **not** called; no worktree or branch is created |
| Probe-resource gating: catalogue failure → no `ensureProbeWorkspace` call | `listModels()` throws: probe-resource creation is **not** attempted |
| Probe-resource gating: brainstormer failure → no `ensureProbeWorkspace` call | brainstormer resolution fails: probe-resource creation is **not** attempted |
| Probe-resource gating: argv transport → no `ensureProbeWorkspace` call | `promptTransport !== "stdin"`: no probe-resource creation |
| Probe-resource gating: successful stdin probe → `ensureProbeWorkspace` called exactly once | all prerequisites pass and `promptTransport === "stdin"`: `ensureProbeWorkspace` called exactly once when isolation requires it |
| Skipped probe cannot be replaced by worktree-creation error | A skipped probe's `code === "skipped-prerequisite-failure"` is not overwritten by a worktree creation failure because creation is never attempted |

### 4. Message quality assertions (explicitly testing message content)

| Test | Message content assertion |
|---|---|
| Probe times out with 60 000 ms | Message contains `"timed out after 60000ms"` |
| Probe times out with configured 15 000 ms | Message contains `"timed out after 15000ms"` |
| Probe exits with code 1 | Message contains `"exit 1"` |

### 5. Multiple-failure preservation

| Test | Assertion |
|---|---|
| Probe times out; cleanup succeeds | Both checks present; probe `code: "probe-transport-timeout"` ok=false; cleanup `code: "ok"` ok=true; `report.ok === false` |
| Probe times out; cleanup fails | Both checks present; probe `code: "probe-transport-timeout"` ok=false; cleanup `code: "cleanup-failure"` ok=false; `report.ok === false`; neither failure suppressed |
| Probe exits non-zero; cleanup fails | Both failures visible; cleanup code independent of probe code |

### 6. Cleanup always attempted

| Test | Assertion |
|---|---|
| Probe succeeds | `doctor-probe-cleanup` check present and ok=true |
| Probe fails (timeout) | `doctor-probe-cleanup` check present (cleanup still ran) |
| Probe fails (non-zero) | `doctor-probe-cleanup` check present (cleanup still ran) |

### 7. No global wall-clock bound asserted

No test asserts that the complete `maswe doctor` command returns within any fixed wall-clock
budget. The `doctor-probe-cleanup` check has no independent timeout; its duration is
non-deterministic in degenerate git conditions.

### 8. Configuration migration round-trip

| Test | Assertion |
|---|---|
| `migrateConfig({})` | `doctorProbeTimeoutMs === 60_000` (from DEFAULT_CONFIG) |
| `migrateConfig({ policy: { doctorProbeTimeoutMs: 30_000 } })` | `doctorProbeTimeoutMs === 30_000` |
| `migrateConfig({ policy: { commandTimeoutMs: 2_000 } })` | `doctorProbeTimeoutMs === 60_000` (preserved from base) |

### 9. Persisted-config migration (historical `RunRecord`)

`doctorProbeTimeoutMs` is part of normalized `RunRecord.config.policy`. A historical run record
serialized before this field existed must remain loadable and usable.

| Test | Assertion |
|---|---|
| Historical raw `RunRecord` whose `config.policy` omits `doctorProbeTimeoutMs` | Record remains loadable via `migrateRunRecord()` or `FileRunStore.load()`; normalized `run.config.policy.doctorProbeTimeoutMs === 60_000` |
| Normalized record satisfies `assertConfig()` | `assertConfig()` passes on the migrated record |
| Environment overrides not applied during persisted-record migration | `MASWE_DOCTOR_PROBE_TIMEOUT_MS` env var is **not** used by `migrateRunRecord()`; migration applies only `DEFAULT_CONFIG` defaults |
| Explicitly stored valid value is preserved | A persisted record with `doctorProbeTimeoutMs: 30_000` loads with that value intact |
| Explicitly stored invalid value fails closed | A persisted record with `doctorProbeTimeoutMs: 0` causes `assertConfig()` to throw rather than silently clamping |

This test maps to the persisted-configuration migration acceptance criterion (AC39).

### 10. CLI surface (`maswe doctor --json`)

Covered by the dedicated CLI test file **`test/issue17-doctor-cli-json.test.ts`** (new). The
file specifies **two deterministic fixtures** — one for the passing path, one for the
failing/prerequisite path. Both exercise the CLI entry point by spawning
`node --experimental-strip-types src/cli.ts doctor [--json] --cwd <tmp>`.

#### Passing fixture (`MASWE_RUNTIME=mock`)

Uses the mock runtime. No Cursor credentials or real CLI required.

| Test | Assertion |
|---|---|
| `maswe doctor` (human) on the passing mock report | stdout contains `PASS <name>: <message>` lines in the unchanged `PASS\|FAIL <name>: <message>` format; process exits 0 |
| `maswe doctor --json` is valid JSON | `JSON.parse(stdout)` yields an object with `ok: boolean` and a `checks` array |
| JSON checks expose typed fields | every parsed check has `name`, `ok`, `message`, and a `code`; the mock check has `code: "ok"` |
| Exit semantics match (passing report) | when `report.ok === true`, exit code is `0` in both human and `--json` modes |
| No persistence claim | the test treats `--json` as a serialization of an in-process value only; it does **not** validate against any JSON Schema |

#### Failing/prerequisite fixture (temporary `cursor-cli` wrapper)

Uses a temporary project configuration (written to a temp directory for the test) with:
- `runtime.kind: "cursor-cli"`
- `runtime.command` pointing to a temporary executable test wrapper
- `policy.promptTransport: "stdin"`
- isolated probe worktree disabled unless the test explicitly requires it

The executable wrapper must:
- start successfully (it is a real executable in the temp directory)
- return a deterministic non-zero result for `--version`

The probe command is never invoked. Test asserts in both human and `--json` modes:

| Test | Assertion |
|---|---|
| `maswe doctor` (human) on failing report | process exits non-zero; `cursor-cli` has a `FAIL` line; `prompt-transport-probe` has a `FAIL` line; line format matches `PASS\|FAIL <name>: <message>` exactly and no code is appended |
| `cursor-cli` check code | `cursor-cli` has `code: "cursor-version-check-failure"` |
| Skipped probe in human mode | `prompt-transport-probe` line present; exit non-zero |
| `maswe doctor --json` on failing report | JSON parses; `ok: false`; `cursor-cli` check has `code: "cursor-version-check-failure"` |
| `prompt-transport-probe` in JSON | `ok: false`; `code: "skipped-prerequisite-failure"`; `prerequisite: "cursor-cli"` |
| Probe command not invoked | the wrapper executable is never called with probe arguments |
| Exit non-zero in both modes | both human and `--json` modes exit non-zero on failed report |

Use existing child-process helpers and temporary executable patterns where possible. Do not add
failure switches to production `MockRuntime`.

### 11. CursorSdkRuntime deterministic tests (import injection seam)

`CursorSdkRuntime.doctor()` currently uses the module-level `importOptional` function directly
and exposes no injection seam, making it impossible to write deterministic tests for import
success and failure paths without installing `@cursor/sdk`. Issue #17 adds an exact injection
seam so tests can inject synthetic import outcomes.

#### Injection seam contract

```typescript
type CursorSdkImportFn = (
  specifier: string,
) => Promise<Record<string, any>>;

export class CursorSdkRuntime implements AgentRuntime {
  private readonly importFn: CursorSdkImportFn;

  constructor(
    options: { importFn?: CursorSdkImportFn } = {},
  ) {
    this.importFn = options.importFn ?? importOptional;
  }

  // execute() and doctor() both use:
  // await this.importFn("@cursor/sdk")
}
```

Production construction remains compatible: `new CursorSdkRuntime()` uses the existing
`importOptional` default. `createRuntime()` requires no behavioral change. Both `execute()`
and `doctor()` use the injected importer, ensuring a single import path. The default remains
the existing dynamic `importOptional`. The implementation must not add `@cursor/sdk` as a
test dependency, manipulate `node_modules`, or use global monkey-patching or custom Node loaders.

#### Test file: `test/issue17-cursor-sdk-doctor.test.ts` (new)

Tests instantiate `CursorSdkRuntime` directly with injected import functions.

**Import success** — inject:

```typescript
async () => ({
  Agent: {
    prompt: async () => {
      throw new Error("execute() is not exercised by this doctor test");
    },
  },
})
```

With `CURSOR_API_KEY` present, assert:

| Check | `ok` | `code` |
|---|---|---|
| `cursor-api-key` | `true` | `"ok"` |
| `cursor-sdk` | `true` | `"ok"` |

Top-level `report.ok === true`.

**Missing credential** — same successful importer, `CURSOR_API_KEY` absent. Assert:

| Check | `ok` | `code` |
|---|---|---|
| `cursor-api-key` | `false` | `"cursor-sdk-credential-missing"` |
| `cursor-sdk` | `true` | `"ok"` |

Top-level `report.ok === false`.

**Import failure** — inject:

```typescript
async () => {
  throw new Error("synthetic SDK import failure");
}
```

Assert:

| Check | `ok` | `code` |
|---|---|---|
| `cursor-sdk` | `false` | `"cursor-sdk-unavailable"` |

No reserved code is emitted. Tests must restore `CURSOR_API_KEY` in `finally` or equivalent
teardown so environment state cannot leak between tests.

### Authenticated validation procedure (separate from deterministic tests)

This procedure is not part of the automated test suite. It must be performed by a human operator
with a valid Cursor account, recorded in a validation comment against Issue #17, and referenced
from any implementation PR. Authenticated evidence must be kept separate from deterministic
acceptance tests.

1. Record the exact repository SHA at time of validation:
   ```bash
   git rev-parse HEAD
   ```
2. Confirm the effective `doctorProbeTimeoutMs` from the normalized configuration separately:
   ```bash
   node --experimental-strip-types --input-type=module \
     -e 'import { loadConfig } from "./src/config.ts"; const c = await loadConfig("/path/to/target-repo"); console.log(c.policy.doctorProbeTimeoutMs)'
   ```
   Neither human doctor output nor `RuntimeDoctorResult` currently exposes the effective timeout
   on a successful probe, so it must not be inferred from either output surface.
3. Run `maswe doctor --json --cwd /path/to/target-repo` and record the parsed JSON. Because
   `--json` emits the complete `RuntimeDoctorResult`, the operator records directly from the
   JSON (no message-text scraping):
   - wall-clock elapsed time (e.g., `time maswe doctor --json …`)
   - `report.ok`
   - for the `prompt-transport-probe` check: its `ok`, `code`, and (if present) `prerequisite`
   - the typed `code` of every other check
   - the exact effective timeout value recorded separately from the normalized configuration
   Authenticated validation **must** use `maswe doctor --json` to record codes; typed codes are
   read from the JSON, never inferred from human-readable output.
4. Verify process and resource cleanup:
   ```bash
   git worktree list
   git branch --list 'maswe/doctor-*'
   ```
   Both must be clean after `doctor` returns.
5. Record findings without inferring universal latency guarantees from a single observation.
6. If `FAIL` with `"probe-transport-timeout"`, the operator must increase `doctorProbeTimeoutMs`
   or investigate provider latency; the implementation must not retry automatically.

---

## Documentation impact

### `docs/OPERATIONS.md`

Add to the `maswe doctor` section:

- Explain that the probe uses `policy.doctorProbeTimeoutMs` (default 60 000 ms).
- State that the probe timeout is independent of `commandTimeoutMs` and `roleTimeoutMs`.
- State valid range (1 000–300 000 ms) and that invalid values are rejected at startup.
- Explain that a `FAIL` on `prompt-transport-probe` with code `"probe-transport-timeout"`
  can be resolved by increasing `doctorProbeTimeoutMs` if provider latency exceeds 60 seconds.
- Emphasize that a timed-out probe is a failure; it does not prove readiness.
- Note the compatibility behavior: the default effective probe timeout changed from 5 seconds
  to 60 seconds; healthy environments with latency above 5 seconds are now less likely to be
  misclassified, but a failing transport may take longer to report under the new default.
- State that the complete `maswe doctor` command does not have a strict wall-clock upper bound
  because the cleanup phase has no independent timeout (tracked as a separate follow-up).
- Document `maswe doctor --json`: it emits the complete `RuntimeDoctorResult` (each check's
  `name`, `ok`, `message`, `code`, and optional `prerequisite`) with the exit status derived
  from `report.ok` in both human and JSON modes. Note that `--json` output is an in-process
  serialization with no persistence/schema guarantee.
- State precisely what a passing probe proves (command started, stdin accepted, exited zero
  within the timeout) and what it does not (auth classification, non-empty/valid output,
  structured decoding, marker validity, descendant termination).
- Note that process-tree termination on timeout is best-effort and not observable; a leaked
  descendant cannot be detected or reported by the current process abstraction.

Update the `CursorCliRuntime` description (currently at line 147) to reference the
`doctorProbeTimeoutMs` field and its relationship to `commandTimeoutMs`.

### `schemas/config.schema.json`

Add `doctorProbeTimeoutMs` as described in the "Configuration and compatibility" section.

### `src/domain.ts`

Export `DoctorCheckCode` alongside the existing `RuntimeFailureCode` export.

### No ADR required

This is a bounded policy clarification for an existing feature, not an architectural decision.
The existing ADR structure (0001–0007) covers the relevant architectural principles.

---

## Security and operational analysis

### Denial-of-service / excessive-wait risk

Without a maximum bound, an operator could set `doctorProbeTimeoutMs` to an arbitrary large
value. The 300 000 ms maximum caps the prompt-transport invocation deadline and subsequent
promise settlement; the 60 000 ms default supplies that deadline without operator
configuration. Process-tree termination after timeout remains best-effort, is not guaranteed,
and is not observable, so this policy does not strictly bound the lifetime of every descendant
process. The deadline applies **only to the prompt-transport invocation**. The **complete
`maswe doctor` command duration remains unbounded**, because worktree creation
(`resolveDoctorProbeCwd()`) and cleanup git operations
(`cleanupDoctorProbeResources()` in the `finally` block) have no independent deadline. Issue
#17 does not make `maswe doctor` globally bounded; bounding total doctor duration is deferred to
the cleanup-timeout follow-up.

### Orphaned-process risk

`spawnCaptured()` uses `SIGKILL` to the process group immediately on timeout (POSIX) or
`taskkill /T /F` (Windows), with a 1 000 ms settlement grace. **Process-tree termination is
best-effort and is not guaranteed or observable.** `killProcessTree()` swallows every kill
error inside `catch {}` blocks and `SpawnResult` exposes no termination-failure field, so the
caller cannot detect a failed kill and cannot prove that all descendants were terminated. The
**promise settlement is bounded** (the probe promise resolves within the settlement grace), but
**descendant termination is not observable** — a leaked descendant, zombie, or kernel-held file
descriptor is neither detected nor reported. The design accepts this as a known limitation;
making termination observable is deferred to the cleanup / process-lifecycle follow-up (which
owns the reserved `"process-termination-failure"` code).

**Windows note:** The `taskkill /T /F` invocation is best-effort (unref'd). Settlement grace
still bounds the Promise. On Windows, process-group semantics differ; isolated group creation
is disabled on `win32` in `spawnCaptured()` (line ~55 of `process.ts`). The existing behavior
is preserved unchanged.

### Misleading readiness risk

Issue #17's probe uses `--output-format text` and checks only the process exit and timeout
state. A passing `prompt-transport-probe` check therefore proves **only**:
1. The configured `agent` command **started**.
2. The invocation was started with the configured stdin payload wired to the child process.
3. The child process **exited zero within `doctorProbeTimeoutMs`**
   (`exitCode === 0 && !timedOut`).

A passing check does **not** independently prove any of the following:
- That the child read, parsed, or semantically accepted the stdin payload (there is no
  acknowledgement protocol).
- A machine-readable authentication classification (auth success is not decoded; a non-zero exit
  is classified as `"probe-invocation-failure"`, never `"auth-failure"`).
- Non-empty or semantically valid model output (the probe does not inspect stdout content).
- Structured-output decoding (the probe uses text output and parses nothing).
- Terminal-marker validity (the probe validates no marker contract).
- Descendant/process-tree termination success (best-effort and unobservable, per above).
- That production prompt latency will be within this budget.
- That the exact model configured for a workflow role will respond within this budget.
- That catalogue discovery will succeed on the next `start`.
- That provider availability will be sustained.

These limitations must be explicit in `OPERATIONS.md`.

### Sensitive diagnostic / redaction considerations

The probe sends the literal string `"maswe-stdin-probe"` as stdin input. No credentials,
tokens, or repository content are included. The check message includes the `probeCwd` path;
this may expose a tmpdir path but not any secrets. The existing `safeDiagnosticText()` and
`sanitizeDiagnostic()` policy applies to all check messages; no new redaction rules are needed.

---

## Acceptance criteria

These criteria are objective and independently verifiable without a live Cursor CLI.
Criteria marked with `[NEW]` are additions or replacements from the original draft.

1. **AC1:** `src/runtimes/cursor-cli.ts` no longer contains `Math.min(5_000,` in the context
   of the probe spawn call.
2. **AC2 [NEW]:** `src/domain.ts` declares `doctorProbeTimeoutMs: number` (non-optional) in
   `MasweConfig.policy` and exports `DoctorCheckCode` as a string literal union type with the
   full 16-value vocabulary (12 emitted + 4 reserved), and `RuntimeDoctorResult.checks` gains a
   required `code: DoctorCheckCode` field and an optional
   `prerequisite?: DoctorCheckPrerequisite` field, where `DoctorCheckPrerequisite` is exactly
   `"cursor-cli" | "model-catalogue" | "model-brainstormer"`.
3. **AC3 [NEW]:** `src/config.ts` `assertConfig()` rejects any `doctorProbeTimeoutMs` value
   that is: below 1 000 ms, above 300 000 ms, zero, negative, non-integer, or non-finite.
   No advisory warning; always throws.
4. **AC4 [NEW]:** `src/config.ts` `DEFAULT_CONFIG` **includes** `doctorProbeTimeoutMs: 60_000`
   in `policy`. A call to `migrateConfig({})` produces exactly `policy.doctorProbeTimeoutMs === 60_000`.
5. **AC5:** `schemas/config.schema.json` includes `doctorProbeTimeoutMs` as an optional integer
   (not in `policy.required`) with `minimum: 1000, maximum: 300000`.
6. **AC6 [NEW]:** The probe spawn call uses `timeoutMs: this.config.policy.doctorProbeTimeoutMs`
   directly — no `?? 60_000` or other call-site fallback.
7. **AC7 [NEW]:** `RuntimeDoctorResult.checks` elements include a required `code: DoctorCheckCode`
   field. Every check object constructed in `doctor()` supplies a code from the defined vocabulary.
   `src/runtimes/cursor-sdk.ts` check literals use `"cursor-sdk-credential-missing"` and
   `"cursor-sdk-unavailable"` exactly as specified in the cursor-sdk code mapping table.
8. **AC8 [NEW]:** Deterministic tests assert `code` values from `DoctorCheckCode` rather than
   message substrings, except in tests that explicitly verify message quality (and those tests
   are labeled as such).
9. **AC9 [NEW]:** Primary and cleanup failures are preserved independently: when the probe fails
   and cleanup also fails, both checks appear in `report.checks`, each with its own code.
10. **AC10:** `docs/OPERATIONS.md` documents `doctorProbeTimeoutMs`, its default, range, and
    what a passing probe does and does not prove.
11. **AC11 [NEW]:** A `"probe-transport-timeout"` failure message includes the effective timeout
    value in ms (e.g., `"timed out after 60000ms"`).
12. **AC12:** A timed-out probe is reported as `ok: false` with code `"probe-transport-timeout"`;
    it is never silently reclassified as a warning or partial success.
13. **AC13 [NEW]:** No test asserts that the complete `maswe doctor` command returns within any
    fixed wall-clock budget. The spec does not claim the doctor command is globally bounded.
14. **AC14 [NEW]:** The cleanup-timeout follow-up is documented (see "Cleanup Timeout Follow-up
    Proposal"). No cleanup timeout code is implemented in this issue.
15. **AC15:** `npm run check` passes with no new failures.
16. **AC16 [NEW]:** Existing cleanup is always attempted in `finally`; no code path introduced
    by this issue bypasses `cleanupDoctorProbeSafe()`.
17. **AC17 [NEW]:** A probe that does not execute because a prerequisite check failed is reported
    with `code: "skipped-prerequisite-failure"`, `ok: false`, and a `prerequisite` naming the
    failed check (`"cursor-cli"`, `"model-catalogue"`, or `"model-brainstormer"`). It is **never**
    labelled `"model-resolution-failure"`, and its message does not claim that prompt transport,
    authentication, model resolution, or catalogue discovery independently failed.
    `"model-resolution-failure"` is emitted **only** by the `model-{role}` check that actually
    attempted (and failed) resolution.
18. **AC18 [NEW]:** Executable *absence* is distinct from an executable that starts and fails.
    `"cursor-executable-unavailable"` is emitted **only** for a deterministic spawn-lookup or
    spawn-permission failure (`ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`). A process that starts and
    exits non-zero, or times out, on `--version` is `"cursor-version-check-failure"`.
    Unavailability is never inferred from a non-zero exit.
19. **AC19 [NEW]:** Every code Issue #17 emits has a deterministic current emission predicate as
    listed in the "Emitted vs. reserved code table"; the predicates are mutually exclusive, so a
    single doctor execution outcome maps to exactly one code per check.
20. **AC20 [NEW]:** The reserved codes `"auth-failure"`, `"process-termination-failure"`,
    `"probe-malformed-output"`, and `"probe-invalid-terminal-marker"` are present in the
    `DoctorCheckCode` type but are **never constructed** by `doctor()` in Issue #17. A test
    asserts no emitted check carries a reserved code.
21. **AC21 [NEW]:** Authentication is not inferred from unstable human-readable messages. A probe
    that exits non-zero with an authentication-suggestive message is classified as
    `"probe-invocation-failure"`, never `"auth-failure"`. No test asserts authentication from a
    message substring.
22. **AC22 [NEW]:** The primary probe failure, a (reserved) process-termination failure, and the
    cleanup failure are not permitted to overwrite one another; each is a separate check with its
    own code. Issue #17 emits the primary probe failure and the cleanup failure independently.
23. **AC23 [NEW]:** The implementation plan for Issue #17 must not claim support for any reserved
    classification. Any surfacing of `"process-termination-failure"` is deferred to the cleanup /
    process-lifecycle follow-up; any surfacing of `"probe-malformed-output"` /
    `"probe-invalid-terminal-marker"` is deferred to Issue #16; `"auth-failure"` is deferred to a
    future issue that adopts a tested provider auth contract.
24. **AC24 [NEW]:** Catalogue discovery failure never masquerades as role resolution failure.
    When `listModels()` throws, `model-catalogue` is `"catalogue-discovery-failure"` and every
    retained `model-{role}` check is `"skipped-prerequisite-failure"` with
    `prerequisite: "model-catalogue"`. No `model-{role}` check reports
    `"model-resolution-failure"` in this outcome, and no design statement describes a catalogue
    cascade as `"model-resolution-failure"`.
25. **AC25 [NEW]:** Skipped role and probe checks use `prerequisite` attribution from the stable
    vocabulary (`"cursor-cli"`, `"model-catalogue"`, `"model-brainstormer"`) and never assert
    that their own subject independently failed.
26. **AC26 [NEW]:** `"cursor-cli"` is a supported `prerequisite` value. When `--version` starts
    but fails or times out (`cursor-version-check-failure`), no catalogue/model checks are emitted
    and `prompt-transport-probe` is skipped with `prerequisite: "cursor-cli"`; the probe process
    is not spawned.
27. **AC27 [NEW]:** A `--version` spawn rejection (`ENOENT`/`EACCES`/`EPERM`/`ENOTDIR`) yields
    `cursor-cli` = `"cursor-executable-unavailable"` and **terminates** the downstream check
    sequence — no `model-catalogue`/`model-{role}`/`prompt-transport-probe` checks are emitted;
    only the `finally` `doctor-probe-cleanup` check is added.
28. **AC28 [NEW]:** Valid catalogue plus one invalid role remains a model-resolution failure, not
    a catalogue failure: `model-catalogue` is `"ok"` and only the failing role is
    `"model-resolution-failure"`. When the failing role is the brainstormer, the prompt probe is
    skipped with `prerequisite: "model-brainstormer"`.
29. **AC29 [NEW]:** The aggregate `resolveProjectModels()` call is removed from the doctor path;
    a role-resolution exception can never enter the catalogue-discovery catch. `listModels()` is
    isolated in a catalogue-only try/catch and each role is resolved exactly once.
30. **AC30 [NEW]:** An unexpected error after a successful `cursor-cli` check is emitted on a
    stable generic `doctor` check with `"doctor-unexpected-error"`; no duplicate failed
    `cursor-cli` check is emitted after a successful `cursor-cli` check.
31. **AC31 [NEW]:** `maswe doctor --json` emits the complete `RuntimeDoctorResult` as JSON
    (`ok`, and each check's `name`, `ok`, `message`, `code`, and optional `prerequisite`), and
    the output is parseable by `JSON.parse()`. No persistence or JSON-Schema claim is made for
    `RuntimeDoctorResult`.
32. **AC32 [NEW]:** Exit status is derived from `report.ok` in both human and `--json` modes; a
    failed report exits non-zero in both. Human `PASS`/`FAIL` line output remains compatible. The
    exact CLI test file is `test/issue17-doctor-cli-json.test.ts`.
33. **AC33 [NEW]:** The exact CI-only gates run and are distinguished from `npm run check`:
    the focused `test/ready-review-corrections.test.ts` run, and the two Issue #11 iteration
    gates (`MASWE_ISSUE11_ALLOCATION_ITERATIONS=25` and `MASWE_ISSUE11_RELEASE_ITERATIONS=100`
    with `--test-name-pattern`), plus Node 22 and exact Node `22.22.2` validation.
34. **AC34 [NEW]:** Packaging leaves no generated artifacts: after `npm pack --json` the worktree
    contains no `.tgz`, no extraction directory, and no temporary artifact, so the final
    `git status --porcelain=v1` clean-tree assertion is mechanically achievable.
35. **AC35 [NEW]:** Process-tree termination is documented as best-effort and **not** observable;
    the design and docs do not claim guaranteed termination. Probe-success semantics are not
    overstated: a passing probe proves only that the command started, stdin was accepted, and the
    process exited zero within the timeout.

---

## Cleanup Timeout Follow-up Proposal

**Owner decision UD3** places cleanup timeout hardening outside Issue #17. The following
defines the scope for a future governed issue. This section is for traceability only; the
follow-up must not be implemented until separately authorized.

### Proposed title

> Bound `cleanupDoctorProbeResources()` and `maswe doctor` total wall-clock duration

### Problem statement

`cleanupDoctorProbeResources()` in `src/git-workspace.ts` currently has no timeout on any of
its git operations (`worktree remove`, `branch -D`). In degenerate conditions — stalled NFS,
locked git index, kernel-held file descriptors — the `finally` block of `CursorCliRuntime.doctor()`
can hang indefinitely after the prompt-transport probe has already completed or timed out.

Issue #17 bounds only the prompt-transport invocation. As a result, the complete `maswe doctor`
command does not have a strict upper bound on its wall-clock duration. CI pipelines treating
`maswe doctor` as a gate may block indefinitely in edge conditions.

### Scope

- Add per-operation timeouts to the git commands inside `cleanupDoctorProbeResources()`.
- Consider a total `maswe doctor` wall-clock deadline that encompasses both the probe and cleanup.
- Consider SIGTERM-before-SIGKILL escalation for cleanup processes.
- Define and test behavior when the cleanup timeout fires: emit a `"cleanup-failure"` check with
  a message indicating timeout, then return without blocking.
- **Own the `"process-termination-failure"` code.** Make process-tree kill failures observable by
  extending the process abstraction (add a termination-outcome field to `SpawnResult` and have
  `killProcessTree()` report errors instead of swallowing them), then surface a
  `"process-termination-failure"` check that is independent of, and does not overwrite, the
  primary probe failure. This is required because the current `spawnCaptured()`/`killProcessTree()`
  interface makes termination failures unobservable to `doctor()`.

### Non-goals

- Do not change the prompt-transport probe timeout (Issue #17 owns that).
- Do not change the general `execute()` timeout or authenticated-smoke worktree lifecycle.
- Do not weaken existing cleanup: if cleanup succeeds within the timeout, all resources must
  still be removed.

### Acceptance criteria

1. Every git operation in `cleanupDoctorProbeResources()` is bounded by a configurable or
   fixed timeout.
2. A cleanup timeout produces a `"cleanup-failure"` check with `ok: false`; it does not
   prevent `doctor()` from returning.
3. Deterministic tests inject a stalled cleanup mock and verify the timeout fires.
4. `maswe doctor` returns within a predictable wall-clock upper bound under test.
5. `npm run check` passes.

### Relationship to Issues #17 and #18

- **Issue #17** (this issue) owns the prompt-transport probe timeout and the emitted
  `DoctorCheckCode` vocabulary. It runs existing cleanup via `finally` without modification and
  does not emit `"process-termination-failure"` (reserved).
- **This follow-up** owns bounding the cleanup phase **and** making termination failures
  observable so that `"process-termination-failure"` can be emitted. It must not change the
  prompt-transport probe timeout.
- **Issue #18** owns authenticated-smoke worktree lifecycle (managed worktrees created by
  smoke tests, not the doctor probe). These are separate resource classes and separate cleanup
  paths.
- **Issue #16** owns the probe output-shape / terminal-marker classification and would be the
  future emitter of the reserved `"probe-malformed-output"` and `"probe-invalid-terminal-marker"`
  codes.

---

## Implementation-plan inputs

### Likely files and change surface

| File | Change |
|---|---|
| `src/domain.ts` | Add `doctorProbeTimeoutMs: number` to `MasweConfig.policy`; export `DoctorCheckCode` 16-value union (12 emitted + 4 reserved) and exact three-value `DoctorCheckPrerequisite`; add required `code: DoctorCheckCode` and optional `prerequisite?: DoctorCheckPrerequisite` to `RuntimeDoctorResult.checks` |
| `src/config.ts` | Add `doctorProbeTimeoutMs: 60_000` to `DEFAULT_CONFIG.policy`; add hard bounds validation in `assertConfig()` (no `!== undefined` guard) |
| `src/runtimes/cursor-cli.ts` | Isolate `listModels()` in a catalogue-only try/catch; resolve each role exactly once from that role's own attempt; capture the brainstormer's resolved exact ID from its own successful result; **remove the aggregate `resolveProjectModels()` call** from the doctor path. Replace `Math.min(5_000, commandTimeoutMs)` with `this.config.policy.doctorProbeTimeoutMs`; add a `code` to every check literal per the emitted mapping; classify the `--version` spawn rejection with ENOENT/EACCES/EPERM/ENOTDIR as `"cursor-executable-unavailable"` on `cursor-cli` (terminating downstream); classify any other pre-cursor-cli-check spawn rejection and any unexpected post-version exception as a **`doctor`** check with `"doctor-unexpected-error"` (never a duplicate `cursor-cli`); split `--version` non-zero/timeout into `"cursor-version-check-failure"`; emit skipped `model-{role}` (`prerequisite: "model-catalogue"`) on catalogue failure and skipped `prompt-transport-probe` with the correct `prerequisite` (`cursor-cli`/`model-catalogue`/`model-brainstormer`); gate `resolveDoctorProbeCwd()` so it is called only when the probe will actually execute (no blocking prerequisite and `promptTransport === "stdin"`). Must **not** construct any reserved code |
| `src/runtimes/mock.ts` | Add `code: "ok"` to the hardcoded `mock-runtime` check object (currently a non-empty check literal) |
| `src/runtimes/cursor-sdk.ts` | Add exact codes to the `cursor-api-key` and `cursor-sdk` check literals: `cursor-api-key` + `CURSOR_API_KEY` present → `"ok"`; `cursor-api-key` + absent → `"cursor-sdk-credential-missing"`; `cursor-sdk` + import succeeds → `"ok"`; `cursor-sdk` + import throws → `"cursor-sdk-unavailable"`. Expose `importFn?: CursorSdkImportFn` injection seam in constructor (defaulting to `importOptional`) so `execute()` and `doctor()` share one import path and tests can inject synthetic outcomes without installing `@cursor/sdk`. |
| `src/cli.ts` | Add the `maswe doctor --json` branch: `console.log(JSON.stringify(report, null, 2))` when `--json` is present, else keep the existing `PASS`/`FAIL` line loop unchanged; keep `process.exitCode = report.ok ? 0 : 1` in both modes. No argument-parser change needed (`positional()` already treats `--json` as a bare flag) |
| `schemas/config.schema.json` | Add optional `doctorProbeTimeoutMs` field under `policy.properties` |
| `test/issue17-doctor-probe-timeout.test.ts` (new) | All typed-code, timeout-selection, bounds, deadline, multiple-failure, classification, probe-resource-gating, and canonical-default tests |
| `test/issue17-doctor-cli-json.test.ts` (new) | Two CLI fixtures: passing (mock runtime) + failing/prerequisite (cursor-cli with temp wrapper); human output, `--json` parseability, typed-code/prerequisite visibility, exit semantics |
| `test/issue17-cursor-sdk-doctor.test.ts` (new) | Deterministic `CursorSdkRuntime.doctor()` tests for import success, missing credential, and import failure paths using the `importFn` injection seam; no `@cursor/sdk` installation required |
| `docs/OPERATIONS.md` | Document new field and compatibility statement |
| `docs/ARCHITECTURE.md` | Update `CursorCliRuntime` description |

### Dependency order

1. `domain.ts` — type changes (`DoctorCheckCode`, `RuntimeDoctorResult.checks`, `MasweConfig.policy`).
2. `config.ts` — `DEFAULT_CONFIG` and `assertConfig()` changes (depends on 1).
3. `cursor-cli.ts` — classification refactor, behavioral change, and code assignment (depends on 1 and 2).
4. `mock.ts` and `cursor-sdk.ts` — add `code` to their non-empty check literals (depends on 1).
5. `cli.ts` — add the `doctor --json` branch (depends on 1).
6. `config.schema.json` — schema change (can be parallel with 1–5).
7. Tests, incl. `test/issue17-doctor-cli-json.test.ts` (depend on 1–5).
8. Documentation (can be parallel with 7).

### Validation gates

- `npm run check` must pass after each step.
- Tests added in step 6 must pass before the implementation is considered complete.
- No existing tests may be weakened or deleted.
- Authenticated validation is performed separately and recorded in the Issue #17 comment thread.

---

## Traceability

- **Primary:** Issue #17 — Harden doctor prompt-transport probe timeout semantics
- **Validated SHA referenced in Issue #17:**
  `c59ae22782b865fda32a600440b707db0289da2e` (PR #15 head; validated externally; predates this
  repo's current HEAD at `277e144`)
- **Related:**
  - Issue #13 — Canonicalize workspace fingerprint framing and filesystem semantics
    (out of scope; workspace hashing changes do not affect doctor probe)
  - Issue #16 — Follow-up: simplify Cursor output and smoke helper APIs
    (out of scope; #16 covers `extractCursorCliOutput` cleanup, authenticated-smoke model
    selection policy, and marker failure codes — it is not a general `execute()` timeout
    refactor and does not govern the probe timeout contract)
  - Issue #18 — Clean up authenticated smoke managed worktrees automatically
    (out of scope for probe-owned resources; #18 governs smoke test harness lifecycle,
    not the doctor probe worktree)
  - Cleanup timeout follow-up — proposed in "Cleanup Timeout Follow-up Proposal" above;
    must be separately authorized before implementation
- **Historical evidence:** PR #15 merge commit `caba625`; external verifier result
  `PASS_WITH_FOLLOW_UPS` for `c59ae22782b865fda32a600440b707db0289da2e` citing 7–14 second
  authenticated response latency vs. 5-second probe timeout.
