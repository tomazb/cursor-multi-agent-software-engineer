# Design: Ownership-Safe Forced Lock Recovery

**Issue:** GitHub #11 — Harden forced lock recovery and ownership-safe release
**Date:** 2026-07-23
**Status:** Awaiting repository-owner design approval
**Branch:** `issue/11-lock-recovery`
**Base:** `dab10487baf7f05867b54895ec5db109ad3a3e65` (freshly fetched `origin/main`)

## Problem and scope

PR #10 introduced complete temp-plus-hard-link lock records, explicit stale-lock recovery, an
administrative lock around data-lock acquisition and explicit unlock, and an administrative
recovery marker. Two forced-recovery races remain:

1. `releaseOwnedLock` reads owner `O`, reads `O` again, and unlinks the shared pathname. A forced
   actor can remove `O`, replacement owner `N` can acquire that pathname, and the delayed unlink
   can remove `N`.
2. `unlockAdmin --force` recursively removes an existing unowned `.admin.lock.recovering`
   directory and recreates it. Two forced recoverers can therefore both believe they own the
   recovery critical section.

This design changes only the local file-store locking and administrative-recovery protocol needed
by Issue #11. It does not add distributed-store behavior, automatic merging, or any part of Issues
#12, #13, #3, or #5. Optimistic run versions, atomic run/artifact writes, approval policy, runtime
policy, scope checks, and verification policy remain unchanged.

## Current protocol

### Data-lock acquisition

`FileRunStore.acquireLock` enters `withAdminLock`, writes a complete JSON record
`{pid,owner,at}` to a unique temporary file, and hard-links it to `.lock`. `link` supplies the
exclusive create. A live existing owner causes retry; dead, corrupt, and incomplete data locks are
never reclaimed automatically. After exhausting retries, the error directs the operator to
`maswe unlock <run-id>`.

### `releaseOwnedLock`

The helper reads the shared lock pathname, compares its `owner` to the expected token, reads and
compares it a second time, then calls `rm(path, {force:true})`. The comparisons and pathname removal
are separate filesystem operations. The second comparison narrows but does not close the
time-of-check/time-of-use window.

Both normal data-lock release and `withAdminLock` cleanup use this helper. Normal data-lock release
does not enter the administrative mutex.

### Ordinary explicit unlock

`unlock` observes `.lock` before entering the administrative mutex:

- live complete record without `--force`: refuse;
- dead complete record: eligible for explicit recovery;
- corrupt or incomplete record without `--force`: refuse;
- any of the above with `--force`: eligible after the operator confirms no writer is active.

After the optional test barrier, `unlock` enters `.admin.lock`, re-reads `.lock`, compares the
observed owner token, repeats the live-PID check for non-force operation, unlinks `.lock`, and checks
whether a parseable record remains. Data acquisition also takes `.admin.lock`, so conforming
acquire and explicit-unlock operations do not overlap.

### `.admin.lock`

`withAdminLock` checks that `.admin.lock.recovering` is absent, then publishes a complete
`{pid,owner,at}` file through temp-plus-`link`. A live admin owner causes retry. A dead, corrupt, or
incomplete admin record fails closed and directs the operator to `maswe unlock-admin`. Admin locks
are not reclaimed automatically.

Cleanup calls `releaseOwnedLock`, so it has the same compare-then-unlink race as data-lock cleanup.

### `unlockAdmin` and `.admin.lock.recovering`

`unlockAdmin` observes `.admin.lock` before creating the recovery marker. It refuses a live owner
without `--force` and refuses corrupt or incomplete content without `--force`.

Recovery serialization currently uses `mkdir(".admin.lock.recovering")`. The marker is an empty,
unowned directory. If it exists:

- non-force recovery refuses;
- force recovery recursively removes it and retries `mkdir` once.

Inside the marker, `unlockAdmin` re-reads and owner-compares `.admin.lock`, enforces the live-PID
rule, unlinks the admin pathname, and finally recursively removes the marker. Forced removal and
finally cleanup are not conditional on marker ownership.

