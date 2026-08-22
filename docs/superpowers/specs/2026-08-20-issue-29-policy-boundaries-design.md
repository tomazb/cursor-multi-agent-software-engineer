# Issue #29 Non-bypassable Role Policy and Untrusted-Input Boundaries Design

## Status

- **Issue:** #29 — Enforce non-bypassable role policy and harden untrusted input boundaries
- **Parent:** #27
- **Status:** Baseline-reviewed and implementation-authorized by the owner for the current sequence
- **Date:** 2026-08-20
- **Exact baseline:** `main@a541936919f81f5412e75175053e100332b2a140`
- **Predecessor:** Issue #28 / PR #37, merged 2026-08-20
- **Remote-write boundary:** this design authorizes implementation work, not staging, commit, push, PR creation, or merge

## 1. Baseline review result

Issue #29 remains applicable to the post-Issue-#28 baseline. The merged Issue #28 work intentionally did not change the CLI/config policy boundary owned by Issue #29. Exact-main inspection confirms all seven defect families are still present:

1. `Orchestrator.executeAgent()` catches every thrown error and converts it into a retry/fallback attempt, including deterministic policy failures.
2. Default role permissions are correct, but project config and persisted-run migration can override them.
3. Prompt replacement is sequential and can reinterpret placeholder-looking text introduced by an earlier replacement.
4. CLI parsing is ad hoc and has ambiguous option/positional behavior.
5. `allowedPathGlobs` are translated as incomplete regexes: `?` is not implemented as a glob token and `**/` cannot match zero directories.
6. `quality.commands` accepts blank/whitespace-only entries.
7. Artifact references are joined directly to `cwd` and read with ordinary `readFile`, so a tampered run record can escape the artifact namespace or traverse a symlink.

The existing architecture already supplies most enforcement primitives: deterministic orchestration, runtime adapters, `gitWorkspaceFingerprint()`, SHA-bound evidence, exact run migration, bounded no-follow file reads, and fail-closed config validation. Issue #29 should compose those primitives rather than introduce another policy subsystem.

## 2. Security invariant

Untrusted requests, repository text, model output, runtime metadata, CLI input, and persisted run-record text must not be able to widen deterministic authority.

Concretely:

- a read-only role cannot become writable through config, migration, an execution override, or runtime behavior;
- a runtime policy violation cannot be retried under another model;
- model text cannot create a new prompt placeholder after insertion;
- CLI text cannot be silently reclassified as an option value or positional identifier;
- allowed-path checks use explicit portable glob semantics;
- a blank quality command is invalid trusted configuration rather than an executable no-op;
- an artifact reference can identify only the artifact file owned by the same run and cannot redirect reads through path syntax or filesystem links.

## 3. Scope

### Goals

- Stable, durable, operator-visible classification for deterministic execution-policy violations.
- Exact role/permission policy in TypeScript validation, persisted migration, and JSON Schema.
- Defense-in-depth read-only mutation detection at the orchestrator boundary, independent of runtime adapters.
- Single-pass prompt rendering against the original template.
- Strict CLI grammar based on Node's maintained `util.parseArgs` parser.
- Defined `allowedPathGlobs` semantics for `*`, `?`, `**`, `**/`, root/nested paths, dotfiles, Windows separators, and regex metacharacters.
- Reject whitespace-only quality commands while retaining `quality.commands: []` as an explicit skip.
- Constrain persisted and read-time artifact references to the same run's artifact namespace and use bounded ordinary-file reads.
- Update schemas, tests, and security/architecture documentation in the same change.

### Non-goals

