# Issue #11 Ownership-Safe Lock Recovery Implementation Plan

> **For the implementation agent:** Execute this plan in order with the Superpowers
> test-driven-development, systematic-debugging, verification-before-completion,
> requesting-code-review, and finishing-a-development-branch workflows. Do not merge.

**Issue:** #11 — Harden forced lock recovery and ownership-safe release

**Approved design:** `882fc1c63041e946babe3b744285fa6b5b917816`

**Implementation base:** `dab10487baf7f05867b54895ec5db109ad3a3e65`

**Implementation status:** `BLOCKED_DESIGN_DEFECT`

**Goal:** Replace pathname-wide regular-file lock cleanup with version-2 lock directories whose
exclusive `mkdir` namespace claim, UUID token publication, final namespace-identity validation,
exact-token unlink, and empty-only `rmdir` prevent an old owner from deleting a replacement and
serialize forced administrative recovery.

**Scope:** Local coherent-filesystem locking only. Issues #12, #13, #3, and #5, distributed
stores, age-based reclamation, automatic merging, and unrelated refactoring remain excluded.

**Architecture:** Add a focused lock-protocol module used by `FileRunStore`. It owns
classification, format-2 record validation, acquisition, exact-token release, semantic errors,
and singleton recovery. `FileRunStore` retains orchestration of data/admin/recovery locks and all
existing optimistic-version and atomic-write behavior. Tests drive real child processes through
explicit IPC barriers; injected filesystem behavior is limited to platform-semantic branches.

**Toolchain:** TypeScript ESM, Node.js 22.22.2 built-in test runner, Node `fs/promises`, no new
dependencies.

## Blocking design contradiction discovered during implementation review

Implementation stopped after exact-head review identified that the approved portable Node
protocol cannot prove the mandatory acquisition identity invariant.

The approved sequence is:

1. `mkdir(lockPath)` succeeds;
2. capture the stable identity of the directory created by this actor;
3. create/publish the record;
4. require final identity equality before ownership.

Node's supported filesystem API does not return an identity-bearing directory handle from
`mkdir`. The implementation must perform a separate `lstat(lockPath)` pathname lookup. A forced
actor can execute `rmdir(lockPath)`, and a replacement actor can execute `mkdir(lockPath)`, after
the first actor's `mkdir` returns but before its first `lstat`. That `lstat` then captures the
replacement directory identity as though it were the original claim. Internal temp creation and
final validation can all remain self-consistent against that replacement, allowing the first
actor to return ownership without proving that the canonical directory is the object it created.

This contradicts both binding requirements:

- “the canonical directory identity is still the identity originally claimed”; and
- a claimant whose empty directory was removed “must detect that the canonical path no longer
  represents its claimed directory” and “must not publish into a replacement directory.”

Opening the directory after `mkdir` has the same pathname race. Portable Node also exposes no
handle-relative `openat`/`mkdirat` child-creation API, no `mkdir` that returns the created object,
and no portable native compare-and-publish primitive. A native/platform helper or a changed
ownership invariant/protocol would require repository-owner design revision. Ordinary rename,
recursive cleanup, age reclaim, and approximate identity checks remain prohibited.

The current deterministic claimant-replacement test pauses only after the first `lstat` has
captured identity, so it proves the later interference case but cannot prove the gap between
successful `mkdir` and initial identity capture.

No workaround is approved. Do not push the implementation commits or open a pull request until
the repository owner revises and reapproves the design.

## Baseline record

- Host: Fedora Linux 44, kernel `7.1.3-200.fc44.x86_64`, x86_64.
- Worktree filesystem: Btrfs; temporary test filesystem: tmpfs.
- Node `v22.22.2`; npm `10.9.7`; Git `2.55.0`.
- Disposable nested Git init/commit/ref update: permitted outside the managed command sandbox.
- Symlink creation: permitted.
- Node child processes and IPC: permitted outside the managed command sandbox.
- Managed command sandbox restriction: nested executable stdout/execution is intercepted, causing
  five false baseline failures in child-Node/Git tests. The same tests pass in an unrestricted
  local command.
- Default npm cache is not writable in the managed sandbox. Use
  `npm_config_cache=/tmp/maswe-issue11-npm-cache` for packaging there.
