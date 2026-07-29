# Node.js Runtime Baseline Drift Implementation Plan

Date: 2026-07-29  
Status: **PLAN READY FOR OWNER REVIEW — IMPLEMENTATION NOT AUTHORIZED**  
Repository: `tomazb/cursor-multi-agent-software-engineer`  
Design PR: `#22`  
Approved design: `docs/superpowers/specs/2026-07-29-node-runtime-baseline-drift-design.md`  
Design base: `main@59378e60d045d4d78920970d0993fbbedc55e7b9`

## 1. Authorization and hard gate

The repository owner approved the selected design policy on 2026-07-29:

- canonical development and primary CI baseline: exact Node `24.18.0`;
- supported compatibility floor: exact Node `22.22.2`;
- bounded supported range: `>=22.22.2 <23 || >=24.18.0 <25`;
- Node 22 remains blocking compatibility coverage but is not the sole supported major;
- `.nvmrc`, bounded engine metadata, layered fail-fast enforcement, and same-runtime `process.execPath` policy are accepted.

That approval authorizes this plan only.

**Do not implement this plan until the owner explicitly approves this exact plan.**

PR #22 remains docs-only and draft. No `.nvmrc`, `.npmrc`, package metadata, runtime guard, script, CI, or product documentation implementation change belongs on the design branch.

## 2. Branch and publication strategy

After explicit plan approval:

1. Re-fetch PR #22 and verify its exact head, changed-file inventory, CI, reviews, and unresolved-thread state.
2. Keep PR #22 docs-only.
3. Mark PR #22 ready only after the owner separately authorizes that transition.
4. Merge PR #22 using an expected-head guard after all docs-only gates pass.
5. Re-fetch the resulting current `main`.
6. Create a **fresh implementation branch from that post-merge `main`**, suggested name:

   ```text
   issue/node-runtime-baseline-contract
   ```

7. Re-run the baseline inventory before the first implementation commit. If current `main` moved or any relevant file changed, amend the plan before implementation rather than silently applying stale assumptions.

Implementation must not continue on `docs/node-runtime-baseline-drift-design`.

## 3. Fresh-baseline observations used by this plan

At `main@59378e60d045d4d78920970d0993fbbedc55e7b9`:

- `.nvmrc` is absent.
- `.npmrc` is absent.
- `package.json#engines.node` is `>=22.15`.
- `package-lock.json` root package metadata also declares `>=22.15`.
- `package.json` scripts use plain `node` for tests, development, and start.
- the primary CI job uses floating Node major `22`;
- the compatibility job uses exact Node `22.22.2`;
- `src/cli.ts` has `#!/usr/bin/env node` and creates its `FileRunStore` after argument handling, but has no runtime-version guard;
- current same-runtime child-process regression code already uses `process.execPath` in `test/node22-child-output.test.ts`;
- the Node doctor transport stand-in is an intentional configured command seam, not an internal implicit child-runtime selection;
- stale Node guidance remains in `README.md`, `docs/DEVELOPMENT.md`, `AGENTS.md`, and related operational/architecture documentation.

The implementation recheck must confirm these observations before editing.

## 4. Intended implementation inventory

### 4.1 New files

- `.nvmrc`
- `.npmrc`
- `scripts/verify-node-version.mjs`
- `src/node-version.ts`
- `test/node-version-policy.test.ts`
- `test/node-version-cli.test.ts`
- `test/node-version-scripts.test.ts`

### 4.2 Modified files

- `package.json`
- `package-lock.json`
- `src/cli.ts`
- `test/node22-child-output.test.ts`
- `.github/workflows/ci.yml`
- `README.md`
- `docs/DEVELOPMENT.md`
- `docs/OPERATIONS.md`
- `docs/ARCHITECTURE.md`
- `AGENTS.md`
- `CHANGELOG.md`

### 4.3 Audit-only files unless the recheck proves a required change