### Dead-owner, corrupt/incomplete, and failure cleanup behavior

- Data and admin locks are never reclaimed automatically, regardless of age.
- PID liveness determines live versus dead policy, but the random owner string is the ownership
  identity.
- A dead complete data owner is recovered with `maswe unlock`.
- A dead complete admin owner is recovered with `maswe unlock-admin`.
- Corrupt or incomplete data/admin records require the corresponding `--force` operation.
- A crashed admin recoverer can leave `.admin.lock.recovering`; only
  `maswe unlock-admin --force` clears it.
- Temporary acquisition files are removed best-effort. Existing release cleanup silently returns
  when the expected owner no longer matches.

## Approaches considered

### A — Put normal release under the existing admin lock

This closes the reported data race as long as `.admin.lock` cannot be forcibly revoked. It is not a
complete solution: `unlock-admin --force` is explicitly allowed to revoke an admin owner, after
which the same compare-then-unlink race exists on `.admin.lock`. Safety would depend on a higher
level mutex with the same recovery problem.

**Rejected as insufficient.**

### B — Tokenized files with another read, inode check, or rename-aside

An additional content read or `stat` still precedes an unconditional pathname unlink. Node does not
expose a portable compare-and-unlink primitive. Renaming the shared path aside before checking it
can move a replacement owner out of the lock path and create a lock-free window even if the
replacement is later restored.

**Rejected because validation and removal remain separable or a replacement is disrupted.**

### C — OS advisory locks or a native compare-delete helper

`flock`, `fcntl`/open-file-description locks, and Windows handle locks could provide stronger
kernel ownership, but Node core does not expose one portable primitive with the required explicit
dead/corrupt recovery semantics. A native addon or platform helper would add deployment and
packaging scope not justified for this local TypeScript CLI.

**Rejected for portability and scope.**

### D — Non-empty ownership directories with token-addressed removal

Publish a complete, non-empty directory for each lock. Its sole entry is named by the unique owner
token. Release may unlink only that exact entry and may remove the shared directory only with
non-recursive `rmdir`, which succeeds only while the directory is empty.

If a forced actor removes `O` and replacement `N` is installed, `O`'s token entry does not exist in
`N`'s directory. If replacement occurs after `O` removes its own entry, `N` makes the directory
non-empty before `O` can `rmdir` it. In neither ordering can `O` remove `N`.

**Selected.**

## Selected ownership identity and on-disk representation

Every lock acquisition generates a cryptographically random UUID owner token. The token, not PID or
age, is authoritative ownership identity. PID is used only for live/dead recovery policy.

Version-2 locks are directories:

```text
.lock/
└── <owner-uuid>

.admin.lock/
└── <owner-uuid>

.admin.lock.recovering/
└── <owner-uuid>
```

The sole token-named entry is a regular UTF-8 JSON file:

```json
{
  "format": 2,
  "pid": 12345,
  "owner": "550e8400-e29b-41d4-a716-446655440000",
  "at": "2026-07-23T18:00:00.000Z"
}
```

The filename and JSON `owner` must match. A complete owned directory has exactly one token entry,
valid format-2 JSON, a positive integer PID, a matching UUID owner, and an ISO timestamp.

Lock parsing returns a discriminated state rather than collapsing failures:

- `absent`;
- `owned` with format, token, PID, timestamp, and `live`/`dead` policy state;
- `legacy-owned` for the PR #10 regular-file format;
- `incomplete` for an empty directory or interrupted initialization;
- `corrupt` for malformed JSON, filename/content mismatch, unexpected type, or multiple entries.

An expected token that no longer names the sole entry is represented by a typed
`LOCK_OWNERSHIP_LOST` error. It is never treated as permission to remove the current shared path.

## Acquisition protocol

For `.lock`, `.admin.lock`, and `.admin.lock.recovering`, one shared helper publishes an owned
directory:

1. Generate token `T` and metadata.
2. Create a unique sibling staging directory ending in `.tmp`.
3. Write its single `T` entry completely.
4. Inspect the public path. Any existing path is classified and blocks normal acquisition;
   incomplete and corrupt states fail closed.
5. Rename the non-empty staging directory to the public path in the same parent directory.
6. If another actor won, the rename fails because the destination is a non-empty directory (or,
   on Windows, because the destination exists). Classify the winner; do not replace it.
7. Re-read the public directory and require token `T` before entering the critical section.
8. Remove only the caller's unique staging path after failed publication.

The same-parent rename is the atomic publication boundary: no conforming observer sees a valid
format-2 lock without its token record. A destination that exists before step 4 is never
automatically replaced. If the filesystem does not provide the required same-directory rename and
non-empty-directory semantics, acquisition fails closed; there is no regular-file or recursive-rm
fallback.

Normal data acquisition remains inside `.admin.lock`. `withAdminLock` checks the recovery marker
both before publishing its admin lock and immediately after publication. If recovery appeared in
between, it conditionally releases its own admin token and does not enter the critical section.

## Owner-conditional removal protocol

`removeOwnedDirectory(path, expectedToken)` is the only removal operation for a valid format-2
lock or marker:

1. Parse `path`.
2. Require `owned.owner === expectedToken`.
3. `unlink(path/expectedToken)`.
4. If step 3 reports `ENOENT`, report `LOCK_OWNERSHIP_LOST` and stop. Do not call `rmdir`.
5. Call non-recursive `rmdir(path)`.
6. Treat `ENOENT` as released: another actor removed the now-empty old directory.
7. On `ENOTEMPTY`/`EEXIST`, parse the directory:
   - if it is a valid different owner, `O` was released and a replacement is present; return a
     released-with-replacement result without modifying it;
   - otherwise report `LOCK_CLEANUP_FAILED` and leave the path fail-closed.
8. Any permission, I/O, unsupported-filesystem, or unexpected error is
   `LOCK_CLEANUP_FAILED`; never retry with recursive removal.

The unlink in step 3 is the owner comparison. It is not preceded by a comparison followed by
unconditional shared-path deletion: the expected token is part of the pathname being deleted.
The `rmdir` in step 5 is conditional on the shared directory still being empty.

Normal data-lock release enters `.admin.lock`, revalidates the expected data token, and uses this
helper. Admin-lock and recovery-marker cleanup use the helper directly because they are themselves
the serialization primitives.

If the protected operation and cleanup both fail, preserve both failures in an `AggregateError`;
never hide a lock cleanup or ownership-loss error behind the original operation error.

## Why an earlier owner cannot remove a replacement

Let `L/O` be `O`'s token entry and `L/N` be `N`'s.

### Replacement exists before `O` removes its token

Forced actor `F` removes `L/O` and the empty directory, then `N` atomically publishes a non-empty
new `L` containing `L/N`. When `O` resumes, `unlink(L/O)` returns `ENOENT`. The protocol stops before
`rmdir`; `L/N` remains.

### Replacement arrives after `O` removes its token

`O` successfully unlinks `L/O`, so the old directory is empty and `O` has relinquished ownership.
Before `O` executes `rmdir`, `N` publishes its complete non-empty directory at `L` (on POSIX this
may replace the empty old directory; on Windows it may wait/retry until the old directory is
removed). `O`'s `rmdir(L)` then fails because `L/N` makes `L` non-empty. `O` does not recurse and
cannot delete `N`.

### Forced actor and owner remove the same token concurrently

Only one `unlink(L/O)` succeeds. The loser receives `ENOENT` and stops. If a new owner publishes
between the winning unlink and `rmdir`, the non-empty rule protects the new owner as above.

These cases cover every ordering around the two removal operations. Safety depends on unique,
unguessable owner tokens, valid locks containing exactly one token entry, and non-recursive
directory removal.

## Precise data-lock race model

The required `O`/forced actor/`N` race is:

| State | Owner `O` | Forced actor `F` | Replacement `N` | Public `.lock` |
|---|---|---|---|---|
| D0 | holds critical section | idle | idle | `O` |
| D1 | begins release, observes `O`, pauses at barrier | idle | idle | `O` |
| D2 | paused | acquires admin lock, revalidates `O`, conditionally removes `O` | idle | absent |
| D3 | paused | exits admin lock | publishes and holds `N` | `N` |
| D4 | resumes, acquires admin lock, expects `O` | idle | holds | `N` |
| D5 | gets `LOCK_OWNERSHIP_LOST`; performs no unlink/rmdir on `N` | idle | still holds | `N` |

The pre-admin observation in D1 is informational and provides the deterministic test barrier. The
authoritative comparison occurs under the admin lock and, ultimately, in `unlink(.lock/O)`.

## Administrative recovery serialization

### Acquisition

`unlockAdmin` must own a format-2 `.admin.lock.recovering` directory before it examines or removes
`.admin.lock`. Marker acquisition uses the same complete-directory publication protocol.

If no marker exists, the actor publishes its own token and enters. If a complete marker exists:

- if its PID is live, report `ADMIN_RECOVERY_CONCURRENT` and do not remove it, even with
  `--force`;
- if its PID is dead, require `--force`, observe its token, conditionally remove that token, and
  attempt exactly once to publish the caller's marker;
- if the observed token disappears or another actor publishes first, report
  `ADMIN_RECOVERY_CONCURRENT`/`LOCK_OWNERSHIP_LOST` and do not enter.

`--force` never revokes a live recovery marker. Otherwise the previous recoverer could still be
inside the critical section and no pathname protocol could prevent overlap. Force authorizes
recovery of dead, corrupt, or incomplete markers and live-looking data/admin locks after the
documented operator check; it does not authorize recursive deletion or entry without marker
ownership.

### Two forced actors racing

If active marker owner `R` is live, forced actors `A` and `B` are both rejected and neither enters.
If `R` has crashed, `A` and `B` can both observe the dead marker, but only one can unlink
`.admin.lock.recovering/R`. The loser stops on `ENOENT`. The winner removes the empty old marker and
attempts to publish its own complete marker. If a third actor publishes first, the winner also
stops. Therefore, only the actor whose token is verified in the public marker enters recovery.

### Stale/dead and forced recovery

A dead complete marker is not reclaimed automatically by ordinary store operations. Non-force
`unlockAdmin` reports an abandoned recovery marker and directs the operator to `--force`. Forced
recovery uses the same conditional token removal and one-shot reacquisition.

An empty legacy or interrupted marker is `incomplete`. With `--force`, `rmdir` is the conditional
claim: only one actor can remove the empty directory. An actor that observed it but receives
`ENOENT` stops as a concurrent loser rather than proceeding. A non-empty malformed marker is
`corrupt`; recovery removes only the exact entries observed, stops on any missing entry, and then
uses non-recursive `rmdir`. A conforming replacement's unique token entry therefore prevents
deletion. Regular-file/symlink marker types fail closed and require operator-quiescent manual
repair because no portable safe directory-conditional primitive applies.

### Admin-lock removal

Once it owns the marker, `unlockAdmin` classifies the current `.admin.lock`:

- absent: recovery is already complete;
- live complete owner: refuse without force, conditionally remove with force;
- dead complete owner: conditionally remove;
- corrupt/incomplete: refuse without force, remove only through the conditional corrupt/incomplete
  directory protocol with force;
- changed since any earlier observation: use the current marker-protected state, never stale
  metadata.

Legacy regular-file admin locks remain recoverable only while the owned recovery marker blocks all
new-version admin acquisition. See compatibility below.

### Conditional cleanup

The recoverer releases `.admin.lock.recovering` only by removing its own token entry followed by
non-recursive `rmdir`. Token mismatch is a visible ownership-loss failure. Recursive marker removal
is forbidden.

### Crash behavior