- Baseline: `npm ci`, typecheck, build, sandbox-adjusted `pack:dry`, and `git diff --check` pass.
  Unrestricted `npm test`: 163 pass, 0 fail, 3 authenticated Cursor smoke tests skipped.

## Expected files

**Production**

- Create `src/lock-protocol.ts`.
- Modify `src/store.ts`.
- Modify `src/cli.ts` only for precise force/recovery guidance if required by tests.

**Tests**

- Create `test/fixtures/lock-worker.ts`.
- Create `test/issue11-lock-recovery.test.ts`.
- Create `test/issue11-lock-contention.test.ts`.
- Update `test/store-locking.test.ts`, `test/lock-ownership.test.ts`,
  `test/lock-barrier.test.ts`, and `test/rc-review-corrections.test.ts` only for the new lock
  representation and preserved legacy coverage.

**Documentation**

- Modify `docs/superpowers/specs/2026-07-23-issue-11-lock-recovery-design.md` status only.
- Modify `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/OPERATIONS.md`,
  `skills/maswe/references/commands.md`, and `CHANGELOG.md`.
- Create `docs/adr/0006-ownership-safe-local-lock-directories.md` and update
  `docs/adr/README.md`.

## Deterministic barrier protocol

The fixture is spawned with Node IPC. The parent sends `START`, `CONTINUE:<transition>`, and
`RELEASE`; workers send JSON messages containing `actor`, `pid`, `kind`, `token` where safe,
`transition`, and `result`.

Production helpers accept an optional transition callback. A worker callback sends the named
transition and awaits the matching parent continuation. Ordinary production callers pass no
callback. Required transitions are `DIRECTORY_CLAIMED`, `TEMP_RECORD_CREATED`,
`RECORD_PARTIALLY_WRITTEN`, `RECORD_SYNCED`, `TOKEN_PUBLISHED`, `OWNERSHIP_VALIDATED`,
`OWNER_VALIDATED`, `TOKEN_REMOVED`, `DIRECTORY_EMPTY`, `REPLACEMENT_MKDIR_COMPLETE`,
`REPLACEMENT_TOKEN_PUBLISHED`, `RECOVERY_MARKER_OBSERVED`, `RECOVERY_MARKER_VALIDATED`,
`RECOVERY_CLEANUP_COMPLETE`, `RECOVERY_CLAIM_COMPLETE`, and `RECOVERY_ENTERED`.

Each parent wait has a bounded watchdog that only fails a hung test. No timeout or sleep releases
an actor or determines the ordering. Contenders begin from one parent-controlled IPC gate.

## Task 1: Freeze the approved status and record this plan

**Files**

- Modify: `docs/superpowers/specs/2026-07-23-issue-11-lock-recovery-design.md`
- Add: `docs/superpowers/plans/2026-07-23-issue-11-lock-recovery.md`

1. Change only the design status to `Approved for Phase B implementation`.
2. Run `git diff --check`.
3. Confirm the diff contains only the plan and one status line.
4. Commit:

   ```bash
   git add docs/superpowers/plans/2026-07-23-issue-11-lock-recovery.md \
     docs/superpowers/specs/2026-07-23-issue-11-lock-recovery-design.md
   git commit -m "docs: add issue 11 lock recovery implementation plan"
   ```

## Task 2: Lock format, state classifier, and semantic errors

**Files**

- Create: `src/lock-protocol.ts`
- Create: `test/issue11-lock-recovery.test.ts`

1. Add failing focused tests for absent, empty directory, temporary singleton, partial temporary
   singleton, valid live/dead format-2 token, corrupt JSON/schema/timestamp/PID/kind, filename-owner
   mismatch, multiple entries, canonical symlink, child symlink, canonical regular-file legacy
   record, and unexpected child type. Verify `lstat` behavior leaves link targets untouched.
2. Run:

   ```bash
   node --experimental-strip-types --test test/issue11-lock-recovery.test.ts
   ```

   Confirm failures are missing classifier/error exports, not fixture errors.
3. Implement:

   - `LockKind = "data" | "admin" | "admin-recovery"`;
   - `LockRecordV2` validation for `format: 2`, positive integer PID, UUID, ISO timestamp, kind/path
     association, recovery metadata, and filename/owner equality;
   - `LockIdentity` from non-following `lstat` `dev`/`ino` values, rejecting zero/unavailable or
     unstable identity as `LOCK_UNSUPPORTED_FILESYSTEM`;
   - discriminated states: absent, claimed-empty, temporary, valid-live, valid-dead, corrupt,
     unsafe, multiple, and legacy-live/dead/corrupt;
   - `LockProtocolError` with stable `code`, semantic state, safe metadata, and `cause`;
   - platform-code-to-semantic helpers without claiming identical codes.