- `src/process.ts`
- `src/runtimes/cursor-cli.ts`
- `test/helpers/child-process.ts`
- test files that launch child programs for non-Node fixtures or intentionally test PATH/shebang behavior
- target-repository quality-command handling

No audit-only file may be changed merely for stylistic consistency.

## 5. Policy implementation shape

### 5.1 Canonical constants

The implementation will expose these values in the dependency-free guard and TypeScript runtime module:

```text
canonical version: 24.18.0
supported range:   >=22.22.2 <23 || >=24.18.0 <25
failure code:      MASWE_UNSUPPORTED_NODE_VERSION
```

`package.json`, `package-lock.json`, `.nvmrc`, the standalone guard, the TypeScript guard, tests, CI, and documentation must remain synchronized.

Because `package.json#engines` cannot consume an external policy file, the implementation may duplicate the range in package metadata and code only if `test/node-version-policy.test.ts` deterministically proves exact synchronization. Silent duplication without a drift test is prohibited.

### 5.2 Version parsing

Use a small dependency-free parser rather than adding a semver dependency solely for this policy.

The parser must:

- accept only stable numeric `major.minor.patch` input;
- treat `process.versions.node` as the production source;
- reject missing, malformed, truncated, negative, prerelease-suffixed, or non-numeric values in test seams;
- compare numeric components, not strings;
- accept:
  - `22.22.2` and later `22.x` patches;
  - `24.18.0` and later `24.x` patches below `25.0.0`;
- reject:
  - all versions below `22.22.2`;
  - every Node 23 version;
  - Node 24 below `24.18.0`;
  - every Node 25 version;
  - Node 26 and later until a later policy change.

### 5.3 Standalone guard

`scripts/verify-node-version.mjs` will:

- have no project-runtime or third-party imports;
- export pure parse/support/assert helpers for deterministic tests;
- when invoked as a program, validate `process.versions.node` immediately;
- write a concise actionable diagnostic to stderr on failure;
- exit non-zero on failure and zero on success;
- perform no installation, network access, runtime switching, filesystem mutation, or package loading.

The failure diagnostic must contain:

- `MASWE_UNSUPPORTED_NODE_VERSION`;
- actual Node version;
- supported range;
- canonical `.nvmrc` version;
- an actionable command such as `nvm install && nvm use`, while making clear that NVM is optional rather than a product dependency.

### 5.4 TypeScript runtime guard

`src/node-version.ts` will provide the same pure parsing/support contract and an assertion used by the packaged CLI.

`src/cli.ts` will call the assertion as the first action inside the testable CLI entry function, before:

- resolving or reading a target repository;
- writing starter configuration;
- constructing `FileRunStore`;
- loading current or persisted configuration;
- creating a runtime or orchestrator;
- touching `.maswe` state;
- creating worktrees or branches;
- invoking provider commands or target quality commands.

Static ESM module loading is not classified as a side effect for this acceptance criterion; repository, runtime, and durable-state actions are.

The `#!/usr/bin/env node` shebang remains intentional because installed CLI launch is supposed to select the user's active PATH runtime. The guard then determines whether that selected runtime is supported.

## 6. Package-script design

### 6.1 Metadata

- Add `.nvmrc` containing exactly `24.18.0` and one trailing newline.
- Add `.npmrc` containing `engine-strict=true`.
- Set `package.json#engines.node` to:

  ```text
  >=22.22.2 <23 || >=24.18.0 <25
  ```

- Update only the corresponding lockfile root engine metadata required by this change. Do not fold the pre-existing package-version discrepancy into this slice unless npm regeneration necessarily and transparently corrects it; if it changes, document it explicitly rather than hiding it.

### 6.2 Guarded entry points without recursive guard storms

Add one public guard script, for example:

```json
"verify:node": "node scripts/verify-node-version.mjs"
```

Use guarded public scripts and unguarded internal/raw scripts so `npm run check` validates once rather than recursively validating before each nested phase. Suggested structure:

```text
verify:node
_typecheck
_test
_build
typecheck = verify once + _typecheck
test      = verify once + _test
build     = verify once + _build
check     = verify once + _typecheck + _test + _build
pack:dry  = verify once + npm pack --dry-run
dev       = verify once + source CLI
start     = verify once + built CLI
```

Exact internal script names may differ, but the implementation must preserve these properties:

- every public repository-owned validation/execution entry fails early;
- `check` does not repeat the same guard unnecessarily;
- existing test flags and build behavior remain unchanged;
- CI can call the guard explicitly before substantive work;
- `preinstall` may invoke the dependency-free guard, while `.npmrc`/engines remain the normal pre-dependency rejection layer.

Do not rely solely on lifecycle-hook naming for a colon-containing script unless a regression test proves the exact npm behavior used.

## 7. Same-runtime child-process policy

Before editing, run a repository-wide audit equivalent to:

```bash
rg -n --hidden -g '!node_modules' -g '!.git' \
  '(spawn|spawnSync|execFile|execFileSync|spawnCaptured|spawnFileCaptured).*(["'"']node["'"']|/usr/bin/env node)|#!/usr/bin/env node|process\.execPath'
```

Classify every result as one of:

1. same-runtime Node child — must use `process.execPath`;
2. installed CLI shebang — keep `/usr/bin/env node`;
3. intentional PATH/shebang fixture — retain and document/test the intent;
4. user-configured external command — do not rewrite;
5. non-Node child — out of scope.

The baseline already uses `process.execPath` in the Node 22 child-output regressions. `test/node22-child-output.test.ts` will be extended with a hostile-PATH regression:

- create a fake executable named `node` earlier on PATH;
- launch the same-runtime child through the implementation-selected executable;
- prove the fake PATH binary is not executed;
- prove the child reports the same `process.execPath` as the parent.

If the fresh audit finds no incorrect literal same-runtime production callsite, do not manufacture a production-code change. Record the zero-change audit result in the builder report.

## 8. Test-driven implementation sequence

### Task 1 — Freeze the implementation baseline

**Files changed:** none.

1. Merge the approved docs-only PR through the separately authorized merge gate.
2. Fetch current `main` and record its exact SHA.
3. Create the fresh implementation branch from that SHA.
4. Confirm a clean checkout and no pre-existing `.nvmrc`/`.npmrc` or competing Node-policy work.
5. Re-run Node-reference and child-process audits.
6. Stop and amend the plan if the baseline materially changed.

### Task 2 — Add tests for the pure Node support contract

**Tests first:** `test/node-version-policy.test.ts`  
**Later implementation:** `scripts/verify-node-version.mjs`, `src/node-version.ts`, `.nvmrc`, `.npmrc`, `package.json`, `package-lock.json`

Write failing tests for:

- exact accepted and rejected boundary cases from design AC5–AC14;
- malformed version inputs;
- stable failure code and diagnostic fields;
- exact `.nvmrc` contents and trailing newline;
- exact package engine expression;
- exact lockfile root engine expression;
- exact equality between standalone guard constants and TypeScript guard constants;
- no third-party imports in the standalone guard;
- no automatic runtime switching or filesystem mutation.

Run the focused test and capture the expected RED failures before implementation.

Implement the smallest pure policy and metadata changes that make the tests pass.

### Task 3 — Add tests for script and install fail-fast wiring

**Tests first:** `test/node-version-scripts.test.ts`  
**Later implementation:** `package.json`, `.npmrc`, `scripts/verify-node-version.mjs`

Write failing tests that parse and exercise package metadata to prove:

- `.npmrc` enables `engine-strict`;
- every required public script reaches the guard before its substantive command;
- `check` uses one guard path and then raw phases without recursive guard repetition;
- public `typecheck`, `test`, `build`, `pack:dry`, `dev`, and `start` are guarded;
- normal current-runtime invocation of `verify:node` succeeds;
- the guard's program-mode error is non-zero and stable when its pure assertion seam is supplied an unsupported version;
- no public script invokes NVM or a host-specific NVM path.

