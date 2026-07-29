# Node.js Runtime Baseline Drift Review and Design

Date: 2026-07-29  
Status: **PROPOSED — DESIGN ONLY; IMPLEMENTATION REQUIRES EXPLICIT APPROVAL**  
Repository: `tomazb/cursor-multi-agent-software-engineer`  
Fresh base: `main@59378e60d045d4d78920970d0993fbbedc55e7b9`  
Design branch: `docs/node-runtime-baseline-drift-design`  
Predecessor content recovered from: `5590eef2c00279b1c7f2e329f5e11f338896afd4:docs/plans/2026-07-28-node-version-guidance-design.md`

## 1. Purpose

This design replaces the stale, documentation-only Node version guidance with one explicit runtime and validation contract.

It preserves the predecessor design's useful distinction between:

- versions the project supports, and
- exact versions used as validation targets,

but it does not preserve the predecessor's assumption that documentation alone is sufficient.

The design explicitly reconciles:

- the current operator shell default, Node `v24.18.0`;
- the pinned compatibility validation target, Node `v22.22.2`;
- the current floating CI major `22` job;
- plain `node`/`npm` invocation versus NVM-selected execution;
- the absence of `.nvmrc` on current `main`;
- `package.json` engine bounds;
- local, CI, package-install, and CLI fail-fast behavior.

No implementation change is authorized by this document.

## 2. Baseline-drift review

### 2.1 Current repository state at the fresh base

| Surface | Current state | Drift or ambiguity |
|---|---|---|
| `package.json` | `engines.node` is `>=22.15` | This includes every later major, including unvalidated odd/EOL releases and Node 26 Current. It does not express the actual two-line validation policy. |
| `package.json` scripts | `test`, `dev`, and `start` invoke plain `node` | The binary is whichever `node` is first on `PATH`; the scripts do not prove whether it came from the shell default, NVM, CI setup, or another toolchain manager. |
| `.nvmrc` | absent | `nvm use`, `nvm exec`, and `nvm install` have no repository-owned version source. |
| CI primary job | floating `node-version: [22]` | The resolved patch can drift without a repository diff. It currently validates the latest available Node 22 patch, not a reproducible exact baseline. |
| CI compatibility job | exact `22.22.2` | This is reproducible and already protects a known version-sensitive test transport path. |
| local exact-head evidence for PR #21 | shell-default Node `v24.18.0` plus separately selected Node `v22.22.2` | Both versions passed, but the repository does not define which is canonical, which is compatibility-only, or whether both are supported. |
| `README.md` and `docs/DEVELOPMENT.md` | Node `22.15+` | This wording implies unbounded future-major support and does not distinguish canonical development from minimum compatibility. |
| `AGENTS.md` | describes a former shell default `v22.14.0`, calls the engine mismatch advisory, and gives a hard-coded NVM path for `v22.22.2` | The shell-default fact is stale; hard-coded NVM installation paths are host-specific; "advisory only" conflicts with fail-fast governance. |
| predecessor design | documentation-only; minimum `>=22.15`; tested `22.22` and `22.23` | It predates the Node 24 shell evidence and does not govern `.nvmrc`, CI source-of-truth, process selection, engine enforcement, or runtime rejection. |

### 2.2 External lifecycle facts

As of this design date:

- Node 22 and Node 24 are LTS release lines.
- Node 23 and Node 25 are EOL.
- Node 26 is Current and has not been qualified by this repository.
- Node `v24.18.0` is an official LTS release dated 2026-06-23.

References:

- https://nodejs.org/en/about/previous-releases
- https://nodejs.org/en/blog/release/v24.18.0

These facts support an explicit bounded-LTS policy rather than the unbounded `>=22.15` range.

### 2.3 Enforcement facts

- npm documents `package.json#engines` as advisory unless `engine-strict` is enabled.
- npm documents `engine-strict=true` as refusing incompatible installs, but `--force` can override it.
- NVM documents `.nvmrc` as the default version source for `nvm use`, `nvm install`, `nvm exec`, `nvm run`, and `nvm which` when no version is supplied.

References:

- https://docs.npmjs.com/cli/configuring-npm/package-json/#engines
- https://docs.npmjs.com/cli/using-npm/config/#engine-strict
- https://github.com/nvm-sh/nvm#nvmrc