4. Re-run the focused test and `test/lock-ownership.test.ts`.
5. Commit:

   ```bash
   git add src/lock-protocol.ts test/issue11-lock-recovery.test.ts
   git commit -m "feat: classify version 2 lock directories"
   ```

## Task 3: Exclusive acquisition and mandatory final validation

**Files**

- Modify: `src/lock-protocol.ts`
- Modify: `src/store.ts`
- Create: `test/fixtures/lock-worker.ts`
- Create: `test/issue11-lock-contention.test.ts`
- Modify: `test/store-locking.test.ts`

1. Add failing tests for:

   - existing empty directory unchanged;
   - existing incomplete directory unchanged;
   - two children released onto exclusive `mkdir`, exactly one validated owner;
   - crash after `DIRECTORY_CLAIMED`;
   - crash at `RECORD_PARTIALLY_WRITTEN`;
   - crash at `RECORD_SYNCED`;
   - canonical directory replacement between claim and temp/final validation;
   - no ownership handle and no protected callback before `OWNERSHIP_VALIDATED`.
2. Run both new focused files outside the managed sandbox and capture expected failures.
3. Implement `acquireDirectoryLock`:

   ```text
   randomUUID
   mkdir(lockPath, { mode: 0o700 })             # never recursive
   capture canonical lstat identity
   open(.record-<owner>-<nonce>, "wx", 0o600)
   revalidate canonical identity
   write complete JSON + newline
   filehandle.sync()
   close
   revalidate canonical identity
   rename internal temp to unique UUID basename
   classify canonical path
   require same directory identity and exact sole valid token
   return retained ownership handle
   ```

   `EEXIST` always classifies; it never overwrites or reclaims. Temporary cleanup targets only the
   actor's unique temp after identity proof and preserves primary plus cleanup errors. Bounded
   retries apply only to live contention/deletion-pending semantics, never correctness.
4. Route data, admin, and recovery-marker acquisition through the shared primitive. Data
   acquisition remains under admin serialization and `withAdminLock` checks the recovery marker
   both before acquisition and after final admin ownership validation.
5. Re-run focused tests, `test/store-locking.test.ts`, and `test/lock-barrier.test.ts`.
6. Commit:

   ```bash
   git add src/lock-protocol.ts src/store.ts test/fixtures/lock-worker.ts \
     test/issue11-lock-contention.test.ts test/store-locking.test.ts
   git commit -m "feat: acquire locks with exclusive directory claims"
   ```

## Task 4: Owner-token-specific release

**Files**

- Modify: `src/lock-protocol.ts`
- Modify: `src/store.ts`
- Modify: `test/issue11-lock-recovery.test.ts`
- Modify: `test/issue11-lock-contention.test.ts`

1. Add failing tests for token mismatch, missing token, changed directory identity, unsafe path,
   replacement singleton, cleanup interruption, injected deletion-pending, and protected-work plus
   cleanup dual failure.
2. Add the real-process old-owner/force/replacement barrier:

   - pause `O` at `OWNER_VALIDATED`;
   - force removes exact `O` and empty directory;
   - `N` publishes and validates;
   - resume `O`;
   - assert `LOCK_OWNERSHIP_LOST`, no `rmdir`, and surviving `N`.

   Add the empty-directory window variant: pause `O` after `TOKEN_REMOVED`, prove `N` receives
   exists without overwrite, then allow empty-only removal and retry.
3. Run focused tests and confirm the old compare/remove implementation fails.
4. Implement `removeOwnedDirectory(lockPath, handle)`:

   - use only the retained UUID and original directory identity;
   - require the expected UUID entry to be the sole valid entry;
   - unlink only `lockPath/<expected-token>`;
   - stop before `rmdir` on missing/mismatched/changed ownership;
   - after exact unlink, use only non-recursive `rmdir`;
   - classify non-empty/replacement/deletion-pending/cleanup errors;
   - never recurse or unlink the canonical pathname;
   - preserve protected-work and cleanup failures with `AggregateError`.
