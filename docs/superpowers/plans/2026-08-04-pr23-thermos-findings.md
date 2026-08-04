# PR 23 Thermos Findings Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the three validated PR #23 findings: symlink-safe standalone guard execution, deterministic focused child-probe output, and synchronized Node portability documentation.

**Architecture:** Preserve the approved dual policy surfaces and current CLI bootstrap. Canonicalize only the standalone guard's executable entry path, use synchronous file-descriptor writes for short-lived child probes, and align the PRD/checklist with the already approved bounded Node contract.

**Tech Stack:** TypeScript ESM, dependency-free JavaScript ESM guard, Node.js built-in test runner, Node core filesystem/process APIs, Markdown documentation.

## Global Constraints

- Canonical Node baseline remains exact `24.18.0` from `.nvmrc`.
- Supported range remains `>=22.22.2 <23 || >=24.18.0 <25`; exact Node `22.22.2` remains the blocking compatibility floor.
- Do not add runtime or development dependencies.
- The standalone guard must perform no network access, installation, runtime switching, or repository mutation.
- Preserve the synchronized duplicate policy implementations approved by the Node runtime design.
- Do not refactor the CLI bootstrap, orchestration, state machine, runtime adapters, approvals, scopes, models, or verification policy.
- Write tests before production behavior changes and observe the intended red failure.
- Keep TypeScript compatible with Node `--experimental-strip-types`.

---

### Task 1: Make standalone guard entry detection symlink-safe

**Files:**
- Modify: `test/node-version-policy.test.ts:1-241`
- Modify: `scripts/verify-node-version.mjs:1-87`

**Interfaces:**
- Consumes: `spawnFileCaptured(command, args, { cwd, timeoutMs })` from `test/helpers/child-process.ts`.
- Produces: internal `isInvokedAsProgram(): boolean` in the standalone guard and stable failure code `MASWE_NODE_GUARD_ENTRY_RESOLUTION_FAILED` for entry canonicalization failure.

- [ ] **Step 1: Add the symlink and canonicalization-failure regressions**

Extend the test imports:

```ts
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import { spawnFileCaptured } from "./helpers/child-process.ts";
```

Add these tests after the existing standalone policy tests:

```ts
test("standalone guard rejects an unsupported runtime through a symlinked entry path", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-node-guard-symlink-"));
  try {
    const linkedGuard = path.join(root, "verify-node-version.mjs");
    await symlink(standaloneGuardPath, linkedGuard);
    const injectedVersionUrl = `data:text/javascript,${encodeURIComponent(
      'Object.defineProperty(process.versions, "node", { value: "25.9.0" });',
    )}`;

    const result = await spawnFileCaptured(
      process.execPath,
      ["--import", injectedVersionUrl, linkedGuard],
      { cwd: root, timeoutMs: 5_000 },
    );

    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /MASWE_UNSUPPORTED_NODE_VERSION/);
    assert.match(result.stderr, /25\.9\.0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("standalone guard fails closed when its executable entry cannot be canonicalized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-node-guard-entry-"));
  try {
    const missingEntry = path.join(root, "missing-entry.mjs");
    const guardUrl = pathToFileURL(standaloneGuardPath).href;
    const probe = `process.argv[1] = ${JSON.stringify(missingEntry)}; await import(${JSON.stringify(guardUrl)});`;

    const result = await spawnFileCaptured(
      process.execPath,
      ["--input-type=module", "--eval", probe],
      { cwd: root, timeoutMs: 5_000 },
    );

    assert.equal(result.code, 1);
    assert.equal(
      result.stderr,
      "MASWE_NODE_GUARD_ENTRY_RESOLUTION_FAILED: unable to canonicalize Node guard entry path.\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

Update the dependency-free import expectation to allow exactly the two Node built-ins used by the corrected guard:

```ts
assert.deepEqual(imports, ["node:fs", "node:url"]);
```

- [ ] **Step 2: Run the new tests and verify the intended red failures**

Run:

```bash
node --experimental-strip-types --test-name-pattern='symlinked entry path|cannot be canonicalized' test/node-version-policy.test.ts
```

Expected: both new tests fail. The symlink probe exits `0` instead of `1`, and the missing-entry probe exits `0` without the stable diagnostic.

- [ ] **Step 3: Implement canonical, fail-closed entry detection**

Replace the guard's URL-only import and lexical comparison with:

```js
import { realpathSync, writeSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ENTRY_RESOLUTION_FAILURE_CODE = "MASWE_NODE_GUARD_ENTRY_RESOLUTION_FAILED";

function isInvokedAsProgram() {
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  try {
    return realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    writeSync(
      2,
      `${ENTRY_RESOLUTION_FAILURE_CODE}: unable to canonicalize Node guard entry path.\n`,
    );
    process.exitCode = 1;
    return false;
  }
}

const invokedAsProgram = isInvokedAsProgram();
```

Use the already imported synchronous writer for the unsupported-runtime diagnostic without changing its text:

```js
writeSync(2, `${message}\n`);
```

- [ ] **Step 4: Run the guard tests and verify green**

Run:

```bash
node --experimental-strip-types --test test/node-version-policy.test.ts
```

Expected: every test in `test/node-version-policy.test.ts` passes, including direct import, explicit `undefined`, symlink execution, canonicalization failure, and dependency-free import checks.

- [ ] **Step 5: Commit the guard correction**

```bash
git add scripts/verify-node-version.mjs test/node-version-policy.test.ts
git commit -m "fix: guard symlinked Node entry paths"
```

### Task 2: Make focused child-probe output deterministic

**Files:**
- Modify: `test/node-version-policy.test.ts:161-232`
- Modify: `test/node-version-scripts.test.ts:59-87`

**Interfaces:**
- Consumes: Node core `writeSync(fd, data)` inside spawned ESM probe strings.
- Produces: deterministic JSON on descriptor `1` and deterministic diagnostic text on descriptor `2` under `node:test`.

- [ ] **Step 1: Record the existing focused-suite red state**

Run:

```bash
node --experimental-strip-types --test test/node-version-policy.test.ts test/node-version-scripts.test.ts test/node-version-cli.test.ts test/node22-child-output.test.ts
```

Expected before this task's edits: `test/node-version-policy.test.ts` and `test/node-version-scripts.test.ts` fail because nested probes exit with the expected status but return empty buffered stdout/stderr. The CLI and child-output files pass.

- [ ] **Step 2: Replace buffered writes in the three inline probes**

In the standalone/TypeScript parity probe, import the synchronous writer and emit JSON through descriptor 1:

```ts
`import { writeSync } from "node:fs";
 import * as p from ${JSON.stringify(scriptUrl)};
 const versions = ${JSON.stringify([...supportedCases, ...unsupportedCases, ...malformedCases])};
 writeSync(1, JSON.stringify({
   canonical: p.CANONICAL_NODE_VERSION,
   floor: p.NODE_COMPATIBILITY_FLOOR,
   range: p.SUPPORTED_NODE_RANGE,
   code: p.UNSUPPORTED_NODE_VERSION_CODE,
   decisions: versions.map((version) => [version, p.isSupportedNodeVersion(version)]),
 }));`,
```

In the explicit-`undefined` probe, import `writeSync` and replace its stdout write:

```ts
`import { writeSync } from "node:fs";
 import { assertSupportedNodeVersion } from ${JSON.stringify(scriptUrl)};
 try {
   assertSupportedNodeVersion(undefined);
   process.exitCode = 9;
 } catch (error) {
   writeSync(1, JSON.stringify({ name: error.name, code: error.code, message: error.message }));
   process.exitCode = 1;
 }`,
```

In the standalone assertion seam, import `writeSync` and replace its stderr write:

```ts
`import { writeSync } from "node:fs";
 import { assertSupportedNodeVersion } from ${JSON.stringify(guardUrl)};
 try {
   assertSupportedNodeVersion("25.9.0");
   process.exitCode = 9;
 } catch (error) {
   writeSync(2, String(error.code) + "\n" + String(error.message));
   process.exitCode = 1;
 }`,
```

- [ ] **Step 3: Run the exact focused suite and verify green**

Run:

```bash
node --experimental-strip-types --test test/node-version-policy.test.ts test/node-version-scripts.test.ts test/node-version-cli.test.ts test/node22-child-output.test.ts
```

Expected: all four test files pass with no empty-output parse or assertion failures.

- [ ] **Step 4: Repeat the focused suite to reject timing-sensitive success**

Run:

```bash
for attempt in {1..10}; do
  node --experimental-strip-types --test test/node-version-policy.test.ts test/node-version-scripts.test.ts test/node-version-cli.test.ts test/node22-child-output.test.ts >/dev/null || exit 1
done
```

Expected: exit code `0` after all ten iterations.

- [ ] **Step 5: Commit deterministic child output**

```bash
git add test/node-version-policy.test.ts test/node-version-scripts.test.ts
git commit -m "test: make Node guard probes deterministic"
```

### Task 3: Synchronize the portability contract

**Files:**
- Modify: `docs/PRD.md:219-221`
- Modify: `docs/DEVELOPMENT.md:101-110`

**Interfaces:**
- Consumes: the approved literal range and baseline roles from `.nvmrc`, `package.json`, and the Node runtime design.
- Produces: one authoritative portability requirement and a checklist that requires PRD review for every governed Node policy change.

- [ ] **Step 1: Update PRD NFR-4 with the approved contract**

Replace the existing portability sentence with:

```markdown
The local product shall run on macOS, Linux, and Windows with Node.js in the supported range `>=22.22.2 <23 || >=24.18.0 <25`, where the configured Cursor CLI command and project commands are available. Exact Node `24.18.0` is the canonical contributor and primary-CI baseline; exact Node `22.22.2` is the blocking compatibility floor.
```

- [ ] **Step 2: Add the PRD to the governed update checklist**

Replace checklist item 5 with:

```markdown
5. PRD portability requirements, README, development, operations, architecture, agent guidance, and changelog.
```

- [ ] **Step 3: Audit the active documentation for stale support claims**

Run:

```bash
rg -n '22\.15\+|>=22\.15|Node\.js 22\.15' docs/PRD.md docs/DEVELOPMENT.md docs/ARCHITECTURE.md docs/OPERATIONS.md README.md AGENTS.md CHANGELOG.md
```

Expected: no matches.

- [ ] **Step 4: Commit the documentation synchronization**

```bash
git add docs/PRD.md docs/DEVELOPMENT.md
git commit -m "docs: synchronize Node portability contract"
```

### Task 4: Verify the exact-head resolution

**Files:**
- Verify only: all files changed by Tasks 1-3 and the approved design/plan documents.

**Interfaces:**
- Consumes: canonical Node `24.18.0`, repository scripts, focused regression command, and package allowlist.
- Produces: exact-head evidence suitable for updating PR #23 without changing its draft or merge authorization state.

- [ ] **Step 1: Record canonical runtime identity**

Run:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
```

Expected: Node reports exact `v24.18.0`; record the selected binary and npm version separately from Node 22 compatibility evidence.

- [ ] **Step 2: Run the focused regression suite**

Run:

```bash
node --experimental-strip-types --test test/node-version-policy.test.ts test/node-version-scripts.test.ts test/node-version-cli.test.ts test/node22-child-output.test.ts
```

Expected: all focused tests pass with zero failures.

- [ ] **Step 3: Run the required repository check**

Run:

```bash
npm run check
```

Expected: Node verification, type checking, the complete test suite, and the production build all exit `0`.

- [ ] **Step 4: Verify packaged contents**

Run:

```bash
npm run pack:dry
```

Expected: exit `0`; the package includes `scripts/verify-node-version.mjs`, `dist/cli.js`, `dist/cli-runner.js`, and `dist/node-version.js`.

- [ ] **Step 5: Audit formatting and scope**

Run:

```bash
git diff --check origin/main...HEAD
git status --short
git diff --stat origin/main...HEAD
```

Expected: no whitespace errors; only the approved PR #23 scope plus the Thermos resolution spec/plan and fixes are present; no package tarball or `node_modules` path is tracked.

- [ ] **Step 6: Review commit history without changing PR state**

Run:

```bash
git log --oneline --decorate -n 8
```

Expected: separate design, guard, deterministic-test, and documentation commits are visible. Do not mark the PR ready, merge, enable auto-merge, or infer repository-owner merge authorization.