Therefore, neither `engines` nor `.nvmrc` alone is sufficient to provide the required fail-fast behavior.

## 3. Decision summary

### D1 — Node 24.18.0 is the canonical development and primary CI baseline

The repository-owned canonical version will be exactly:

```text
24.18.0
```

This exact version will be stored in `.nvmrc` and consumed by the primary CI job.

Rationale:

- It matches the current shell-default exact-head validation evidence.
- It is the current LTS line rather than an odd-numbered Current/EOL line.
- It removes ambiguity between the environment contributors actually encounter and the repository's primary development baseline.
- An exact pin makes local and primary-CI reproduction reviewable.

The shell default remains environmental evidence, not authority. `.nvmrc` becomes the repository authority.

### D2 — Node 22.22.2 remains a supported compatibility floor, not the sole strict major

Node 22 is **not** the only supported major.

Node `v22.22.2` remains:

- the minimum supported Node 22 patch;
- a separately pinned compatibility target;
- a required blocking CI job while Node 22 remains in the supported set.

It is not the canonical contributor baseline after this design is implemented.

This preserves the proven version-sensitive compatibility coverage without forcing every local command to run on Node 22 when the repository's current LTS baseline is Node 24.

### D3 — Supported Node runtime contract is a bounded union of two LTS lines

The intended `package.json` contract is:

```json
{
  "engines": {
    "node": ">=22.22.2 <23 || >=24.18.0 <25"
  }
}
```

Interpretation:

- supported: Node `22.22.2` through the end of the Node 22 major;
- unsupported: Node `23.x`;
- supported: Node `24.18.0` through the end of the Node 24 major;
- unsupported: Node `25.x`;
- unsupported pending qualification: Node `26.x` and later;
- unsupported: Node versions below `22.22.2`.

This range is both broader and stricter than "Node 22 only": it supports two explicit LTS lines while rejecting majors that have not been qualified.

Adding Node 26 later requires a deliberate baseline-review change, CI evidence, and an updated bounded range. It must not become supported merely because an operator's shell or CI image changes.

### D4 — `.nvmrc` selects the canonical version; package scripts do not invoke NVM

The repository will add:

```text
24.18.0
```

to `.nvmrc`, with the required trailing newline.

Contributor guidance will use one of these explicit flows:

```bash
nvm install
nvm use
npm ci
npm run check
```

or, for a one-command selected execution:

```bash
nvm exec -- npm run check
```

Package scripts and production code will not invoke `nvm` directly because:

- NVM is a per-shell function, not a portable executable contract;
- CI uses `actions/setup-node`, not NVM;
- Windows-native environments and alternative version managers must remain possible;
- repository behavior must depend on the active Node binary, not on one toolchain manager.

Plain `node` and `npm` commands are acceptable only after the environment has selected a supported runtime and the fail-fast guard has verified it.

### D5 — internal Node child processes inherit the exact current runtime

When JavaScript or TypeScript code launches another Node process that is required to run under the same runtime as its parent, it will use:

```ts
process.execPath
```

rather than a literal `node` command.

This prevents an NVM-selected parent from accidentally spawning a different system-default Node due to a modified child `PATH`.

Exceptions must be explicit and tested:

- installed CLI shebangs may use `#!/usr/bin/env node` because end-user PATH resolution is the intended launch contract;
- fixtures that intentionally test PATH/shebang behavior may use `/usr/bin/env node`;
- quality commands for a target repository remain target-owned shell commands and are not rewritten by MASWE.

Every exception must state why PATH-based selection is part of the behavior being tested.

### D6 — fail-fast enforcement is layered and deterministic

The implementation plan derived from this design must introduce all of the following layers.

#### D6.1 Package metadata

- Set `engines.node` to the bounded union in D3.
- Keep the lockfile root package metadata synchronized with `package.json`.
- Do not claim that `engines` alone enforces the contract.

#### D6.2 Install-time npm policy

Add a project `.npmrc` with:

```ini
engine-strict=true
```

This rejects normal `npm install`/`npm ci` execution on unsupported Node versions.

Because npm allows `--force` to bypass `engine-strict`, this is a convenience and early guard, not the only authority.

#### D6.3 Dependency-free Node version guard

Add a small dependency-free ESM guard, for example:

```text
scripts/verify-node-version.mjs
```

The guard must:

- inspect `process.versions.node`;
- implement the same bounded union as `package.json` without loading project dependencies;
- exit zero for supported versions;
- exit non-zero for unsupported versions;
- emit a stable machine-readable code, `MASWE_UNSUPPORTED_NODE_VERSION`;
- print the actual version, supported expression, canonical `.nvmrc` version, and recovery command;
- perform no network access, installation, automatic version switch, or project mutation.

The package metadata and guard must share one test-enforced policy source or a deterministic synchronization test. Two manually duplicated ranges without a drift test are not acceptable.

#### D6.4 npm script entry guards

All repository-owned validation and execution entry points must fail before typechecking, tests, build work, package creation, or runtime state mutation.

At minimum, guard:

- install/CI entry;
- `npm run check`;
- `npm test`;
- `npm run typecheck`;
- `npm run build`;
- `npm run pack:dry`;
- `npm run dev`;
- `npm start`.

The implementation plan must avoid recursive or unnecessarily repeated guard execution. A single composable script/wrapper design is preferred over a fragile collection of unrelated shell fragments.

#### D6.5 packaged CLI entry guard

The built `maswe` entry point must validate the Node contract before it:

- reads or writes `.maswe` state;
- creates a run;
- creates a worktree or branch;
- invokes Cursor or another provider;
- executes target quality commands.

On failure it must exit non-zero with `MASWE_UNSUPPORTED_NODE_VERSION` and leave the target repository and MASWE state unchanged.

This protects users who launch `maswe` directly rather than through npm scripts.

### D7 — CI becomes exact and version-source driven

The current floating `node-version: [22]` primary job will be replaced by an exact canonical-baseline job that reads `.nvmrc` through `actions/setup-node`'s version-file support.

Required blocking jobs:

1. **Canonical Node baseline**
   - exact version from `.nvmrc` (`24.18.0` initially);
   - exact-head checkout verification;
   - install;
   - typecheck;
   - focused regressions and contention gates;
   - full test suite;
   - build;
   - package-content verification.

2. **Node 22 compatibility floor**
   - exact `22.22.2`;
   - exact-head checkout verification;
   - install;
   - `npm run check`;
   - package-content verification;
   - focused Node-version guard and child-runtime inheritance tests.

The CI configuration must not rely on `node-version: 22`, `lts/*`, or another floating alias for blocking evidence.

A later optional floating canary may detect upcoming patch drift, but it must be clearly named as a canary and cannot replace either exact blocking job.

### D8 — validation evidence must identify the binary, not only the semantic version

Every manual or automated exact-head validation record must capture:

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

A validation report must classify evidence as one of:

- canonical `.nvmrc` baseline;
- Node 22 compatibility floor;
- other supported runtime;
- unsupported exploratory runtime.

A report must not combine commands from Node 24 and Node 22 into one unlabeled "local validation" result.

### D9 — documentation uses one vocabulary

The implementation must update all Node guidance to use these exact concepts:

- **canonical baseline:** `.nvmrc` exact version, initially `24.18.0`;
- **supported runtime range:** `>=22.22.2 <23 || >=24.18.0 <25`;
- **compatibility floor:** exact Node `22.22.2`;
- **unsupported exploratory runtime:** any version outside the supported range, even when some commands happen to pass.

At minimum, review and align:

- `README.md`;
- `docs/DEVELOPMENT.md`;
- `docs/OPERATIONS.md`;
- `AGENTS.md`;
- `.github/workflows/ci.yml`;
- `package.json` and lockfile root metadata.

Delete stale host-specific guidance such as a hard-coded path under `$HOME/.nvm/versions/node/...`.

Passing on an unsupported runtime must not be described as support.

## 4. Why this design was selected

### 4.1 It preserves useful predecessor intent

The predecessor correctly separated support from test evidence. This design retains that separation and makes it operational:

- the supported range is explicit and bounded;
- exact validation targets are reproducible;
- the canonical contributor baseline is repository-owned;
- runtime selection and runtime enforcement are distinct concerns.

### 4.2 It does not confuse "newer" with "supported"

An unbounded lower-bound expression such as `>=22.15` silently includes Node 23, 25, 26, and every future major. Newer majors can change flags, loaders, test-runner behavior, stream timing, or package-manager behavior.