5. Make normal data release admin-serialized while avoiding recursive lock acquisition; admin and
   marker release directly use retained ownership handles.
6. Re-run focused and adjacent store/CAS/artifact tests.
7. Commit:

   ```bash
   git add src/lock-protocol.ts src/store.ts test/issue11-lock-recovery.test.ts \
     test/issue11-lock-contention.test.ts
   git commit -m "fix: release only exact lock owner tokens"
   ```

## Task 5: Explicit data recovery and legacy compatibility

**Files**

- Modify: `src/lock-protocol.ts`
- Modify: `src/store.ts`
- Modify: `src/cli.ts`
- Modify: `test/issue11-lock-recovery.test.ts`
- Modify: `test/lock-ownership.test.ts`

1. Add failing tests for new-format live/dead/corrupt/incomplete data states with and without force,
   legacy live/dead/corrupt/incomplete regular files, changed observations after serializer entry,
   and singleton cleanup identity changes.
2. Prove normal unlock enters `.admin.lock`, discards its pre-lock observation, freshly classifies,
   and never unlinks a replacement.
3. Implement policy:

   - valid live: `LOCK_LIVE_OWNER` without force;
   - valid dead: explicit exact-token recovery;
   - corrupt/incomplete: refuse without force;
   - force: require operator quiescence assertion already represented by `--force`;
   - empty: empty-only `rmdir`;
   - one eligible regular singleton: capture directory/child identity and basename, immediately
     revalidate, unlink only that basename, then non-recursive `rmdir`;
   - unsafe/multiple/unstable: fail closed;
   - legacy: read only, preserve policy, serialized canonical unlink once, never write legacy.
4. Improve CLI error guidance without changing command names or force meaning.
5. Re-run focused, CLI, lock ownership, CAS, and atomic-write tests.
6. Commit:

   ```bash
   git add src/lock-protocol.ts src/store.ts src/cli.ts \
     test/issue11-lock-recovery.test.ts test/lock-ownership.test.ts
   git commit -m "feat: recover data locks conditionally"
   ```

## Task 6: Administrative recovery-marker bootstrap

**Files**

- Modify: `src/lock-protocol.ts`
- Modify: `src/store.ts`
- Modify: `test/fixtures/lock-worker.ts`
- Modify: `test/issue11-lock-recovery.test.ts`
- Modify: `test/issue11-lock-contention.test.ts`
- Modify: `test/rc-review-corrections.test.ts`

1. Add failing tests for:

   - live marker rejected as `ADMIN_RECOVERY_CONCURRENT` even with force;
   - dead marker requires force and exact-token cleanup;
   - incomplete empty marker requires force and empty-only cleanup;
   - eligible temporary/malformed singleton conditional cleanup;
   - unsafe/multiple marker rejection;
   - marker ownership loss and cleanup interruption;
   - child crash at every marker publication phase;
   - absent admin lock still requires validated marker ownership.
2. Add two-child barriers for dead marker and incomplete empty marker. Both observe and race cleanup,
   both retry exclusive `mkdir`, exactly one reaches `RECOVERY_ENTERED`, and the loser returns
   `ADMIN_RECOVERY_CONCURRENT`.
3. Run focused tests and capture failures.
4. Implement the bounded bootstrap loop with no higher recovery lock:

   - exclusive marker acquisition and final validation;
   - live marker never revoked;
   - force-only dead/empty/eligible-singleton cleanup;
   - cleanup success always returns to `mkdir`;
   - only a fresh validated token enters;
   - loser classification is concurrent recovery;
   - exit removes only the winner token then empty-only directory;
   - marker cleanup failure prevents a successful recovery claim.
5. While owning the marker, freshly classify/recover `.admin.lock` using the same live/dead/
   corrupt/incomplete policy and exact removal primitives.
6. Re-run focused tests and all existing admin recovery tests.
7. Commit:

   ```bash
   git add src/lock-protocol.ts src/store.ts test/fixtures/lock-worker.ts \
     test/issue11-lock-recovery.test.ts test/issue11-lock-contention.test.ts \
     test/rc-review-corrections.test.ts
   git commit -m "feat: serialize administrative lock recovery"
   ```

## Task 7: Unsafe paths, Windows semantics, and no-recursion audit tests

**Files**