For actual install-time evidence, add a short exact unsupported-runtime validation job or an equivalent isolated harness that runs under exact Node `25.9.0` and treats the expected `npm ci` engine rejection as success. The job must prove that dependency installation did not proceed and that the rejection identifies the supported engine range.

Do not make the unsupported-runtime job run the full suite.

### Task 4 — Add CLI zero-side-effect rejection tests

**Tests first:** `test/node-version-cli.test.ts`  
**Later implementation:** `src/node-version.ts`, `src/cli.ts`

Introduce only the minimal CLI test seam needed to call the entry function with an injected observed-version string while production defaults to `process.versions.node`.

Write RED tests for unsupported versions against representative commands:

- `init` — no `.maswe/config.json` created;
- `status` — no store directory created or read-dependent mutation;
- `start` — no run, branch, worktree, provider invocation, or target quality command;
- a persisted-run command — no run mutation or runtime construction.

Also prove:

- failure code and actionable diagnostic are present;
- supported version inputs preserve existing command behavior;
- the guard executes before `FileRunStore` construction and configuration loading;
- direct built CLI invocation retains the same failure semantics after compilation.

Implement the guard at the earliest entry boundary and keep all workflow/state semantics unchanged.

### Task 5 — Prove exact child-runtime inheritance

**Tests first and implementation if needed:** `test/node22-child-output.test.ts` plus only audit-confirmed callsites.

Add the hostile-PATH regression described in section 7. It must fail if a literal PATH-selected `node` is used and pass with `process.execPath`.

Replace only confirmed same-runtime literal Node launches. Preserve intentional shebang and user-configured-command behavior.

### Task 6 — Convert CI to exact version evidence

**File:** `.github/workflows/ci.yml`

Replace the floating primary Node 22 job with these blocking jobs:

1. `canonical-node-24-18-0`
   - checkout exact PR head;
   - verify expected versus actual SHA;
   - use `actions/setup-node` with `node-version-file: .nvmrc`;
   - print `command -v node`, `node --version`, `node -p 'process.execPath'`, and `npm --version`;
   - assert exact `v24.18.0`;
   - run `npm ci`;
   - run the Node guard explicitly;
   - run typecheck, focused regressions, both Issue #11 contention gates, full tests, build, and package dry-run.

2. `node-22-22-2-compat`
   - preserve exact `22.22.2` setup;
   - verify exact head SHA;
   - print binary and version evidence;
   - assert exact `v22.22.2`;
   - run `npm ci`, explicit Node guard, `npm run check`, package dry-run, and focused Node-policy/child-runtime tests.

3. `unsupported-node-25-negative`
   - exact Node `25.9.0`;
   - verify exact head SHA and binary evidence;
   - run only negative engine/guard checks;
   - succeed only when normal `npm ci` and the standalone guard reject the runtime before substantive validation;
   - do not install dependencies through `--force` and do not run project tests.

No blocking job may use floating `22`, `24`, `lts/*`, `node`, or another moving alias.

### Task 7 — Align documentation and release notes

**Files:** `README.md`, `docs/DEVELOPMENT.md`, `docs/OPERATIONS.md`, `docs/ARCHITECTURE.md`, `AGENTS.md`, `CHANGELOG.md`

Use the approved vocabulary consistently:

- canonical baseline;
- supported runtime range;
- compatibility floor;
- unsupported exploratory runtime.

Required documentation changes:

- show `.nvmrc`-based `nvm install`/`nvm use` as one contributor flow;
- state that NVM is optional and not a product dependency;
- document exact supported range and exact validation targets;
- remove stale Node `22.14.0` shell-default language;
- remove hard-coded `$HOME/.nvm/versions/node/...` guidance;
- explain fail-fast error and recovery;
- explain separate Node 24 canonical and Node 22 compatibility validation records;
- document that passing on an unsupported version is exploratory evidence, not support;
- add a changelog entry describing the support-contract change and early rejection behavior.

Do not rewrite historical design/plan evidence merely because it mentions the Node version used at that historical head.

### Task 8 — Full exact-head validation