- Preventive OS sandboxing, network sandboxing, or provider-side permission enforcement.
- New runtime kinds or multi-harness capability negotiation (owned by MH-00/#32).
- Changing model-selection defaults or enabling fallback by default.
- Changing workflow state transitions.
- Changing artifact format, signing artifacts, or adding database storage.
- Adding a third-party CLI or glob dependency when the Node standard library and a small explicit matcher are sufficient.
- Redesigning the Issue #28 recovery/revalidation protocol.

## 4. Decisions

### 4.1 Policy violations are first-class and non-retryable

Add a typed `PolicyViolationError` with a stable `RunFailureCode`. Use separate durable codes so existing `failure.code` and `FAIL.details.code` become sufficient operator-visible classification without adding a second persistence object:

```ts
export type PolicyViolationCode =
  | "policy-read-only-workspace-mutation"
  | "policy-runtime-identity-mismatch"
  | "policy-role-permission-mismatch"
  | "policy-read-only-head-moved";
```

`RunFailureCode` includes these values. `PolicyViolationError.code` is one of them.

`executeAgent()` rethrows a policy violation immediately. It must not:

- append a runtime attempt,
- include it in a runtime-exhaustion aggregate,
- try a fallback model.

`runFailureCode()` recursively discovers a `PolicyViolationError` through ordinary causes and `AggregateError`, the same way runtime-exhaustion errors are discovered today. Policy errors therefore persist their exact stable code and intentionally have no `failure.runtime` summary.

Runtime/transport failures remain retryable according to the existing fallback policy.

### 4.2 Role authority is an exact matrix

The authoritative role policy is:

| Role | Required permission |
|---|---|
| `brainstormer` | `read-only` |
| `designer` | `read-only` |
| `builder` | `workspace-write` |
| `verifier` | `read-only` |
| `prResolver` | `workspace-write` |

Export one `ROLE_PERMISSION_POLICY` value from the domain layer and one assertion helper. `assertConfig()` applies it to both project config and migrated persisted snapshots.

The PR-comment classifier remains intentionally read-only but does not mutate the persisted `prResolver` role. Narrow `executeAgent()`'s override surface from an arbitrary `RoleConfig` replacement to an explicit execution permission override. The only accepted override is:

```ts
role === "prResolver" && permissionOverride === "read-only"
```

Any other mismatch is `policy-role-permission-mismatch` and is non-retryable.

The configuration JSON Schema independently encodes the same `permissions.const` constraints, so generated/editor validation agrees with runtime validation.

### 4.3 Read-only execution gets an orchestrator fence

Runtime adapters retain their local mutation checks as defense in depth, but the orchestrator owns final policy classification.

For every effective read-only execution, `executeAgent()` captures before the runtime call:

- `gitWorkspaceFingerprint(workdir)`; and
- when `workdir` is a Git repository, exact `HEAD` via `gitRevParse(workdir, "HEAD")`.

After the runtime returns **or throws**, the orchestrator captures the same values before deciding whether the runtime result/error is retryable.

Classification order:

1. If Git `HEAD` changed, throw `policy-read-only-head-moved`.
2. Else if the workspace fingerprint changed, throw `policy-read-only-workspace-mutation`.
3. Else continue with the runtime result or original runtime error.

This ordering gives HEAD movement a stable, specific code rather than collapsing it into a generic mutation. Non-Git workspaces skip the HEAD check but retain the authoritative fingerprint check.

Cursor CLI and SDK adapter mutation detections also throw the same typed policy error. This closes a race where the adapter observes a change but the workspace is modified again before the orchestrator's second snapshot.

### 4.4 Runtime identity mismatch is policy, not transport

`assertRuntimeIdentity()` throws `policy-runtime-identity-mismatch`. `executeAgent()` applies identity validation whenever an `actualModel` is reported and differs from `requestedModel`; it is not conditional on whether fallback selection was enabled.

Before each existing-run attempt, the orchestrator resolves the persisted selector against the
runtime's trusted catalogue. Case-insensitive exact-ID acceptance returns the catalogue entry's
canonical spelling; it does not lowercase arbitrary runtime metadata or permit family, provider,
or effort substitution. That canonical value drives the runtime request, the orchestrator's
trusted requested identity, attempt diagnostics, and any reported-identity comparison. Runtime
`requestedModel` and `actualModel` fields remain untrusted evidence and cannot replace it.

Fallback chooses the requested model for a new attempt. It does not authorize a runtime/provider to return a different model from the model requested for that attempt.

### 4.5 Prompt replacement is single-pass

Replace sequential `String.replaceAll()` calls with one regex scan of the original trusted template:

```ts
/\{\{([A-Z][A-Z0-9_]*)\}\}/g
```

The callback substitutes an own-property value. Callback output is never rescanned by JavaScript replacement semantics, so inserted `{{TOKEN}}` text remains literal.

Unknown placeholders fail closed with a deterministic error naming only the placeholder token. Templates are trusted repository assets, so an unknown placeholder is a template defect, not model content to preserve silently.

### 4.6 CLI grammar uses `node:util.parseArgs`

Add a focused `cli-args` module using `parseArgs({ strict: true, allowPositionals: true, tokens: true })`.

All currently supported long options are declared with explicit boolean/string types:

- string: `config`, `cwd`, `title`, `request`, `request-file`, `text`, `file`
- boolean: `json`, `force`

Rules:

- `--name=value` and `--name value` are equivalent for string options;
- options may appear before or after the command;
- unknown options fail;
- every option may appear at most once, including mixed `--x a --x=b` forms;
- missing string values fail;
- booleans do not consume a following positional;
- the first positional is the command, remaining positionals are command operands;
- each command has an allowlist of valid options and an exact/min-max positional contract;
- `start` requires exactly one of `--request` or `--request-file` plus `--title`;
- `review-comment` requires exactly one of `--text` or `--file` plus one run ID;
- `--config` and `--cwd` remain global and are valid in any documented position;
- `--json` is accepted only by commands that currently render JSON (`doctor`, `start`, `status`, `github-publish-checks`);
- `--force` is accepted only by `init`, `unlock`, and `unlock-admin`.

No abbreviated option names, implicit values, or combined short flags are introduced.

### 4.7 Portable path-glob semantics are explicit

Configured glob separators are normalized to `/` for portable policy matching. Git-reported
candidate paths are not rewritten: they are the authoritative scope subjects. In particular, a
literal `\` in a POSIX Git filename remains part of that root filename and is never reclassified
as a directory separator. This corrects the original Issue #29 design wording, which normalized
both sides and could widen `src/**` to a root file such as `src\unapproved.ts`.

Token semantics:

- `*` — zero or more characters except `/`;
- `?` — exactly one character except `/`;
- `**` — zero or more characters including `/`;
- `**/` — zero or more complete path segments, including zero segments;
- all other characters are literals and regex metacharacters are escaped.

Patterns are anchored to the complete candidate path. Dotfiles are not special: `*` and `?` may match `.`. Consequently `**/*.ts` matches both `root.ts` and `src/root.ts`.

Keep the existing special meaning of `**` / `**/*` as all paths, although the compiler also yields equivalent behavior for non-empty candidate file paths.

### 4.8 Quality command validation rejects blank entries

`quality.commands` stays an array of trusted shell-command strings. Validation requires every entry to satisfy:

```ts
typeof command === "string" && command.trim().length > 0
```

The command text is not normalized before execution; only validity is checked. The empty array remains valid and means deterministic quality commands are explicitly skipped.

The JSON Schema adds a non-whitespace constraint for each item.

### 4.9 Artifact references are a portable, run-scoped namespace

Persist new artifact paths canonically with `/` separators:

```text
.maswe/runs/<run-id>/artifacts/<physical-file-name>
```

The current writer creates only direct artifact files, so migration accepts only a direct child of that exact prefix. This is backward-compatible with records created by MASWE because the artifact file-name sanitizer does not generate path separators. Historical Windows separators are accepted only by first normalizing `\` to `/` for validation.

Generated physical names preserve the existing lowercase portable form. Every non-lowercase,
reserved, or escape-prefix-shaped generated leaf is encoded into a dedicated hexadecimal escape
namespace. Escaping inputs that already resemble that namespace makes the transformation
injective, including on case-insensitive filesystems. Before publication, the store also rejects a
physical path already owned by another logical artifact and refuses to replace an unexpected
existing target. Historical schema-version-1 physical names remain valid references.

Reject during run-record migration:

- POSIX absolute paths;
- Windows drive-absolute, drive-relative, UNC, or root-relative paths;
- `.` / `..` segments;
- empty segments or duplicate separators;
- a run ID different from the enclosing run;
- anything outside the exact `artifacts/` prefix;
- nested descendants below the physical artifact file.

At read time, validate the reference again, derive the absolute path from the store's known artifact directory plus the validated physical filename (never from `cwd + persisted path`), require the artifact directory to be ordinary, and call `readBoundedOrdinaryFile()` so the final file is regular, no-follow, identity-stable, and at most the existing authoritative-file bound. Recompute SHA-256 afterward as today.

Validation at both migration and read time protects in-memory/tampered records that did not come through the normal loader.

## 5. Interfaces and file impact

### New focused modules

- `src/policy.ts`
  - `ROLE_PERMISSION_POLICY`
  - `PolicyViolationError`
  - `assertConfiguredRolePermission(role, permission)`
  - `resolveExecutionPermission(role, configuredPermission, override?)`
  - `isPolicyViolationError(error)` / recursive finder as needed
- `src/cli-args.ts`
  - strict parsing and command-specific validation
  - returns `{ command, options, positionals }`
- `src/artifact-path.ts`
  - portable lexical validation and canonical persisted path construction

Keeping these helpers out of `orchestrator.ts`, `cli-runner.ts`, and `store.ts` makes the security contracts directly unit-testable and limits coupling.

### Modified runtime and persistence modules

- `src/domain.ts` — add policy failure codes.
- `src/config.ts` — enforce role matrix and nonblank quality commands.
- `src/orchestrator.ts` — narrow execution override, add read-only fence, short-circuit policy errors.
- `src/failure-diagnostics.ts` — identity mismatch policy error and durable classification discovery.
- `src/runtimes/cursor-cli.ts` / `src/runtimes/cursor-sdk.ts` — typed mutation errors.
- `src/prompt-builder.ts` — single-pass replacement.
- `src/cli-runner.ts` — consume parsed grammar rather than scanning raw argv.
- `src/git-workspace.ts` — explicit glob compiler.
- `src/store.ts` — migration/read artifact confinement and canonical artifact path write.
- `src/run-record-validation.ts` — accept new failure codes.
- `schemas/config.schema.json`, `schemas/run-record.schema.json` — mirror stable constraints.

## 6. Acceptance criteria

- **AC-29.1:** A read-only role mutation is reported as `policy-read-only-workspace-mutation` and no fallback model is invoked.
- **AC-29.2:** Read-only HEAD movement is reported as `policy-read-only-head-moved` and no fallback model is invoked.
- **AC-29.3:** Runtime `actualModel !== requestedModel` is reported as `policy-runtime-identity-mismatch` and no fallback model is invoked.
- **AC-29.4:** Project config and persisted run migration reject every role-permission value outside the exact matrix; classifier execution remains an explicit read-only narrowing of `prResolver`.
- **AC-29.5:** Config and run-record schemas encode the same role/failure policy.
- **AC-29.6:** A replacement value containing a valid-looking placeholder is inserted literally and is not re-expanded; an unknown template placeholder fails deterministically.
- **AC-29.7:** CLI tests cover split/equal string options, global options before/after command, unknown options, duplicates, missing values, boolean/positional separation, wrong command options, exact positionals, and the two mutual-exclusion pairs.
- **AC-29.8:** Glob tests cover `*`, `?`, `**`, `**/`, `**/*.ts` at root/nested depth, `**/*`, dotfiles, Windows separators, and literal regex metacharacters.
- **AC-29.9:** `quality.commands: []` remains valid; `""`, whitespace-only strings, and non-strings fail both runtime validation and schema validation.
- **AC-29.10:** Artifact migration/read rejects traversal, absolute/platform-rooted paths, wrong-run prefixes, normalization escapes, nested unexpected paths, artifact-directory/final-file symlinks, non-files, oversized files, and digest mismatch.
- **AC-29.11:** Existing valid artifact reads and runtime transport/model fallback failures preserve current behavior.
- **AC-29.12:** Documentation describes policy non-fallback semantics and the artifact namespace boundary.
- **AC-29.13:** Exact-head verification passes `npm run check`, `npm run pack:dry`, and `git diff --check` under Node `24.18.0` and compatibility Node `22.22.2`.

## 7. Reliability and compatibility

- Keep run schema version `1`; new `failure.code` enum values are additive and existing records with omitted codes remain valid.
- Invalid persisted permissions or artifact paths fail closed during migration rather than being silently corrected.
- No process environment override is applied to persisted run snapshots.
- Existing runtime fallback semantics remain unchanged for genuine runtime/transport errors.
- Existing read-only adapter checks remain, but the orchestrator becomes the independent enforcement/classification boundary.
- No new npm dependency is required.

## 8. Review findings incorporated before implementation

The design review made four corrections to a naïve implementation:

1. **Do not classify policy violations as another runtime failure code.** That would still let the existing retry loop consume them. They require a distinct thrown type plus immediate rethrow.
2. **Check read-only state after both success and failure.** Checking only successful runtime results allows a mutating runtime to throw and be retried.
3. **Do not accept arbitrary `RoleConfig` execution overrides.** The classifier needs a single read-only narrowing, not a generic authority-replacement hook.
4. **Do not merely normalize an artifact path then join it to `cwd`.** Validate the persisted namespace and reconstruct the absolute file from trusted store roots, then use the existing no-follow bounded reader.

With these corrections, the design is internally consistent with the existing PRD, architecture, security model, ADR-0003, and ADR-0004 and does not require a new ADR because it strengthens existing accepted decisions rather than reversing one.