- Modify: `src/lock-protocol.ts`
- Modify: `test/issue11-lock-recovery.test.ts`
- Modify: `test/issue11-lock-contention.test.ts`

1. Add failing/injected tests for canonical junction/reparse classification where detectable,
   reparse child, deletion pending, busy/access-denied/non-empty mapping, bounded retry exhaustion,
   unsupported identity, and no recursive-removal invocation.
2. On non-Windows, label reparse/deletion-pending tests injected. On Windows, create native junction
   and held-handle fixtures where Node exposes the behavior; never report injected coverage as
   native.
3. Implement conservative semantic mapping. Only liveness/deletion-pending categories retry.
   Unknown non-following or stable-identity guarantees fail with `LOCK_UNSUPPORTED_FILESYSTEM`.
4. Search the production delta for `rm`, `unlink`, `rmdir`, `rename`, `mkdir`, `recursive`,
   `force`, and all three canonical names. Add a source-audit assertion that no release/recovery
   code has a recursive public-lock deletion fallback.
5. Re-run focused tests.
6. Commit:

   ```bash
   git add src/lock-protocol.ts test/issue11-lock-recovery.test.ts \
     test/issue11-lock-contention.test.ts
   git commit -m "test: harden lock path and platform boundaries"
   ```

## Task 8: Repeated real-process contention evidence

**Files**

- Modify: `test/issue11-lock-contention.test.ts`
- Modify: `package.json` only if dedicated repeat scripts materially improve reproducibility;
  do not add dependencies or commit a lockfile.

1. Add explicit repeat selection controlled by a test argument/environment count, with every
   iteration using fresh directories and barrier-controlled children.
2. Run focused contention 25 times and record pass/fail/flake count and duration.
3. Run exact release/replacement survival 100 times and record pass/fail/flake count and duration.
4. Any failure is blocking. Use systematic debugging, retain the first failure evidence, and do
   not conceal it with a later green rerun.
5. Assert totals: zero dual owners, zero replacement deletion, zero recursive fallback.
6. Commit test/script changes only if needed:

   ```bash
   git add test/issue11-lock-contention.test.ts package.json
   git commit -m "test: repeat ownership-safe lock races"
   ```

## Task 9: Documentation and compatibility guidance

**Files**

- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/SECURITY.md`
- Modify: `docs/OPERATIONS.md`
- Add: `docs/adr/0006-ownership-safe-local-lock-directories.md`
- Modify: `docs/adr/README.md`
- Modify: `skills/maswe/references/commands.md`
- Modify: `CHANGELOG.md`

1. Document format-2 directory shape, namespace claim versus ownership, incomplete publication,
   final identity validation, exact-token release, empty-only cleanup, typed failures,
   recovery-marker bootstrap, cleanup-success-versus-ownership distinction, Windows
   deletion-pending bounds, unsupported filesystem boundary, and no-recursion invariant.
2. Document force as a quiescence assertion, not fencing; live marker non-revocation; unsafe/
   multiple-entry manual repair; legacy reads; mixed-version prohibition; quiescent upgrade; and
   rollback requiring new-format cleanup by the new binary.
3. ADR 0006 records rejected ordinary directory rename and native/advisory-lock alternatives.
4. Do not call the protocol distributed, lease-based, process-fencing, crash-proof, or an OS
   sandbox.
5. Run documentation searches and `git diff --check`.
6. Commit:

   ```bash
   git add docs/ARCHITECTURE.md docs/SECURITY.md docs/OPERATIONS.md \
     docs/adr/0006-ownership-safe-local-lock-directories.md docs/adr/README.md \
     skills/maswe/references/commands.md CHANGELOG.md
   git commit -m "docs: document ownership-safe lock recovery"
   ```

## Task 10: Full verification, review, push, and draft PR

1. Read and apply verification-before-completion. From a clean worktree at the exact head, run:

   ```bash
   npm ci
   node --experimental-strip-types --test test/issue11-lock-recovery.test.ts
   node --experimental-strip-types --test test/issue11-lock-contention.test.ts
   # dedicated 25-iteration command
   # dedicated 100-iteration command
   npm run typecheck
   npm test
   npm run build
   npm_config_cache=/tmp/maswe-issue11-npm-cache npm run pack:dry
   npm run check
   git diff --check
   git status --short
   ```

   Run child-process suites outside the managed sandbox. Record exact commands, counts, durations,
   OS/filesystem, Node, npm, failures, investigation, and final disposition.
2. Audit production call sites:

   ```bash
   rg -n 'rm\\(|unlink\\(|rmdir\\(|rename\\(|mkdir\\(|recursive:|force:|\\.admin\\.lock|\\.lock' src
   ```

   Confirm no public-lock recursive deletion, canonical-path owner unlink, rename-aside, age-based
   reclaim, pre-validation protected work, missing retained token, or hidden cleanup failure.
3. Inspect exact delta from `git merge-base HEAD origin/main`; confirm no Issue #12/#13/#3/#5
   behavior.
4. Use requesting-code-review and the repository code-review workflow. Resolve all blocking
   Issue-#11 findings with TDD and repeat exact-head verification after behavioral changes.
5. Commit only necessary verification corrections. Keep commits reviewable; do not squash.
6. Push the tracking branch with `git push`.
7. Open a draft PR titled `Harden ownership-safe lock recovery` against `main`. Include `Closes
   #11`, base/head/design/plan SHAs, safety invariant, protocol and compatibility summaries,
   acceptance/test matrix, 25/100 evidence, environment, all commands, CI status, deletion audit,
   Windows native/injected distinction, out-of-scope statement, and no-merge authorization.