- Crash before marker publication: only a uniquely named `.tmp` staging directory can remain; no
  recovery critical section was entered.
- Crash after marker publication: a complete marker with the crashed PID remains. Normal writers
  fail closed; `unlockAdmin --force` conditionally recovers it.
- Crash after admin-lock removal but before marker cleanup: the complete dead marker remains and is
  recovered the same way; absence of `.admin.lock` is then an idempotent success.
- Crash after token unlink but before `rmdir`: an empty incomplete directory remains. Normal
  operations fail closed; force recovery may remove it with atomic `rmdir`.
- Staging directories and their descendants are excluded from read-only fingerprints and are
  best-effort cleaned by their creator. Orphan staging directories are inert and may be removed
  during explicit recovery; they never authorize entry. Explicit recovery bounds cleanup to
  staging names in the selected run directory and never recursively targets a public lock path.

## Failure taxonomy and user-visible errors

Errors retain the run ID, lock kind, path, expected/actual token when safe, and recovery command.
The stable category appears in the message and on the typed error:

| Category | Required behavior and message intent |
|---|---|
| `LOCK_LIVE_OWNER` | Non-force refuses: lock is held by live PID; use force only after confirming no writer is active. |
| `LOCK_DEAD_OWNER` | Automatic acquisition refuses and identifies an abandoned lock; explicit non-force `unlock`/`unlock-admin` may recover it. |
| `LOCK_CORRUPT` | Explain the invalid type/content/token mismatch; non-force refuses and points to force or manual repair as appropriate. |
| `LOCK_INCOMPLETE` | Explain the empty/interrupted directory; non-force refuses because an initializer or interrupted cleanup may exist. |
| `LOCK_OWNERSHIP_LOST` | “Expected owner O, found N/absent; replacement was not removed.” No shared-path deletion follows. |
| `ADMIN_RECOVERY_CONCURRENT` | Another recovery token owns or won the marker; at most one actor entered. Include live/dead PID when parseable. |
| `LOCK_CLEANUP_FAILED` | State whether the token entry was removed, name the remaining path, preserve the OS error, and leave the path fail-closed. |
| `LOCK_UNSUPPORTED_FILESYSTEM` | Required atomic publication/empty-directory removal semantics are unavailable; no unsafe fallback was attempted. |

Success output for `unlock` and `unlock-admin` remains compatible. A no-lock idempotent admin
recovery remains success only after the caller owns and conditionally cleans its marker.

## Platform and filesystem semantics

### Linux and POSIX

The protocol relies on same-filesystem directory `rename`, token-entry `unlink`, and non-recursive
`rmdir`. POSIX requires `rename` to be atomic and to reject replacing a non-empty destination
directory with `EEXIST` or `ENOTEMPTY`; `rmdir` removes only empty directories and otherwise fails.
Staging and public paths are siblings, preventing `EXDEV`.

References:

- [POSIX `rename`](https://pubs.opengroup.org/onlinepubs/000095399/functions/rename.html)
- [POSIX `rmdir`](https://pubs.opengroup.org/onlinepubs/009696799/functions/rmdir.html)
- [Node.js file-system promises](https://nodejs.org/download/release/v25.9.0/docs/api/fs.html)

Local Linux filesystems with ordinary POSIX rename semantics (including the test environment's
local temporary filesystem) are supported. NFS, SMB mounts, FUSE implementations, object-store
mounts, and other network/distributed filesystems are not assumed to provide the required
cross-client cache consistency or atomicity and are outside Issue #11.

### Supported Windows behavior

The same directory layout and token removal are used. Staging and public directories must be on the
same volume. Windows directory move/rename refuses an existing destination, and
`RemoveDirectoryW` requires an empty directory. Antivirus/indexer sharing violations, open-handle
behavior, `EPERM`, or `EBUSY`-equivalent failures are cleanup/contention failures, not reasons to
fall back to recursive deletion.

References:

- [Windows `MoveFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexa)
- [Windows `RemoveDirectoryW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw)

Windows tests use the same IPC barriers and assert outcomes rather than exact platform error codes.
Retries may handle transient sharing violations, but correctness never depends on a sleep or retry
winning.

### Primitive unavailable

If atomic same-parent publication, token unlink, or empty-only directory removal is unsupported or
returns an unexpected semantic result, MASWE reports `LOCK_UNSUPPORTED_FILESYSTEM` or
`LOCK_CLEANUP_FAILED` and leaves the lock fail-closed. It must not:

- fall back to `rm -r`/recursive `fs.rm` on a public lock or marker;
- fall back to read-token-then-unlink-path;
- move a replacement aside and restore it;
- auto-reclaim by age.

## Compatibility

PR #10 regular-file locks remain readable as `legacy-owned`:

- live legacy data/admin owners still refuse non-force recovery;
- dead legacy data locks remain explicitly recoverable;
- dead legacy admin locks remain explicitly recoverable;
- corrupt/incomplete legacy files remain rejected without force;
- force remains an operator-quiescent escape hatch.

New acquisition never writes the legacy format. It creates a format-2 directory only when the
public path is absent. A live legacy lock is not migrated in place. Operators upgrading with an
active legacy lock must stop the old MASWE process, recover the legacy path with the documented
command, and then start a new operation.

Mixed old/new MASWE processes against one run directory are unsupported: an old binary can still
perform unconditional pathname deletion and cannot honor the new ownership proof.

The PR #10 `.admin.lock.recovering` marker is an empty directory. It is treated as
legacy/incomplete: non-force fails closed; force claims it through empty-only `rmdir`, and a loser
that receives `ENOENT` does not enter. Existing CLI command names and `--force` flags do not change.

Rollback to PR #10 code requires a quiescent run directory with no format-2 public locks or markers.
Because locks are ephemeral rather than durable run records, no run-schema migration is needed:
stop all MASWE processes, recover any remaining format-2 paths with the new binary, confirm the
three public paths are absent, then roll back. Do not use the old binary as a format-2 cleanup tool.

Read-only fingerprint exclusions must recognize lock staging directories and all their descendants,
while continuing to exclude `.lock`, `.admin.lock`, and `.admin.lock.recovering`. Durable run and
artifact fingerprint coverage is unchanged.

## Deterministic test design

Correctness tests use real Node child processes created with an IPC channel. A dedicated fixture
worker receives commands and emits state messages containing actor name, run ID, lock kind, and
owner token. The parent advances an explicit barrier state machine. No correctness assertion uses a
timing sleep. A bounded watchdog may fail a hung test but never advances a barrier.

Planned files:

- `test/fixtures/lock-worker.ts` — child modes for hold/release, forced unlock, admin recovery,
  crash, and marker inspection;
- `test/issue11-lock-recovery.test.ts` — focused state/error/compatibility regressions;
- `test/issue11-lock-contention.test.ts` — real-process barrier races and repeated contention;
- existing `test/store-locking.test.ts`, `test/lock-ownership.test.ts`,
  `test/lock-barrier.test.ts`, and the admin-recovery section of
  `test/rc-review-corrections.test.ts` updated to the format-2 helpers without weakening their
  assertions.

### Race 1: old owner versus forced replacement

1. Child `O` acquires data lock and reports `O_ACQUIRED`.
2. Parent commands release; `O` observes its token and reports `O_RELEASE_VALIDATED`, then waits.
3. Child `F` runs forced unlock and reports `F_REMOVED_O`.
4. Child `N` acquires and holds the replacement, reporting `N_ACQUIRED`.
5. Parent releases `O`'s barrier.
6. Assert `O` reports `LOCK_OWNERSHIP_LOST`, `N`'s token entry still exists, and a fourth writer
   cannot enter.
7. Release `N` and assert normal acquisition resumes.

### Race 2: two forced administrative recoverers

1. A holder child publishes recovery marker `R`, reports its token, and crashes so the public
   marker is complete but its owner is dead.
2. Children `A` and `B` both observe dead `R` and report `RECOVERY_OBSERVED`.
3. Parent releases both conditional-removal barriers.
4. Exactly one actor may report `RECOVERY_ENTERED` with its verified token. Keep it paused inside
   the critical section.
5. The loser must report `ADMIN_RECOVERY_CONCURRENT` or `LOCK_OWNERSHIP_LOST`.
6. Assert the public marker token equals the winner and no normal admin owner enters.
7. Release the winner; assert conditional marker cleanup.

A separate live-marker test keeps `R` running and proves that both forced actors receive
`ADMIN_RECOVERY_CONCURRENT`; force never creates overlap with a live recovery critical section.

### Crash and interruption

- Crash a child after marker publication. Verify non-force refusal, then forced recovery and normal
  operation.
- Crash after admin-lock removal but before marker cleanup. Verify idempotent forced recovery.
- Interrupt cleanup after token unlink, leaving an empty directory. Verify normal fail-closed
  behavior and forced empty-directory recovery.
- Kill a data owner child. Verify automatic acquisition refuses and ordinary explicit dead-owner
  recovery succeeds.

### Repeated contention

The two multi-process barrier scenarios run 25 iterations in the normal focused test file.
Phase-B validation additionally runs each scenario for 100 iterations through an environment
override, recording exact totals and failures in the PR. Each iteration uses fresh directories and
tokens. IPC ordering is deterministic; iteration count looks for implementation nondeterminism,
not sleep-sensitive scheduling.

## Issue #11 acceptance criteria to planned tests

| Acceptance criterion | Planned deterministic evidence |
|---|---|
| Reproduce normal release versus forced unlock/replacement | `old owner versus forced replacement` IPC sequence reaches the exact D1-D5 barriers. |
| Original releaser cannot remove replacement | Assert `LOCK_OWNERSHIP_LOST`, `N` token/path survives, and another writer remains excluded. |
| Reproduce two concurrent forced admin recoverers | Two child recoverers observe the same active marker and are released concurrently. |
| At most one owns recovery critical section | Count exactly one `RECOVERY_ENTERED`; marker token equals winner; loser has a concurrency/ownership error. |
| Preserve live-owner rejection without force | Focused data/admin/marker tests with live child PID and no force. |
| Preserve corrupt-lock rejection without force | Format-2 malformed JSON, token mismatch, multiple entry, and legacy corrupt-file cases. |
| Preserve incomplete-lock rejection without force | Empty data/admin/marker directory cases. |
| Preserve explicit dead-owner recovery | Kill holder child, reject automatic acquire, then non-force explicit unlock succeeds. |
| Repeated multi-process barriers | 25 normal iterations and explicit 100-iteration Phase-B evidence for both races. |
| Update SECURITY, OPERATIONS, lock/recovery docs | Documentation file matrix below. |
| `npm run check` and packaging pass | Required clean-worktree verification commands recorded at exact PR head. |

Additional required cases:

| Required case | Planned test |
|---|---|
| Owner-token mismatch | Call conditional removal with token `X` against owner `Y`; assert `Y` unchanged. |
| Marker ownership loss | Replace/force-recover marker before old cleanup; assert old cleanup cannot remove winner. |
| Child-process crash | Crash immediately after owned marker publication; recover by dead PID/token. |
| Cleanup interruption | Leave empty directory after token unlink; non-force fails closed and force uses `rmdir`. |
| Normal acquisition/release regression | Save/load/artifact paths acquire and conditionally release format-2 data/admin locks. |
| Existing optimistic concurrency | Existing CAS/version tests remain unchanged and passing. |
| Legacy compatibility | Complete live/dead, corrupt, incomplete regular-file lock and empty legacy marker tests. |
| Filesystem primitive failure | Inject rename/unlink/rmdir errors; assert no recursive or pathname-unlink fallback. |

## Planned Phase-B changes

The smallest expected production change is concentrated in `src/store.ts`:

- discriminated lock-state parser for legacy files and format-2 directories;
- complete-directory publisher;
- token-addressed conditional removal;
- admin-guarded normal data release;
- owned administrative recovery marker;
- typed failure categories and deterministic test hooks.

`src/git-snapshot.ts` changes only to exclude descendants of lock staging directories. `src/cli.ts`
retains command syntax and updates force/recovery guidance. No state-machine, runtime adapter,
model, approval, artifact-CAS, or git-workspace behavior changes.

The Phase-B TDD order after approval is:

1. Add IPC worker and failing race reproductions.
2. Add failing token-mismatch, marker-loss, crash, interruption, and primitive-failure tests.
3. Implement format-2 parser/publication/removal and make focused tests pass.
4. Route data, admin, and recovery marker operations through the shared protocol.
5. Add legacy compatibility and normal/dead-owner regressions.
6. Run repeated contention and the full required verification matrix.
7. Update documentation and create a draft PR only after exact-head verification.

A detailed Superpowers implementation plan will be written after repository-owner approval of this
spec, before any production or test implementation begins.

## Documentation changes after approval

- `docs/SECURITY.md`: add the forced-recovery threat, owner-token directory invariant,
  fail-closed ownership-loss/cleanup behavior, filesystem trust assumptions, and mixed-version
  warning.
- `docs/OPERATIONS.md`: document format-2 paths, live/dead/corrupt/incomplete decisions, force
  preconditions, crash/interrupted cleanup, exact recovery commands, and unsupported filesystem
  behavior.
- `docs/ARCHITECTURE.md`: replace the regular-file lock description with the acquisition/removal
  protocol and administrative recovery serialization.
- `docs/adr/0006-ownership-safe-local-lock-directories.md` and `docs/adr/README.md`: record the
  storage protocol decision, platform constraints, consequences, and rejected alternatives.
- `skills/maswe/references/commands.md`: update CLI recovery guidance and ownership-loss messages.
- `src/cli.ts`: clarify `--force` help without changing command syntax.
- `CHANGELOG.md`: record the Issue #11 hardening under the unreleased section.

`docs/PRD.md` requires no requirement change: this design strengthens NFR-1 reliability and the
existing fail-closed principle without changing product scope.

## Residual risks and operator preconditions

- `--force` against a live data or admin owner is not process fencing. The old process may continue
  its protected work after its token is revoked. This design prevents its delayed cleanup from
  deleting a replacement, but it cannot make concurrent writes safe. Operators must still confirm
  that the apparent live owner is not performing work before forcing data/admin recovery.
- PID liveness can be conservative or misleading because of PID reuse and platform permission
  behavior. PID never authorizes removal; it only chooses whether explicit force is required.
- Correctness is limited to cooperating new-version processes on a supported local filesystem.
  Mixed binaries, direct filesystem mutation, and network/distributed mounts remain unsupported.
- A crash can leave fail-closed public directories or inert staging directories that require
  explicit operator recovery. This favors safety over automatic availability and may create small
  per-run filesystem cleanup toil.
- Windows sharing violations may delay cleanup and require retry after the process holding the
  handle exits. They must remain visible; they cannot trigger a recursive fallback.

## Design invariants

1. A valid public lock or marker is always a non-empty directory containing exactly one
   token-named record.
2. Token identity, not PID or timestamp, authorizes removal.
3. Valid lock/marker removal never recursively deletes a public path.
4. A caller unlinks only its expected token entry and calls `rmdir` only after that succeeds.
5. `ENOENT` on the expected token is ownership loss, never permission to remove the directory.
6. `ENOTEMPTY` protects a replacement owner.
7. No data/admin/marker stale reclaim is automatic.
8. Only a verified recovery-marker owner enters administrative recovery.
9. Force changes recovery policy, not ownership proof.
10. Unsupported filesystem semantics fail closed without fallback.

## Approval gate

No production code or tests will be changed until the repository owner explicitly approves this
design. After approval, the implementation plan and tests precede production changes.

`WAITING_FOR_DESIGN_APPROVAL`