Support therefore requires explicit qualification, not merely a successful ad hoc run.

### 4.3 It avoids making NVM a product dependency

`.nvmrc` is useful contributor metadata, but the product must remain runnable under any environment manager that supplies a supported Node binary.

The fail-fast guard checks the runtime itself. It does not care whether that binary came from NVM, `actions/setup-node`, Volta, asdf, a container image, or a system package.

### 4.4 It keeps Node 22 compatibility real

The exact `22.22.2` job remains blocking because recent repository history demonstrated version-sensitive child-process output behavior on that runtime.

Calling Node 22 "compatibility-only" does not mean best-effort or non-blocking. It means Node 22 is a secondary supported line rather than the canonical development baseline.

## 5. Alternatives considered

### A — Strict Node 22-only support

Example:

```text
>=22.22.2 <23
```

Rejected for this design because:

- the current exact-head local validation already uses Node `24.18.0` successfully;
- Node 24 is LTS;
- forcing the repository back to Node 22 would make the canonical baseline older than the current environment without an identified product incompatibility on Node 24;
- it would convert the shell default into a mandatory pre-command version switch while discarding useful current-LTS coverage.

This alternative remains valid only if implementation testing finds a concrete Node 24 incompatibility.

### B — Keep `>=22.15` and document tested versions

Rejected because:

- it claims support for unqualified majors;
- npm's engine warning remains advisory by default;
- there is no `.nvmrc` source of truth;
- it does not resolve child-process binary selection;
- it does not fail before state mutation.

This is the predecessor design and is insufficient for the observed drift.

### C — Pin every environment to exactly Node 24.18.0

Example:

```text
=24.18.0
```

Rejected because:

- it would unnecessarily drop the proven Node `22.22.2` compatibility contract;
- exact-only production support would require a policy update for every security patch;
- the project can use exact validation targets while supporting bounded patch ranges.

### D — Automatically run `nvm use` inside npm scripts

Rejected because NVM is not a portable executable and may not exist in CI, Windows-native shells, containers, or installations managed by another tool.

### E — Rely only on `engine-strict=true`

Rejected because npm documents that `--force` can override it, and direct CLI execution does not necessarily pass through a package installation step.

## 6. Implementation surface for a later approved plan

The implementation plan should expect changes in these areas, subject to exact repository inspection at plan time:

- new `.nvmrc`;
- new or updated `.npmrc`;
- `package.json` engine range and scripts;
- `package-lock.json` root metadata;
- dependency-free version-policy/guard module;
- earliest CLI entry guard;
- Node child-process call sites that use literal `node` where same-runtime inheritance is required;
- Node-version policy tests and subprocess integration tests;
- exact-version CI jobs;
- README, development, operations, architecture or agent guidance where relevant;
- changelog entry if the support contract changes in a release-visible way.

The implementation plan must enumerate exact files and tests after a fresh main recheck. This design does not authorize those edits.

## 7. Required acceptance criteria for implementation

### Contract and synchronization

1. `.nvmrc` contains exactly `24.18.0` plus a trailing newline.
2. `package.json#engines.node` is exactly `>=22.22.2 <23 || >=24.18.0 <25` unless a newly proven blocker causes the design to be explicitly revised before implementation.
3. Package metadata, runtime guard, documentation, and tests cannot silently drift to different ranges.
4. The lockfile root package metadata matches `package.json`.

### Allowed-version cases

5. The guard accepts `22.22.2`.
6. The guard accepts a later Node 22 patch such as `22.23.1`.
7. The guard accepts `24.18.0`.
8. The guard accepts a later Node 24 patch below `25.0.0`.

### Rejected-version cases

9. The guard rejects `22.22.1` and earlier.
10. The guard rejects every Node 23 version.
11. The guard rejects Node `24.17.x` and earlier Node 24 patches.
12. The guard rejects every Node 25 version.
13. The guard rejects Node 26 until a later explicit qualification change.
14. Malformed or unavailable version input fails closed in unit-test seams.

### Fail-fast behavior