Run separately under exact Node `24.18.0` and `22.22.2`.

For each runtime capture:

```bash
command -v node
node --version
node -p 'process.execPath'
npm --version
```

When NVM is used, also capture:

```bash
nvm current
nvm which current
```

Required validation:

- dependency installation;
- focused Node policy, script, CLI, and child-runtime suites;
- typecheck;
- complete test suite;
- build;
- package dry-run;
- actual package archive inspection when practical;
- both Issue #11 contention gates on canonical Node;
- existing ready-review regression gate;
- `git diff --check`;
- clean final checkout;
- package contents include all runtime files required by the built CLI and exclude test-only or host-specific artifacts.

Run the exact unsupported Node `25.9.0` negative validation separately and label it as unsupported-runtime rejection evidence, not product validation.

### Task 9 — Independent exact-head review

After implementation and deterministic validation:

1. Push the exact implementation head.
2. Open or update a draft implementation PR.
3. Run CodeRabbit, Copilot, and an independent verifier against the exact head.
4. Classify every finding and correct valid in-scope issues test-first.
5. Re-run exact Node 24 and Node 22 evidence after every head-changing correction.
6. Resolve only threads whose findings are actually corrected or technically rejected with evidence.
7. Require zero unresolved actionable threads and terminal successful exact-head CI.
8. Stop for a separate owner authorization before ready transition or merge.

## 9. Proposed commit sequence

Keep commits reviewable and do not squash away RED evidence before external review:

1. `test: define Node runtime policy boundaries`
2. `feat: add bounded Node runtime policy and metadata`
3. `test: expose script and install fail-fast gaps`
4. `feat: guard repository npm entry points`
5. `test: require CLI rejection before side effects`
6. `feat: enforce Node policy at CLI entry`
7. `test: prove same-runtime child Node selection`
8. `fix: use exact parent Node for same-runtime children` — only if the audit finds a real callsite
9. `ci: pin canonical and compatibility Node jobs`
10. `docs: document governed Node runtime support`
11. `chore: record exact-head validation evidence` — metadata/evidence only, no behavior change

If a task does not require a production correction, omit the corresponding implementation commit and record why.

## 10. Acceptance matrix mapping

| Design ACs | Plan task | Primary evidence |
|---|---|---|
| AC1–AC4 | Tasks 2 and 6 | `.nvmrc`, package/lock metadata, synchronization tests |
| AC5–AC14 | Task 2 | pure policy boundary table |
| AC15–AC17 | Task 3 | engine-strict, script-order tests, unsupported Node negative job |
| AC18–AC20 | Task 4 | zero-side-effect CLI tests and diagnostic assertions |
| AC21–AC23 | Task 5 | hostile-PATH child-runtime test and classified audit |
| AC24–AC29 | Tasks 6 and 8 | exact CI jobs and binary/version evidence |
| AC30–AC33 | Task 7 | synchronized user, developer, operator, architecture, and agent docs |

No acceptance criterion may be closed solely by prose when a deterministic test or exact command can prove it.

## 11. Explicit non-goals

This plan does not authorize:

- implementation before exact plan approval;
- implementation on the docs-only branch;
- Node 26 support;
- dropping Node 22 support;
- pinning one npm patch across both supported Node lines;
- making NVM mandatory;
- automatic Node installation or switching;
- changing TypeScript language level or replacing strip-types execution;
- changing target-repository quality commands;
- changing workflow states, approvals, model selection, read-only enforcement, retries, scope, or verification semantics;
- fixing unrelated package version metadata unless unavoidable and explicitly disclosed;
- broad child-process refactoring without an identified Node-selection defect;
- release publication, ready transition, auto-merge, or merge.

## 12. Plan approval gate

Owner disposition for this exact plan must be one of:

1. **Approve the plan and authorize implementation after the docs-only PR is merged and a fresh implementation branch is created from current main.**
2. Request plan corrections.
3. Withdraw or revise the approved design policy.

Until option 1 is explicit, implementation remains blocked.