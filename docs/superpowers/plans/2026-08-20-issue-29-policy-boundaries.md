# Issue #29 Policy Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make MASWE role authority and untrusted-input boundaries non-bypassable, non-retryable where policy is violated, and durably diagnosable.

**Architecture:** Keep deterministic authority in the existing orchestrator/config/store layers. Add three focused helpers—policy, CLI grammar, and artifact-path confinement—then wire them into existing adapters and persistence with test-first changes. Runtime/transport failures keep current fallback behavior; policy failures short-circuit before fallback aggregation.

**Tech Stack:** TypeScript 7, Node.js standard library (`node:util.parseArgs`, `node:path`, `node:fs`), Node test runner, JSON Schema, Git.

**Spec:** `docs/superpowers/specs/2026-08-20-issue-29-policy-boundaries-design.md`

## Global Constraints

- Exact implementation baseline: `main@a541936919f81f5412e75175053e100332b2a140`.
- Canonical development/runtime Node: `24.18.0`.
- Blocking compatibility floor: exact Node `22.22.2`.
- Supported engine range remains `>=22.22.2 <23 || >=24.18.0 <25`.
- Keep run-record `schemaVersion: 1`.
- Do not weaken read-only fingerprinting, exact-model identity, workflow state authority, or artifact digest checks.
- No new npm dependency unless a standard-library implementation proves insufficient; this plan requires none.
- Every behavior change follows RED → GREEN → regression verification.
- Staging, commit, push, PR creation, merge, and remote branch deletion are separate authorization gates.

---

### Task 1: First-class role policy and stable failure codes

**Files:**
- Create: `src/policy.ts`
- Modify: `src/domain.ts`
- Modify: `src/config.ts`
- Modify: `src/failure-diagnostics.ts`
- Modify: `src/run-record-validation.ts`
- Modify: `schemas/config.schema.json`
- Modify: `schemas/run-record.schema.json`
- Test: `test/issue29-policy.test.ts`
- Test: `test/config.test.ts`
- Test: `test/schema.test.ts`

**Interfaces:**
- Produces `ROLE_PERMISSION_POLICY: Readonly<Record<RoleId, PermissionMode>>`.
- Produces `PolicyViolationCode`, `PolicyViolationError`, `isPolicyViolationError()`.
- Produces `assertConfiguredRolePermission(role, permission)` and `resolveExecutionPermission(role, configured, override?)`.
- `RunFailureCode` gains the four stable `policy-*` values from the design spec.

- [ ] **Step 1: Write failing policy-matrix tests**

Create `test/issue29-policy.test.ts` with table-driven assertions equivalent to:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { mergeConfigForTest } from "../src/config.ts";
import {
  PolicyViolationError,
  ROLE_PERMISSION_POLICY,
  resolveExecutionPermission,
} from "../src/policy.ts";

const roles = Object.entries(ROLE_PERMISSION_POLICY) as Array<
  [keyof typeof ROLE_PERMISSION_POLICY, "read-only" | "workspace-write"]
>;

test("role permissions are an exact persisted/project policy matrix", () => {
  for (const [role, required] of roles) {
    const wrong = required === "read-only" ? "workspace-write" : "read-only";
    assert.throws(
      () => mergeConfigForTest({ roles: { [role]: { permissions: wrong } } }),
      (error: unknown) =>
        error instanceof PolicyViolationError &&
        error.code === "policy-role-permission-mismatch",
    );
  }
});

test("only prResolver may narrow one execution to read-only", () => {
  assert.equal(resolveExecutionPermission("prResolver", "workspace-write", "read-only"), "read-only");
  assert.throws(
    () => resolveExecutionPermission("builder", "workspace-write", "read-only"),
    /permission/i,
  );
  assert.throws(
    () => resolveExecutionPermission("verifier", "read-only", "workspace-write"),
    /permission/i,
  );
});
```

Extend `test/config.test.ts` so whitespace-only quality commands fail while `[]` passes. Extend `test/schema.test.ts` with role `permissions.const`, policy failure-code enum, and quality-item whitespace cases.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
npm run _test -- test/issue29-policy-input-boundaries.test.ts test/issue29-schema-policy.test.ts test/config.test.ts test/schema.test.ts
```

Expected: FAIL because `src/policy.ts` and the new policy codes/constraints do not exist.

- [ ] **Step 3: Implement the policy primitives and validation**