8. Wait for CI for the exact PR head and record workflow/job/artifact IDs and conclusions. Fix only
   Issue-#11 failures, rerun exact-head verification, push, and wait for the new exact head.
9. Apply finishing-a-development-branch only to prepare the branch/PR; do not merge or mark ready
   before independent validation.

## Acceptance criteria to tests

| # | Acceptance case | Planned test |
|---:|---|---|
| 1 | Empty canonical directory never overwritten | Recovery focused: inode/identity unchanged after acquire refusal |
| 2 | Incomplete directory remains fail closed | Recovery focused: empty/temp/partial states remain unchanged |
| 3 | Acquire versus old-owner empty window | Contention: `TOKEN_REMOVED` barrier blocks overwrite |
| 4 | Old owner cannot remove replacement | Contention: `OWNER_VALIDATED`/replacement barrier |
| 5 | Two `mkdir` acquirers, one winner | Contention: shared start IPC, exactly one validated handle |
| 6 | Crash after `mkdir` | Worker kill at `DIRECTORY_CLAIMED` |
| 7 | Crash during partial temp write | Worker kill at `RECORD_PARTIALLY_WRITTEN` |
| 8 | Crash after close before rename | Worker kill at `RECORD_SYNCED` |
| 9 | Token/record mismatch | Classifier and release focused test |
| 10 | Multiple token entries | Classifier/recovery no-mutation test |
| 11 | Canonical symlink | Non-following target-survival test |
| 12 | Token symlink | Non-following target-survival test |
| 13 | Windows junction/reparse | Native when Windows; otherwise explicitly injected |
| 14 | Windows deletion pending | Native when available; otherwise injected bounded retry |
| 15 | Two recover dead marker | Recovery child cleanup/claim barriers |
| 16 | Two recover empty marker | Recovery child cleanup/claim barriers |
| 17 | Live marker rejected with force | Live child retains marker; both forced contenders rejected |
| 18 | No recursive deletion | Filesystem adapter assertion plus production source audit |
| 19 | Focused contention 25 times | Dedicated real-child repeat command, required 25/25 |
| 20 | Release/replacement 100 times | Dedicated exact-race repeat command, required 100/100 |

Preserved regressions include normal data/admin acquisition and release, normal data/admin unlock,
dead-owner recovery, non-force live/corrupt/incomplete rejection, optimistic versions, atomic
writes, artifacts, CLI behavior, and legacy regular-file compatibility.

## Windows and compatibility classification

Linux/Btrfs and Linux/tmpfs are native local evidence for this implementation session. Windows
branches exercised on Linux are injected semantic tests and must be labeled as such. If an exact
head later runs on Windows, report its run separately. No NFS, SMB, distributed FUSE,
object-store-backed, cross-host, or distributed-worker claim is made.

New code writes only version-2 directories. PR #10 regular-file locks remain readable and
explicitly recoverable under the new serializers. Mixed versions are unsupported during active
locking; upgrade and rollback require quiescence, and rollback requires removing version-2 locks
with the new binary first.