15. Unsupported `npm ci` fails before dependency installation under normal npm invocation.
16. Unsupported `npm run check` fails before typecheck or tests.
17. Unsupported `npm run build` and package verification fail before output creation.
18. Unsupported direct `maswe` execution fails before MASWE state, worktree, branch, provider, or target-quality side effects.
19. The failure includes `MASWE_UNSUPPORTED_NODE_VERSION`, actual version, supported range, canonical version, and an actionable selection command.
20. The guard never installs or switches Node automatically.

### Binary selection

21. Same-runtime child Node execution uses `process.execPath`.
22. Tests prove that a parent started from an NVM-selected or otherwise non-default binary does not spawn a different `node` from a hostile or reordered `PATH`.
23. Intentional `/usr/bin/env node` fixtures or entrypoints are explicitly classified and tested.

### CI and evidence

24. The primary blocking job consumes `.nvmrc` and reports exact `v24.18.0`.
25. The compatibility blocking job reports exact `v22.22.2`.
26. Both jobs verify the exact checked-out head SHA.
27. Both jobs execute the Node guard before substantive validation.
28. No blocking job uses a floating major or LTS alias.
29. Exact-head validation records identify `command -v node`, `process.execPath`, Node version, and npm version.

### Documentation

30. README, development, operations, and agent guidance use the D9 vocabulary consistently.
31. Stale `v22.14.0` shell-default and host-specific NVM path guidance is removed.
32. Documentation does not call unsupported-version success a supported configuration.
33. Documentation explains that `.nvmrc` selects the canonical contributor version but does not make NVM a product dependency.

## 8. Migration and rollout

This is a developer/runtime support-contract change, not a persisted-run schema change.

Expected rollout sequence after explicit plan approval:

1. Add the version policy, `.nvmrc`, metadata, and guard tests.
2. Add install/script/CLI fail-fast wiring.
3. Replace same-runtime literal `node` child invocations with `process.execPath` where required.
4. Change CI to exact canonical and compatibility jobs.
5. Update documentation and changelog.
6. Validate the exact implementation head separately on Node `24.18.0` and Node `22.22.2`.
7. Run independent verification before any ready-for-review or merge transition.

Existing source checkouts using Node 22 below `22.22.2`, Node 23, Node 24 below `24.18.0`, Node 25, or Node 26 will begin failing early. That is intentional and must be called out in release notes.

No persisted MASWE run migration is required solely because of this policy. A run created under an unsupported Node version must not be allowed to resume until launched with a supported runtime.

## 9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Engine range and guard drift apart | One policy source or a deterministic synchronization test. |
| `.nvmrc` is mistaken for universal runtime enforcement | Document it as contributor selection metadata; retain install, script, and CLI guards. |
| `engine-strict` is bypassed with `--force` | CLI and script guards remain authoritative. |
| Node 22 compatibility silently degrades after canonical CI moves to Node 24 | Keep exact `22.22.2` blocking CI. |
| Later Node 24 patches introduce regressions | Exact canonical CI remains reproducible; upgrades require explicit `.nvmrc` changes and review. |
| Node 26 becomes LTS but remains rejected | Treat support expansion as deliberate governed work with CI qualification. |
| PATH selects a different Node for child tests | Use `process.execPath` for same-runtime children and test hostile PATH ordering. |
| Repeated guards slow commands or create recursive npm hooks | Design one composable guard path and test script lifecycle ordering. |
| Unsupported runtime rejection happens after side effects | Put CLI guard before configuration/state/worktree/provider initialization and test zero side effects. |

## 10. Non-goals

This design does not authorize or require:

- implementation on this design branch;
- Node 26 support;
- dropping Node 22 support;
- pinning one npm patch version across Node 22 and Node 24;
- making NVM mandatory for users or CI;
- automatic Node installation or switching;
- changing target-repository quality commands;
- changing MASWE workflow state, approval, model, read-only, scope, or verification policy;
- redesigning TypeScript or `--experimental-strip-types` usage beyond compatibility tests required by this Node policy;
- publishing a new release.

## 11. Approval gate

This branch is complete when the design is reviewed and the owner explicitly chooses one of:

- approve the selected two-LTS-line policy and authorize a separate implementation plan;
- request design corrections;
- replace the selected policy with strict Node 22-only support, with reasons and revised acceptance criteria.

Until that decision, no `.nvmrc`, engine, CI, runtime guard, package script, child-process, or documentation implementation change is authorized.