Add to `src/domain.ts`:

```ts
export type PolicyViolationCode =
  | "policy-read-only-workspace-mutation"
  | "policy-runtime-identity-mismatch"
  | "policy-role-permission-mismatch"
  | "policy-read-only-head-moved";

export type RunFailureCode =
  | "runtime-models-exhausted"
  | "workflow-failure"
  | "automatic-transition-limit-exceeded"
  | PolicyViolationCode;
```

Create `src/policy.ts` with exact matrix and typed error:

```ts
import type { PermissionMode, PolicyViolationCode, RoleId } from "./domain.ts";

export const ROLE_PERMISSION_POLICY = Object.freeze({
  brainstormer: "read-only",
  designer: "read-only",
  builder: "workspace-write",
  verifier: "read-only",
  prResolver: "workspace-write",
} satisfies Record<RoleId, PermissionMode>);

export class PolicyViolationError extends Error {
  readonly code: PolicyViolationCode;

  constructor(code: PolicyViolationCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PolicyViolationError";
    this.code = code;
  }
}

export function assertConfiguredRolePermission(role: RoleId, permission: PermissionMode): void {
  const expected = ROLE_PERMISSION_POLICY[role];
  if (permission !== expected) {
    throw new PolicyViolationError(
      "policy-role-permission-mismatch",
      `${role} requires ${expected} permission, got ${permission}.`,
    );
  }
}

export function resolveExecutionPermission(
  role: RoleId,
  configured: PermissionMode,
  override?: PermissionMode,
): PermissionMode {
  assertConfiguredRolePermission(role, configured);
  if (override === undefined) return configured;
  if (role === "prResolver" && override === "read-only") return override;
  throw new PolicyViolationError(
    "policy-role-permission-mismatch",
    `${role} execution cannot override ${configured} permission with ${override}.`,
  );
}

export function findPolicyViolationError(error: unknown): PolicyViolationError | undefined {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length) {
    const candidate = pending.pop();
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof PolicyViolationError) return candidate;
    if (candidate instanceof AggregateError) pending.push(...candidate.errors);
    if (candidate instanceof Error && candidate.cause !== undefined) pending.push(candidate.cause);
  }
  return undefined;
}

export const isPolicyViolationError = (error: unknown): error is PolicyViolationError =>
  error instanceof PolicyViolationError;
```

In `assertConfig()`, call `assertConfiguredRolePermission(role as RoleId, roleConfig.permissions)` after enum validation. Change quality validation to require `command.trim().length > 0`. Add matching JSON Schema constraints and run-record failure enums. Update `runFailureCode()` to return a found policy error's code before checking runtime exhaustion.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the same focused command. Expected: PASS.

- [ ] **Step 5: Authorization-gated commit checkpoint**

After explicit commit authorization only:

```bash
git add src/policy.ts src/domain.ts src/config.ts src/failure-diagnostics.ts src/run-record-validation.ts schemas/config.schema.json schemas/run-record.schema.json test/issue29-policy-input-boundaries.test.ts test/issue29-schema-policy.test.ts test/config.test.ts test/schema.test.ts
git commit -m "feat: enforce non-bypassable role policy"
```

---

### Task 2: Orchestrator-owned read-only execution fence and non-fallback policy failures

**Files:**
- Modify: `src/orchestrator.ts`
- Modify: `src/failure-diagnostics.ts`
- Modify: `src/runtimes/cursor-cli.ts`
- Modify: `src/runtimes/cursor-sdk.ts`
- Test: `test/issue29-runtime-policy.test.ts`

**Interfaces:**
- Consumes `PolicyViolationError`, `isPolicyViolationError()`, and `resolveExecutionPermission()` from Task 1.
- Adds an internal `captureReadOnlyExecutionState(workdir)` and `assertReadOnlyExecutionState(...)` in the orchestrator.
- `executeAgent()` replaces arbitrary `RoleConfig` override with `{ permissionOverride?: PermissionMode }`.

- [ ] **Step 1: Write failing non-fallback and read-only-fence tests**

Use a deterministic fake runtime that records requested models. Cover:

```ts
test("read-only workspace mutation is policy failure and skips fallback", async () => {
  // Configure rejectModelFallback=false with two models.
  // Runtime mutates a tracked/untracked file during verifier execution and returns/throws.
  // Expect failed run code policy-read-only-workspace-mutation.
  // Expect runtime calls === 1.
});

test("read-only HEAD movement is distinct and skips fallback", async () => {
  // Runtime creates a commit/reset on the read-only workdir.
  // Expect policy-read-only-head-moved and one runtime call.
});

test("runtime model identity mismatch is policy failure and skips fallback", async () => {
  // Runtime reports actualModel different from requestedModel.
  // Expect policy-runtime-identity-mismatch and one runtime call.
});

test("ordinary runtime failure still uses configured fallback", async () => {
  // First model returns a typed runtime failure; second succeeds.
  // Expect two calls and success.
});
```

Also cover the `prResolver` classifier path and assert its runtime request has `permissions: "read-only"` while the persisted config remains `workspace-write`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
npm run _test -- test/issue29-runtime-policy.test.ts
```

Expected: current `executeAgent()` retries policy failures and has no orchestrator read-only fence.

- [ ] **Step 3: Implement the read-only fence**

In `executeAgent()`:

```ts
const configured = run.config.roles[role];
const permissions = resolveExecutionPermission(
  role,
  configured.permissions,
  executionOptions?.permissionOverride,
);
const effective = { ...configured, permissions };
```

For each model, if `permissions === "read-only"`, capture:

```ts
const beforeFingerprint = await gitWorkspaceFingerprint(workdir);
const git = await isGitRepository(workdir);
const beforeHead = git ? await gitRevParse(workdir, "HEAD") : undefined;
```

Wrap `runtime.execute()` so the post-check runs after both return and throw. Post-check:

```ts
const afterHead = beforeHead === undefined ? undefined : await gitRevParse(workdir, "HEAD");
if (beforeHead !== undefined && afterHead !== beforeHead) {
  throw new PolicyViolationError("policy-read-only-head-moved", `${role} changed HEAD during read-only execution.`);
}
const afterFingerprint = await gitWorkspaceFingerprint(workdir);
if (afterFingerprint !== beforeFingerprint) {
  throw new PolicyViolationError(
    "policy-read-only-workspace-mutation",
    `${role} modified the workspace during read-only execution.`,
  );
}
```

In the `catch`, immediately `throw` if `isPolicyViolationError(error)`; only runtime failures reach `runtimeAttemptFailure()`.

Always call `assertRuntimeIdentity(result, role)` after `ensureRuntimeSuccess()`; the helper itself is a no-op when no actual model is reported.

Change classifier call to:

```ts
this.executeAgent(run, "prResolver", prompt, { permissionOverride: "read-only" })
```

In Cursor CLI/SDK, replace plain read-only mutation errors with `PolicyViolationError("policy-read-only-workspace-mutation", ...)`.

- [ ] **Step 4: Verify GREEN plus existing runtime tests**

```bash
npm run _test -- test/issue29-runtime-policy.test.ts test/orchestrator.test.ts test/readonly-fingerprint.test.ts test/cursor-sdk.test.ts
```

Expected: PASS; ordinary runtime fallback behavior remains covered.

- [ ] **Step 5: Authorization-gated commit checkpoint**

After explicit authorization only:

```bash
git add src/orchestrator.ts src/failure-diagnostics.ts src/runtimes/cursor-cli.ts src/runtimes/cursor-sdk.ts test/issue29-runtime-policy.test.ts
git commit -m "fix: stop fallback on execution policy violations"
```

---

### Task 3: Single-pass prompt rendering

**Files:**
- Modify: `src/prompt-builder.ts`
- Test: `test/issue29-prompt-rendering.test.ts`

**Interfaces:**
- Produces exported `renderPromptTemplate(template, values)` for focused tests.
- Unknown template placeholders reject deterministically.

- [ ] **Step 1: Write failing renderer tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { renderPromptTemplate } from "../src/prompt-builder.ts";

test("replacement values are literal and never rescanned", () => {
  assert.equal(
    renderPromptTemplate("A={{A}} B={{B}}", { A: "{{B}}", B: "expanded" }),
    "A={{B}} B=expanded",
  );
});

test("unknown prompt placeholders fail deterministically", () => {
  assert.throws(
    () => renderPromptTemplate("{{KNOWN}} {{UNKNOWN}}", { KNOWN: "ok" }),
    /Unknown prompt placeholder \{\{UNKNOWN\}\}/,
  );
});
```

- [ ] **Step 2: Run RED**

```bash
npm run _test -- test/issue29-prompt-rendering.test.ts
```

- [ ] **Step 3: Implement one original-template scan**

```ts
const PROMPT_PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

export function renderPromptTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(PROMPT_PLACEHOLDER, (token, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`Unknown prompt placeholder ${token}`);
    }
    return values[key]!;
  });
}
```

Route existing prompt construction through this function.

- [ ] **Step 4: Run GREEN and prompt/marker regressions**

```bash
npm run _test -- test/issue29-prompt-rendering.test.ts test/json-marker-pipeline.test.ts test/markers.test.ts test/markers-strict.test.ts
```

- [ ] **Step 5: Authorization-gated commit checkpoint**

```bash
git add src/prompt-builder.ts test/issue29-prompt-rendering.test.ts
git commit -m "fix: render prompt placeholders in one pass"
```

---

### Task 4: Strict CLI grammar with `node:util.parseArgs`

**Files:**
- Create: `src/cli-args.ts`
- Modify: `src/cli-runner.ts`
- Test: `test/issue29-cli-args.test.ts`
- Test: `test/node-version-cli.test.ts`

**Interfaces:**
- Produces `parseMasweArgs(argv): ParsedMasweArgs` where options are typed and command positionals are already validated.
- `cli-runner` no longer uses `option()`, `has()`, or `positional()` scanners.

- [ ] **Step 1: Write failing parser matrix**

Table-drive at least these cases:

```ts
["start split", ["start", "--title", "T", "--request", "R"], true],
["start equals", ["start", "--title=T", "--request=R"], true],
["global before", ["--cwd", "/tmp/x", "status", "run-1"], true],
["global after", ["status", "run-1", "--cwd=/tmp/x"], true],
["boolean leaves positional", ["status", "--json", "run-1"], true],
["unknown", ["status", "--wat"], false],
["duplicate split/equals", ["status", "--cwd", "a", "--cwd=b"], false],
["missing string", ["start", "--title"], false],
["wrong option for command", ["run", "r1", "--force"], false],
["start both request forms", ["start", "--title", "T", "--request", "R", "--request-file", "r.md"], false],
["review both forms", ["review-comment", "r1", "--text", "x", "--file", "x.md"], false],
["extra positional", ["run", "r1", "r2"], false],
```

- [ ] **Step 2: Run RED**

```bash
npm run _test -- test/issue29-cli-args.test.ts
```

- [ ] **Step 3: Implement the parser**

Use:

```ts
import { parseArgs } from "node:util";

const parsed = parseArgs({
  args: argv,
  allowPositionals: true,
  strict: true,
  tokens: true,
  options: {
    config: { type: "string" },
    cwd: { type: "string" },
    json: { type: "boolean" },
    force: { type: "boolean" },
    title: { type: "string" },
    request: { type: "string" },
    "request-file": { type: "string" },
    text: { type: "string" },
    file: { type: "string" },
  },
});
```

Inspect option tokens and reject a name seen more than once. Take the first positional as command and validate the remaining positionals and command option allowlist with one declarative `COMMAND_SPECS` map. Enforce mutual-exclusion/required pairs after generic validation.

Update `runCli()` to use typed `parsed.options` and `parsed.positionals`; remove ad-hoc scanners.

- [ ] **Step 4: Run GREEN and existing CLI suites**

```bash
npm run _test -- test/issue29-cli-args.test.ts test/node-version-cli.test.ts test/issue17-doctor-cli-json.test.ts test/github-cli-http.test.ts
```

- [ ] **Step 5: Authorization-gated commit checkpoint**

```bash
git add src/cli-args.ts src/cli-runner.ts test/issue29-cli-args.test.ts test/node-version-cli.test.ts
git commit -m "fix: make cli argument grammar strict"
```

---

### Task 5: Correct allowed-path glob semantics

**Files:**
- Modify: `src/git-workspace.ts`
- Test: `test/issue29-globs.test.ts`
- Test: `test/git-workspace.test.ts`

**Interfaces:**
- Export `matchPathGlobForTest(pattern, candidate)` only if a public test seam is needed; otherwise test via `assertWorkingTreeScope()`.
- Preserve complete-path anchoring and existing `pathAllowed()` call sites.

- [ ] **Step 1: Write failing glob semantics tests**

Assert:

```ts
// **/*.ts includes root and nested files.
["**/*.ts", "index.ts", true],
["**/*.ts", "src/index.ts", true],
// ? is one non-separator character.
["src/?.ts", "src/a.ts", true],
["src/?.ts", "src/ab.ts", false],
// **/ is zero or more segments.
["**/README.md", "README.md", true],
["**/README.md", "docs/README.md", true],
// dotfiles are ordinary characters.
["**/*", ".env.example", true],
// candidate/pattern Windows separators normalize.
["src\\**\\*.ts", "src\\nested\\x.ts", true],
// regex metacharacters are literals.
["src/a+b[1].ts", "src/a+b[1].ts", true],
```

- [ ] **Step 2: Run RED**

```bash
npm run _test -- test/issue29-globs.test.ts
```

- [ ] **Step 3: Replace placeholder regex translation with a token compiler**

Implement a character scanner that normalizes `\` to `/` and emits:

```ts
"*"   -> "[^/]*"
"?"   -> "[^/]"
"**"  -> ".*"
"**/" -> "(?:.*/)?"
```

Escape every other regex metacharacter (`. + ^ $ { } ( ) | [ ] \\`). Compile `^${source}$`.

- [ ] **Step 4: Run GREEN and scope regressions**

```bash
npm run _test -- test/issue29-globs.test.ts test/git-workspace.test.ts test/commit-provenance.test.ts
```

- [ ] **Step 5: Authorization-gated commit checkpoint**

```bash
git add src/git-workspace.ts test/issue29-globs.test.ts test/git-workspace.test.ts
git commit -m "fix: define portable path glob semantics"
```

---

### Task 6: Artifact-reference confinement and bounded no-follow reads

**Files:**
- Create: `src/artifact-path.ts`
- Modify: `src/store.ts`
- Modify: `schemas/run-record.schema.json`
- Test: `test/issue29-artifact-confinement.test.ts`
- Test: `test/artifact-cas.test.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces `canonicalArtifactReferencePath(runId, fileName)` for new writes.
- Produces `validateArtifactReferencePath(runId, persistedPath): { canonicalPath, fileName }` for migration/read.

- [ ] **Step 1: Write failing lexical and filesystem tests**

Lexical cases must reject:

```text
../outside
.maswe/runs/<id>/artifacts/../run.json
.maswe/runs/other/artifacts/x.md
/absolute/x.md
C:\absolute\x.md
C:relative\x.md
\\server\share\x.md
\rooted\x.md
.maswe//runs/<id>/artifacts/x.md
.maswe/runs/<id>/artifacts/nested/x.md
```

Filesystem cases create a legitimate run and then verify read-time rejection for:

- artifact directory replaced by symlink;
- artifact file replaced by symlink;
- artifact path replaced by directory/FIFO where supported;
- file larger than `MAX_AUTHORITATIVE_FILE_BYTES`;
- digest mismatch.

Also prove a valid artifact round-trip still succeeds.

- [ ] **Step 2: Run RED**

```bash
npm run _test -- test/issue29-artifact-confinement.test.ts test/artifact-cas.test.ts
```

- [ ] **Step 3: Implement portable lexical validation**

Use both `path.posix` and `path.win32` rooted checks before separator normalization. Reject any raw drive prefix (`/^[A-Za-z]:/`) so drive-relative paths fail too. Normalize `\` to `/`, require exactly:

```ts
[".maswe", "runs", runId, "artifacts", fileName]
```

Require non-empty ordinary `fileName` with no `.`/`..`. Return canonical `/` path.

- [ ] **Step 4: Wire migration, writes, and reads**

In `migrateRunRecord()`, parse/validate the run ID before mapping artifact references, then validate every artifact path with that run ID.

In `writeArtifact()`, construct new persisted paths with the canonical helper.

In `readArtifact()`:

```ts
const { fileName } = validateArtifactReferencePath(run.id, reference.path);
const artifactDirectory = path.join(this.root, run.id, "artifacts");
await requireOrdinaryDirectory(artifactDirectory, "run artifact namespace");
const content = await readBoundedOrdinaryFile(
  path.join(artifactDirectory, fileName),
  "run artifact",
  MAX_AUTHORITATIVE_FILE_BYTES,
);
```

Then retain the existing SHA-256 equality check.

- [ ] **Step 5: Run GREEN and store regressions**

```bash
npm run _test -- test/issue29-artifact-confinement.test.ts test/artifact-cas.test.ts test/store.test.ts test/readonly-fingerprint.test.ts
```

- [ ] **Step 6: Authorization-gated commit checkpoint**

```bash
git add src/artifact-path.ts src/store.ts schemas/run-record.schema.json test/issue29-artifact-confinement.test.ts test/artifact-cas.test.ts test/store.test.ts
git commit -m "fix: confine run artifact references"
```

---

### Task 7: Documentation and contract alignment

**Files:**
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/ARTIFACT_CONTRACTS.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `skills/maswe/references/commands.md`

**Interfaces:**
- Documentation must use the exact durable `policy-*` codes and role matrix implemented by Tasks 1–6.

- [ ] **Step 1: Update architecture/security contracts**

Document:

- role matrix as deterministic authority;
- orchestrator read-only fence outside adapters;
- policy failures do not enter fallback aggregation;
- identity mismatch is a policy failure;
- CLI is strict and globals may appear before/after command;
- glob semantics and separator normalization;
- `quality.commands: []` versus blank entries;
- artifact direct-child namespace, no-follow bounded reads, and digest verification.

- [ ] **Step 2: Update user-facing command examples**

Include at least one `--name=value` example and make `start`/`review-comment` alternatives visibly exclusive.

- [ ] **Step 3: Verify documentation references**

```bash
grep -R "policy-read-only-workspace-mutation\|policy-runtime-identity-mismatch\|policy-role-permission-mismatch\|policy-read-only-head-moved" docs README.md skills/maswe/references/commands.md
```

Expected: stable codes appear only where the policy contract is explained; no stale statement says all thrown execution errors become model failures.

- [ ] **Step 4: Authorization-gated commit checkpoint**

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md docs/ARTIFACT_CONTRACTS.md README.md CHANGELOG.md skills/maswe/references/commands.md
git commit -m "docs: document issue 29 policy boundaries"
```

---

### Task 8: Exact-head verification on both supported validation runtimes

**Files:**
- No production changes unless verification exposes a new regression; any correction starts with a failing regression test.

**Interfaces:**
- Verifies AC-29.1 through AC-29.13 against one exact uncommitted/committed head.

- [ ] **Step 1: Canonical Node 24.18.0 verification**

```bash
nvm use 24.18.0
node --version
npm ci
npm run check
npm run pack:dry
git diff --check
```

Expected Node output: `v24.18.0`; all commands PASS.

- [ ] **Step 2: Blocking Node 22.22.2 compatibility verification**

```bash
nvm use 22.22.2
node --version
npm ci
npm run check
npm run pack:dry
git diff --check
```

Expected Node output: `v22.22.2`; all commands PASS.

- [ ] **Step 3: Focused acceptance rerun at exact head**

```bash
npm run _test -- \
  test/issue29-policy.test.ts \
  test/issue29-runtime-policy.test.ts \
  test/issue29-prompt-rendering.test.ts \
  test/issue29-cli-args.test.ts \
  test/issue29-globs.test.ts \
  test/issue29-artifact-confinement.test.ts
```

Expected: PASS on both Node versions.

- [ ] **Step 4: Inspect exact changed scope**

```bash
git status --short
git diff --stat
git diff --name-only
git diff --check
```

Confirm no Issue #28 cleanup artifacts or unrelated generated files are present.

- [ ] **Step 5: Stop at the authorization boundary**

Do not stage, commit, push, open a PR, or merge unless the owner separately authorizes that action. Report the exact current HEAD/base, changed files, validation results, and any remaining blockers.

## Plan self-review

- **Spec coverage:** AC-29.1–29.13 map to Tasks 1–8; all seven issue defect families have a production task plus focused tests.
- **Placeholder scan:** no TBD/TODO/later implementation steps remain.
- **Type consistency:** policy codes are defined once in `domain.ts`; `PolicyViolationError` uses those codes; `runFailureCode` persists the same values; JSON Schema mirrors them.
- **Authority consistency:** only the classifier gets a read-only execution narrowing; persisted `prResolver` remains workspace-write.
- **Retry consistency:** policy failures are thrown before runtime-attempt aggregation; ordinary runtime errors retain existing fallback semantics.
- **Filesystem consistency:** artifact absolute paths are derived from trusted store roots and validated physical filenames, not from persisted path joins.
