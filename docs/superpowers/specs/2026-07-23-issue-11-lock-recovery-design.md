# Design: Ownership-Safe Forced Lock Recovery

**Issue:** GitHub #11 — Harden forced lock recovery and ownership-safe release
**Date:** 2026-07-23
**Status:** Approved for Phase B implementation
**Branch:** `issue/11-lock-recovery`
**Base:** `dab10487baf7f05867b54895ec5db109ad3a3e65` (freshly fetched `origin/main`)
**Original Phase-A head:** `8d1fb5fa32b4392f27d04eff0717cb1bce411efd`

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

This narrows the data-lock race but does not solve revocation of `.admin.lock` itself. A higher
mutex would reproduce the same bootstrap problem.

**Rejected as insufficient.**

### B — Read, compare, then unlink the canonical path

An additional read, `stat`, or inode comparison still precedes an unconditional pathname unlink.
Renaming the canonical path aside can move a replacement and create a lock-free window.

**Rejected because ownership validation and destructive action remain separable.**

### C — Publish a prepared directory with ordinary `rename`

POSIX `rename()` is atomic but is not a portable no-clobber primitive: it may remove and replace an
existing empty destination directory. Linux adds `renameat2(RENAME_NOREPLACE)`, but that operation
is Linux-specific, depends on filesystem support, and is not exposed by the supported Node
`fsPromises.rename(oldPath, newPath)` API. Windows reports an error when the destination is an
existing directory, so its conflict behavior also differs from POSIX.

**Rejected because ordinary directory rename cannot supply one cross-platform acquisition
invariant.**

### D — OS advisory locks or a native compare-delete helper

`flock`, `fcntl`/open-file-description locks, and Windows handle locks could provide kernel
ownership, but Node core does not expose one portable primitive with the required explicit
dead/corrupt recovery behavior. A native addon or platform helper is outside Issue #11.

**Rejected for portability and scope.**

### E — Exclusive directory claim plus token-addressed removal

Non-recursive `mkdir` exclusively claims the canonical namespace. The claimer then publishes one
UUID-named record inside it. Release unlinks only that exact UUID entry and attempts only
non-recursive `rmdir`. A replacement's different token makes its directory non-empty and
unremovable by the earlier owner.

**Selected.**

## Selected ownership identity and representation

Every acquisition generates a cryptographically random UUID with `crypto.randomUUID()`. This token,
not PID, timestamp, directory identity, or age, is the ownership identity. PID is only a liveness
signal for recovery policy.

Each new-format lock kind uses the same directory shape:

```text
.lock/
└── <owner-uuid>

.admin.lock/
└── <owner-uuid>

.admin.lock.recovering/
└── <owner-uuid>
```

The token entry is a regular UTF-8 JSON file:

```json
{
  "format": 2,
  "pid": 12345,
  "owner": "550e8400-e29b-41d4-a716-446655440000",
  "at": "2026-07-23T18:00:00.000Z",
  "kind": "data",
  "recovery": null
}
```

`kind` is exactly `data`, `admin`, or `admin-recovery`. `recovery` is `null` for ordinary data and
admin acquisition; an administrative recovery record contains the recovery mode and, when known,
the observed admin owner token/state. The schema rejects unknown required fields, an invalid UUID,
a non-positive PID, a non-ISO timestamp, a kind/path mismatch, or a filename that differs from
`owner`.

A valid owned lock has exactly one non-link regular token entry. The in-memory acquisition result
retains the exact UUID. Ownership loss is a typed `LOCK_OWNERSHIP_LOST` result and never grants
permission to delete another pathname or entry.

## Exclusive `mkdir`-first acquisition

One helper is used for `.lock`, `.admin.lock`, and `.admin.lock.recovering`:

1. Generate cryptographically random UUID token `T`.
2. Call non-recursive `mkdir(lockPath, {mode: 0o700})`. The mode is restrictive where the platform
   honors POSIX mode bits. `recursive` is never enabled.
3. `EEXIST`, or the platform-equivalent “name already exists”, enters lock-state inspection. It
   never causes overwrite, rename-over, or recursive removal. Acquisition either reports the
   classified state or performs only the separately authorized recovery protocol.
4. After successful `mkdir`, capture the claimed directory's stable identity. Create a uniquely
   named temporary regular file such as `.record-<T>-<random>` inside the claimed directory with
   exclusive creation (`open(..., "wx", 0o600)`).
5. Immediately after exclusive creation, compare the canonical directory's `lstat` identity with
   the captured identity. On POSIX use `dev` and `ino`; on supported Windows use the stable file
   identity surfaced by Node/libuv. If identity is unavailable, changed, or ambiguous, unlink only
   this actor's unique temporary entry and fail with `LOCK_OWNERSHIP_LOST` or
   `LOCK_UNSUPPORTED_FILESYSTEM`. This check matters if an explicitly forced empty-directory
   recovery races a stale initializer. Once the temporary entry exists in the verified directory,
   empty-only `rmdir` cannot replace that directory.
6. Write the complete JSON record containing schema version, PID, owner token, creation timestamp,
   lock kind, and required recovery metadata.
7. Flush the file handle and close it. This matches the repository durability boundary: file
   contents are synchronized before publication; Issue #11 does not add a parent-directory fsync
   guarantee beyond the existing local-store durability contract.
8. Rename the internal temporary entry to `lockPath/T`. The destination name is a fresh UUID and
   must not exist. An existing destination or any identity change is corruption/ownership loss,
   not permission to replace it.
9. Re-inspect with non-following operations and require the canonical directory to have the same
   stable identity and exactly one valid entry `T`. Only then return an owned lock and enter the
   critical section.

The atomic acquisition property is only the exclusive canonical namespace claim performed by
`mkdir`. The complete non-empty directory does **not** appear atomically. A crash after `mkdir` and
before valid token publication leaves an incomplete lock, which all ordinary actors treat as
locked. Explicit recovery is required.

Temporary-record cleanup unlinks only the exact unique temporary name created by the current
actor. It never removes a canonical directory. If cleanup fails, acquisition fails with both the
primary and cleanup errors preserved.

Normal data acquisition remains inside `.admin.lock`. `withAdminLock` checks
`.admin.lock.recovering` before attempting `.admin.lock` and again after fully owning it. If a
recovery marker appeared, it conditionally releases only its own admin token and does not enter.

## Owner-conditional release

`removeOwnedDirectory(lockPath, expectedToken)` is the only release operation for a valid
new-format lock or marker:

1. Retain and use the exact UUID returned by acquisition; do not rediscover ownership from the
   canonical record.
2. Inspect `lockPath` and `lockPath/expectedToken` without following links. Require the expected
   token entry to be the sole valid regular entry and its JSON owner to equal `expectedToken`.
3. Unlink only `lockPath/expectedToken`.
4. `ENOENT`, a token mismatch, a changed directory identity, or a different current entry is
   `LOCK_OWNERSHIP_LOST`. Do not unlink any other entry and do not call `rmdir`.
5. After successful token unlink, call non-recursive `rmdir(lockPath)`.
6. `ENOTEMPTY`, `EEXIST`, `EBUSY`, `EPERM`, sharing violations, access denial, or platform
   equivalents never trigger recursive deletion. Re-inspect without following links and classify
   replacement, deletion-pending, or cleanup failure.
7. Surface every cleanup failure. Do not report successful release while a cleanup or
   ownership-loss error remains.

`unlink(lockPath/expectedToken)` ties the authority to the object removed: a token mismatch selects
a different pathname, so it cannot be removed. `rmdir(lockPath)` is mechanically conditional on
emptiness. There is no `rm({recursive:true})`, `rm -r`, canonical-path `unlink`, rename-aside, or
“delete whatever is now there” fallback.

Normal data-lock release remains admin-serialized, then uses this helper. Admin-lock and marker
release use the helper directly because they are the serialization primitives. If protected work
and cleanup both fail, preserve both with `AggregateError`.

### Force-only cleanup of one unowned regular entry

Owner release and corrupt/incomplete recovery are different operations. A force operation may
recover an empty directory with empty-only `rmdir`, or one recognized temporary/corrupt **regular**
entry with a separate observed-singleton protocol:

1. Require the appropriate serializer (`.admin.lock` for data, the recovery marker for admin) and
   the documented quiescence assertion. The recovery marker itself has no higher serializer.
2. Require exactly one non-link regular child and capture stable identities for the canonical
   directory and that child plus its exact basename.
3. Revalidate both identities immediately before unlink. A change, missing entry, second entry, or
   unsafe type aborts/reclassifies; it does not broaden the deletion set.
4. Unlink only the captured singleton basename, then call only non-recursive `rmdir`.
5. Cleanup success does not authorize critical-section entry. Recovery-marker contenders must
   still return to exclusive `mkdir`, publish their own token, and validate it.

This protocol allows explicit recovery after a crash during temporary-record publication without
recursive deletion. A valid replacement uses a fresh cryptographic UUID, so it cannot be selected
by the captured old basename under the protocol's collision-resistance assumption. Symlinks,
junctions/reparse points, multiple entries, and unstable identity are not eligible.

## Mechanical race proof

Let `L/O` and `L/N` denote the token entries of original owner `O` and replacement `N`.

### Forced replacement precedes old release

`F` unlinks only `L/O` and removes the now-empty old `L`. `N` wins `mkdir(L)`, publishes `L/N`, and
enters. When `O` resumes, `unlink(L/O)` returns `ENOENT`; `O` stops before `rmdir`. `L/N` survives.

### Old release is paused after token unlink

After `O` unlinks `L/O`, old `L` is empty. `N` calls `mkdir(L)`, receives the exists semantic, and
does not overwrite it. `N` may retry only after classification and within the normal bounded
contention policy. Once `O` calls `rmdir(L)`, exactly one later `mkdir(L)` can succeed. Thus there is
no ordering in which `N` replaces an empty directory before `O`'s `rmdir`.

### Replacement exists before a delayed `rmdir`

This can occur when another actor removed the empty old directory and `N` won the following
`mkdir`. `N` publishes its token before it is fully owned. A delayed `rmdir(L)` then encounters a
non-empty directory and fails. It never recurses, so `L/N` survives.

### Owner and recoverer unlink the same token

At most one `unlink(L/O)` succeeds. The loser gets ownership loss and stops before `rmdir`. The
winner can remove only an empty directory; a non-empty replacement is protected.

The proof depends on exclusive non-recursive `mkdir`, unguessable unique tokens, exclusive internal
file creation, non-following validation, and non-recursive `rmdir`. It does not depend on ordinary
directory-rename conflict behavior.

The precise `O`/`F`/`N` state ordering used by the deterministic test is:

| Step | Owner `O` | Forced actor `F` | Replacement `N` | Canonical state |
|---|---|---|---|---|
| R0 | Holds retained token `O` | Idle | Idle | Valid owned `L/O` |
| R1 | Non-following validation proves `L/O`; pauses before exact-token unlink | Idle | Idle | Valid owned `L/O` |
| R2 | Paused | Owns serializer, revalidates and unlinks exactly `L/O`, then empty-only `rmdir(L)` | Idle | Absent |
| R3 | Paused | Leaves serializer | Wins exclusive `mkdir`, publishes and validates `L/N` | Valid owned `L/N` |
| R4 | Attempts exact `unlink(L/O)` | Idle | Holds `N` | Valid owned `L/N` |
| R5 | Gets ownership loss; performs no `rmdir` | Idle | Still holds `N` | Valid owned `L/N` |

If `O` instead wins its token unlink before `F`, `F` observes empty/incomplete or absent state and
cannot remove any replacement token. If `F` and `O` race the same exact token, only one unlink
succeeds; neither ordering permits an unconditional canonical-path deletion.

## State model

The classifier maps platform-specific filesystem results into semantic states. “Valid” always
means one non-link regular token entry with matching schema, owner, and kind.

### Data lock `.lock`

| State | Representation and allowed transition |
|---|---|
| Absent | Acquisition may attempt exclusive `mkdir`; explicit unlock is idempotently absent. |
| Directory claimed, no record | Empty directory after `mkdir`; `LOCK_INCOMPLETE`, fail closed until explicit force recovery. |
| Temporary record present | One `.record-*` entry, including partial or complete content; `LOCK_INCOMPLETE`; explicit force may use observed-singleton cleanup. |
| Valid owned lock | Matching live PID/token; owner may work and conditionally release. Other actors contend. |
| Valid dead-owner lock | Valid token, dead PID; automatic acquisition refuses; ordinary explicit unlock may recover under `.admin.lock`. |
| Corrupt record | Malformed/invalid singleton JSON or schema; non-force refuses; force is operator-quiescent and observed-singleton only. |
| Unexpected entry type | Canonical non-directory, link/reparse point, or non-regular child; fail closed, no automatic deletion. |
| Multiple entries | More than one child of any type; corrupt, no recursive recovery. |
| Releasing | Expected token unlink is in progress; no other entry may be removed. |
| Empty directory awaiting removal | Token unlink succeeded; only non-recursive `rmdir`; contenders see incomplete and do not overwrite. |
| Deletion pending on Windows | Empty removal accepted/delayed or blocked by handles; bounded liveness retry only. |
| Lost ownership | Expected token/path identity no longer matches; stop all removal. |
| Recovery in progress | A verified `.admin.lock.recovering` owner and `.admin.lock` serialize inspection/removal. |
| Recovered | Old token and old empty directory are gone; recoverer reports completion only after cleanup succeeds. |

### Administrative lock `.admin.lock`

| State | Representation and allowed transition |
|---|---|
| Absent | `withAdminLock` may attempt exclusive `mkdir` only if recovery marker policy permits. |
| Directory claimed, no record | Empty directory; incomplete and fail closed; only marker-owned explicit recovery may act. |
| Temporary record present | Partial/unpublished `.record-*`; incomplete; marker-owned force may use observed-singleton cleanup. |
| Valid owned lock | Live verified admin owner; contenders retry/refuse. |
| Valid dead-owner lock | Valid token, dead PID; `unlock-admin` may recover only while owning the marker. |
| Corrupt record | Invalid singleton JSON/schema/kind; non-force refuses; marker-owned force may use observed-singleton cleanup. |
| Unexpected entry type | File/link/reparse/non-regular child; fail closed; legacy regular files follow compatibility rules only. |
| Multiple entries | Corrupt; marker ownership does not authorize recursive deletion. |
| Releasing | Admin owner or marker owner unlinks only the expected token. |
| Empty directory awaiting removal | Only non-recursive `rmdir`; new admin acquisition receives exists and waits/refuses. |
| Deletion pending on Windows | Bounded transient retry; no critical-section entry until absence is observed and own `mkdir` succeeds. |
| Lost ownership | Expected token or directory identity changed; stop cleanup and surface error. |
| Recovery in progress | Caller owns the valid `.admin.lock.recovering` token and is inspecting/removing admin state. |
| Recovered | Prior admin token/directory absent; marker cleanup must still succeed before success is claimed. |

### Recovery marker `.admin.lock.recovering`

| State | Representation and allowed transition |
|---|---|
| Absent | Any recoverer may race exclusive `mkdir`; exactly one namespace claim succeeds. |
| Directory claimed, no record | Empty incomplete marker; force plus quiescence may use empty-only `rmdir`, then all contenders retry `mkdir`. |
| Temporary record present | Partial/unpublished singleton marker; force may use observed-singleton cleanup, never recursion. |
| Valid owned lock | A live marker owner exclusively owns recovery; even `--force` cannot revoke it. |
| Valid dead-owner lock | Force may unlink only its exact token, then empty-only `rmdir`, then contenders retry `mkdir`. |
| Corrupt record | Invalid singleton regular marker; force plus quiescence may use observed-singleton cleanup; never recursion. |
| Unexpected entry type | Link/reparse/file/non-regular child; fail closed and reject automatic recovery. |
| Multiple entries | Corrupt; no child set is treated as ownership and no recursive removal is allowed. |
| Releasing | Marker owner or dead-marker recoverer unlinks only the expected token. |
| Empty directory awaiting removal | Empty-only `rmdir`; no actor may enter recovery yet. |
| Deletion pending on Windows | Retry only bounded transient absence/creation checks; nobody enters without a new verified token. |
| Lost ownership | Expected marker token/path identity changed; actor cannot enter or clean another marker. |
| Recovery in progress | Equivalent to a valid live marker whose exact token was verified immediately before entry. |
| Recovered | Old marker is gone and exactly one contender has acquired/validated a new marker, or no recovery was needed and owned-marker cleanup completed. |

## Explicit unlock and recovery behavior

Ordinary `maswe unlock <run-id>` observes `.lock`, enters `.admin.lock`, and then discards the
pre-lock observation in favor of a fresh non-following classification. A valid dead owner is
recoverable without force by exact-token removal. A valid live owner, corrupt singleton, or
incomplete state is rejected without force. Force may remove a valid live token only after the
operator quiescence confirmation, may empty-remove an incomplete empty directory, and may apply
observed-singleton cleanup to one regular corrupt/temp entry. Unsafe types and multiple entries
remain manual, fail-closed cases.

Ordinary `maswe unlock-admin <run-id>` first owns the recovery marker described below, then freshly
classifies `.admin.lock`. The same live/dead/corrupt/incomplete policy applies, but all removal
occurs while that exact recovery token remains valid. Absence of `.admin.lock` is idempotent only
after marker ownership is established; success is not printed until marker cleanup also succeeds.

Normal acquisition never reclaims dead, corrupt, incomplete, or deletion-pending states. Existing
automatic contention retry for a valid live owner remains bounded and does not mutate the lock.

## Administrative recovery-marker bootstrap

`unlockAdmin` must own and validate `.admin.lock.recovering` before inspecting or removing
`.admin.lock`. There is no recovery lock above it.

1. Actor `A` generates token `A` and attempts exclusive non-recursive `mkdir(markerPath)`.
2. On success, `A` completes the normal internal-record protocol and enters only after verifying
   the public marker contains exactly `A`.
3. On exists, `A` classifies with `lstat`-style, non-following inspection.
4. A valid live marker always yields `ADMIN_RECOVERY_CONCURRENT`, including with `--force`.
5. A valid dead marker requires force. A contender may unlink only the exact dead token it
   observed. Missing token or mismatch is ownership loss; it removes nothing else.
6. An incomplete empty marker requires force and the documented quiescence assertion. Recovery is
   one non-recursive `rmdir(markerPath)`. A single regular temporary or malformed entry may use the
   force-only observed-singleton protocol. Multiple entries, links, reparse points, and unexpected
   types fail closed. No malformed non-empty marker is recursively deleted.
7. After successful dead-token cleanup, successful empty `rmdir`, `ENOENT` caused by a competing
   cleanup, or a Windows deletion-pending transition, every contender returns to a bounded
   acquisition loop and retries exclusive `mkdir`. At most one succeeds. The loop is bounded by
   the existing lock retry budget; retries improve liveness but are not the mutual-exclusion
   mechanism.
8. A loser that observes the winner's valid marker returns `ADMIN_RECOVERY_CONCURRENT`, including
   actual owner PID/token metadata when safe. It never enters merely because it helped remove the
   abandoned marker.
9. On exit, the winner unlinks only `markerPath/A`, then calls non-recursive `rmdir`. Cleanup
   ownership loss or failure is visible and prevents a success claim.

For two actors `A` and `B` recovering dead marker `R`, only one can unlink `R`; both may then join
the `mkdir` retry loop, but only one `mkdir` can claim the absent namespace. For an empty incomplete
marker, only one `rmdir` succeeds, yet both again join the same exclusive `mkdir` race. In both
cases entry requires final validation of one's own UUID, so cleanup victory cannot be confused
with recovery ownership.

The concurrent bootstrap state ordering is:

| Step | Actor `A` | Actor `B` | Recovery marker |
|---|---|---|---|
| A0 | Observes recoverable dead `R` or empty incomplete state; pauses | Observes the same state; pauses | Dead `R` or empty |
| A1 | Races exact-token unlink or empty-only `rmdir` | Races the same conditional cleanup | At most one cleanup operation succeeds |
| A2 | Joins bounded exclusive-`mkdir` retry | Joins bounded exclusive-`mkdir` retry | Absent, empty-awaiting-removal, or deletion-pending |
| A3 | One actor wins `mkdir` and publishes its UUID | Other receives exists and inspects | Winner's valid marker |
| A4 | Winner verifies its UUID and enters | Loser returns `ADMIN_RECOVERY_CONCURRENT` | Exactly one recovery owner |

Crash outcomes are fail-closed:

- crash after marker `mkdir` and before temp creation leaves an incomplete empty marker;
- crash during temp write or after close but before internal rename leaves an incomplete non-empty
  singleton marker; force may remove only that observed regular entry and then use `rmdir`;
- crash after token publication leaves a valid dead marker recoverable token-conditionally;
- crash after admin removal leaves the valid dead marker, making retry idempotently observe absent
  admin state;
- crash after marker-token unlink leaves an empty directory recoverable only by empty `rmdir`.

Multiple-entry and unsafe-type cases require a documented, quiescent manual repair procedure
because no singleton can be selected safely. This safety choice introduces no recursive
recovery-lock hierarchy.

## Path-type and non-following policy

Validation starts with `lstat(lockPath)`, enumerates exactly one directory level, and `lstat`s the
selected child. It never follows a link while validating or removing a lock structure.

| Observed structure | Semantic classification and action |
|---|---|
| Symbolic link at canonical path | `LOCK_UNSAFE_PATH_TYPE`; refuse acquisition/recovery/removal and do not follow or unlink it automatically. |
| Windows junction or reparse point | `LOCK_UNSAFE_PATH_TYPE`; explicitly unsupported and never treated as a lock directory. |
| Regular file where directory is expected | Legacy classifier only if it is a valid PR #10 record; otherwise corrupt/unsafe and fail closed. |
| Directory containing a symlink | `LOCK_UNSAFE_PATH_TYPE`; do not follow or unlink the symlink automatically. |
| Directory containing a junction/reparse child | `LOCK_UNSAFE_PATH_TYPE`; fail closed. |
| Directory containing another unexpected type | `LOCK_CORRUPT`; no automatic cleanup. |
| Multiple entries | `LOCK_CORRUPT`; no entry is assumed authoritative. |
| Token filename differs from JSON owner | `LOCK_CORRUPT`; expected-owner release removes nothing; force may use observed-singleton cleanup under the required serializer. |

On Windows, implementation must use a supported non-following reparse-point check. If Node/libuv
cannot prove that a canonical path and child are ordinary directory/regular-file objects, the
operation is `LOCK_UNSUPPORTED_FILESYSTEM`; it must not approximate by following the path.

## Failure taxonomy and user-visible errors

Errors include run ID, lock kind, canonical path, expected/actual token when safe, semantic state,
and the appropriate recovery command. Platform codes remain causes, not the portable API.

| Category | Required behavior and message intent |
|---|---|
| `LOCK_LIVE_OWNER` | Live data/admin owner blocks non-force recovery; force requires confirmation that no writer is active. |
| `LOCK_DEAD_OWNER` | Automatic acquisition refuses; explicit recovery is available under the required serializer. |
| `LOCK_CORRUPT` | Invalid content, schema, token mismatch, or multiple entries; refuse without force and never recurse. |
| `LOCK_INCOMPLETE` | Empty or temporary-record state; another initializer may exist, so fail closed. |
| `LOCK_UNSAFE_PATH_TYPE` | Link, junction/reparse point, or unexpected object; no link-following or automatic removal. |
| `LOCK_OWNERSHIP_LOST` | Expected token/path identity is absent or changed; replacement was not removed and no further removal occurs. |
| `ADMIN_RECOVERY_CONCURRENT` | Another verified marker owns or won recovery; this actor did not enter. |
| `LOCK_DELETION_PENDING` | Windows or equivalent filesystem deletion is not yet observable as absent; bounded retry exhausted without an ownership conclusion. |
| `LOCK_CLEANUP_FAILED` | State what was removed, what remains, retain the OS cause, and do not claim successful release/recovery. |
| `LOCK_UNSUPPORTED_FILESYSTEM` | A required exclusive, identity, non-following, or empty-only primitive cannot be established; no fallback attempted. |

Dead versus live is a recovery-policy distinction. Corrupt means content cannot establish a token.
Incomplete means publication or cleanup did not reach a valid owned state. Lost ownership means a
caller once had/expected a specific token but the current structure no longer proves it.

## Platform and filesystem semantics

### POSIX and Linux

The required primitives are exclusive non-recursive `mkdir`, exclusive regular-file creation,
internal same-directory file rename to a unique destination, token `unlink`, stable directory
identity, and non-recursive `rmdir`.

Ordinary POSIX `rename()` is deliberately not the lock-directory publication primitive. POSIX
allows an existing empty destination directory to be removed and replaced. Linux
`renameat2(RENAME_NOREPLACE)` supplies no-replace behavior only on Linux and only on supporting
filesystems; the supported Node promise API exposes no flags argument for it.

`mkdir` claims one pathname or reports that it already exists, including when the existing object
is a symlink. `rmdir` removes an empty directory and reports a non-empty semantic as `ENOTEMPTY` or
permitted equivalent `EEXIST`. Error-code spelling is mapped to the semantic categories above.

Supported deployment assumes a local filesystem with coherent same-host namespace operations and
stable object identity. NFS, SMB, FUSE/object-store mounts, and broader distributed-store behavior
are outside Issue #11 unless independently proven to meet every invariant.

### Supported Windows behavior

Windows uses the same `mkdir` namespace claim and token-addressed release, not directory rename.
`MoveFileEx` reports an error when the destination names an existing directory, unlike POSIX's
empty-directory replacement rule; this difference is why rename behavior is not a shared
invariant.

`RemoveDirectoryW` marks a directory for deletion on close; it may remain visible or unavailable
until open handles close. During this deletion-pending interval, a new `mkdir` may fail even though
no owner can safely be identified. Sharing violations, access denial, `EBUSY`, `EPERM`,
`ENOTEMPTY`, or other platform equivalents are mapped by reinspection to one of:

- **contention:** a valid current owner exists;
- **deletion pending/liveness delay:** the old directory is empty/removing and no different token
  is established;
- **ownership failure:** the expected token or stable directory identity changed;
- **cleanup failure:** state cannot be safely classified.

Only deletion-pending/liveness-delay results are retried. The retry count uses the repository's
existing bounded lock-retry budget and bounded delay policy; Phase B must document the exact bound
in code and tests. Exhaustion yields `LOCK_DELETION_PENDING` or `LOCK_CLEANUP_FAILED`, never
success. Correctness does not depend on delay duration or eventual retry. Junctions and all
detectable reparse-point lock paths are explicitly rejected.

### Primitive unavailable

If the implementation cannot establish exclusive `mkdir`, exclusive child creation, stable
directory identity, non-following inspection, unique internal rename, token unlink, or empty-only
directory removal, it fails closed. It must not:

- publish a prepared directory using ordinary rename;
- use `renameat2` only on one platform while silently weakening others;
- recursively remove a public lock or recovery marker;
- read a token and then unlink the canonical path;
- follow a symlink/junction/reparse point;
- move a current owner aside;
- reclaim by age.

## Authoritative semantics and supported property

| Source | Property used by this design |
|---|---|
| [POSIX `rename`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html) | An existing empty destination directory may be removed/replaced; atomic rename therefore is not no-clobber publication. |
| [Linux `renameat2(2)`](https://man7.org/linux/man-pages/man2/rename.2.html) | `RENAME_NOREPLACE` rejects an existing destination, is Linux-specific, and requires filesystem support. |
| [POSIX `mkdir`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html) and [Linux `mkdir(2)`](https://man7.org/linux/man-pages/man2/mkdir.2.html) | Creating an existing pathname fails; Linux `EEXIST` includes an existing symlink. This is the exclusive namespace claim. |
| [POSIX `rmdir`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rmdir.html) and [Linux `rmdir(2)`](https://man7.org/linux/man-pages/man2/rmdir.2.html) | Only an empty directory is removable; non-empty may report `ENOTEMPTY` or `EEXIST`. |
| [Node.js 22.22 `fsPromises.rename`](https://nodejs.org/download/release/v22.22.0/docs/api/fs.html#fspromisesrenameoldpath-newpath) | The supported signature accepts only old and new paths; it exposes no no-replace flag. |
| [Windows `MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw) | Moving a directory is same-drive and an existing destination directory is an error, demonstrating different conflict semantics. |
| [Windows `RemoveDirectoryW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw) | Removal is deletion-on-close; the directory remains pending until its last handle closes, and junction removal has special link semantics. |

If a POSIX page is temporarily unavailable to tooling, the implementation review must still verify
the linked current standard text rather than substituting an old edition.

## Compatibility

PR #10 regular-file locks remain readable but block new `mkdir` acquisition:

- valid live legacy data/admin records retain live-owner rejection;
- valid dead legacy data/admin records retain explicit dead-owner recovery;
- corrupt/incomplete legacy records remain rejected without force;
- legacy recovery occurs only under the new serializer: `.admin.lock` for data and the owned
  recovery marker for admin;
- after the serialized legacy pathname unlink, the actor never unlinks that canonical path again.

This is a compatibility path, not ownership-safe mixed-version operation. A new process never
writes legacy format. Mixed old/new MASWE binaries are unsupported because an old binary can still
perform unconditional pathname deletion. Upgrade and rollback require a quiescent run directory.

The PR #10 empty `.admin.lock.recovering` directory is classified as incomplete. Non-force fails
closed. Force may use only empty `rmdir`, after which all contenders retry exclusive `mkdir`; only
the actor that publishes and validates its new token enters.

Existing CLI names and `--force` flags remain. Force remains an operator assertion that the
apparently live data/admin writer or incomplete initializer is quiescent; it is not process
fencing. A malformed non-empty recovery marker requires manual quiescent repair because automatic
recursive recovery is forbidden.

No durable run schema changes. Rollback requires stopping all processes, using the new binary to
recover new-format paths, confirming all three canonical paths are absent, and only then running
the old binary.

## Deterministic test design

Correctness tests use real Node child processes with explicit IPC and filesystem barriers. Each
worker reports actor, lock kind, UUID, and reached transition. The parent alone releases barriers.
A bounded watchdog may fail a hung test but cannot advance the protocol; arbitrary sleeps are not
the correctness mechanism. Injectable filesystem operations are used only to create platform
semantic states such as deletion pending, never to replace the real multi-process races.

Planned files remain focused:

- `test/fixtures/lock-worker.ts` for acquisition, release, recovery, crash, and barrier modes;
- `test/issue11-lock-recovery.test.ts` for state/path/error/compatibility cases;
- `test/issue11-lock-contention.test.ts` for real-process races and repetitions;
- existing lock/admin tests updated only as required by the new representation.

### Old owner, force, and replacement

1. `O` acquires and holds `L/O`.
2. `O` begins release and pauses before its token unlink.
3. `F` owns the required serializer, unlinks `L/O`, and removes the empty old directory.
4. `N` wins `mkdir(L)`, publishes `L/N`, validates ownership, and pauses.
5. `O` resumes. Its exact `unlink(L/O)` returns absent/mismatch, so it reports
   `LOCK_OWNERSHIP_LOST` and never calls `rmdir`.
6. Assert `N` remains exclusive and releases normally.

A second barrier pauses `O` after successful token unlink but before `rmdir`. `N` receives exists
against the empty directory and cannot overwrite it. After `O` removes it, one bounded retry may
win `mkdir`; a delayed old `rmdir` is injected only after `N` publishes and must fail non-empty.

### Two recovery actors

For both a valid dead marker and an empty incomplete marker:

1. `A` and `B` observe the same recoverable state and pause.
2. Release both cleanup attempts. Exactly one token unlink or empty `rmdir` succeeds.
3. Both actors join the explicit `mkdir` retry barrier.
4. Exactly one reports `RECOVERY_ENTERED` after validating its own marker token.
5. The loser reports `ADMIN_RECOVERY_CONCURRENT`.
6. Keep the winner paused and prove no admin owner or second recoverer enters.
7. Release winner and assert token-conditional cleanup.

### Required acceptance-test matrix

| # | Required case | Deterministic planned evidence |
|---:|---|---|
| 1 | Existing empty lock directory is never overwritten | Precreate empty canonical directory; acquiring child gets `LOCK_INCOMPLETE`; inode/file identity and contents stay unchanged. |
| 2 | Existing incomplete directory remains fail-closed | Precreate partial-temp states for each kind; normal acquisition and non-force recovery do not mutate them. |
| 3 | Acquisition versus old-owner empty-directory release window | Pause `O` after token unlink; `N`'s `mkdir` gets exists and cannot publish until `O`'s `rmdir` barrier completes. |
| 4 | Old owner cannot remove replacement directory | Force removes `O`, `N` fully acquires, then resume `O`; assert ownership loss and surviving `N`. |
| 5 | Two acquirers racing exclusive `mkdir` | Release two child `mkdir` calls from one IPC barrier; exactly one claims, publishes, and enters. |
| 6 | Crash after `mkdir` before record creation | Kill child at `DIRECTORY_CLAIMED`; classify empty incomplete; normal actors fail closed. |
| 7 | Crash while temporary record is partial | Kill child after acknowledged partial write; classify incomplete, not corrupt-owned; no automatic deletion. |
| 8 | Crash after record close before internal rename | Kill at `RECORD_SYNCED`; complete temp remains incomplete; no actor treats it as owned. |
| 9 | Token-entry mismatch | Filename `X`, JSON owner `Y`; corrupt classification; releases for `X` or `Y` remove nothing. |
| 10 | Multiple token entries | Two regular UUID entries; corrupt classification and no child removal. |
| 11 | Symlink lock path | Canonical symlink targets a sentinel; all operations reject and sentinel remains unchanged. |
| 12 | Symlink token entry | Directory contains symlink named as UUID; reject without following or unlinking target. |
| 13 | Windows junction/reparse classification | On Windows create testable junction/reparse fixture; otherwise exercise injected classifier and mark native coverage not run. |
| 14 | Windows deletion-pending/injected equivalent | Hold directory handle on Windows or inject semantic error; bounded retry never becomes success/ownership loss and never recurses. |
| 15 | Two actors recover dead recovery marker | Dead `R` token barrier followed by shared `mkdir` barrier; exactly one enters. |
| 16 | Two actors recover incomplete empty marker | Empty `rmdir` barrier followed by shared `mkdir` barrier; exactly one enters. |
| 17 | Live recovery marker rejected even with force | Keep marker child live; two forced children both get `ADMIN_RECOVERY_CONCURRENT`; marker unchanged. |
| 18 | No recursive deletion anywhere | Instrument removal adapter and scan production call sites; every release/recovery path records only exact `unlink` and non-recursive `rmdir`. |
| 19 | Repeated 25-iteration focused contention | Run real-process acquisition/recovery contention 25 times with fresh paths; record 25/25 and zero dual owners. |
| 20 | Repeated 100-iteration release/replacement | Run the exact old-owner/force/replacement barriers 100 times; record 100/100 replacement survival. |

### Issue #11 acceptance criteria mapping

| Acceptance criterion | Planned tests |
|---|---|
| Reproduce old owner versus forced replacement | Matrix 4 and 20 reach the precise pre-unlink and post-replacement barriers. |
| Earlier owner cannot remove replacement | Matrix 3, 4, and 20 assert token/path survival and no recursive fallback. |
| Reproduce two concurrent forced recoverers | Matrix 15 and 16 cover dead-token and incomplete-empty bootstrap. |
| At most one recovery critical-section owner | Matrix 5, 15, 16, and 17 count verified entries; never infer ownership from cleanup success. |
| Preserve live-owner rejection | Matrix 17 plus live data/admin focused regressions. |
| Preserve dead-owner recovery | Matrix 15 plus child-crash data/admin regressions under the correct serializer. |
| Preserve corrupt/incomplete rejection without force | Matrix 1, 2, 6–10, and 12 cover all publication and validation failures. |
| Ownership loss and cleanup fail closed | Matrix 4, 9, 14, and 18 assert typed errors and no success claim. |
| Platform-safe primitives and path handling | Matrix 1, 3, 5, and 11–14 validate mkdir/no-follow/rmdir semantics. |
| Repeated contention evidence | Matrix 19 and 20 record exact iteration totals at the exact Phase-B head. |
| Documentation and full verification | Documentation matrix and Phase-B verification list below. |

Additional focused regressions cover marker ownership loss, crash after published marker, cleanup
interruption after token unlink, ordinary acquisition/release, explicit dead-owner recovery,
legacy live/dead/corrupt records, existing optimistic concurrency, and preservation of
`AggregateError` when protected work and cleanup both fail. Crash cases 7 and 8 also assert that
force recovers only the observed regular singleton and then wins a fresh exclusive `mkdir`.

## Phase-B baseline and environment record

Before writing a failing test, the implementation agent must establish a clean baseline from the
approved branch using the repository-supported Node environment, preferably Node `22.22.2`. Record
separately:

- host operating system and version;
- filesystem type for the worktree and test temporary directory where available;
- exact `node --version`, `npm --version`, and `git --version`;
- whether nested Git ref writes are permitted, using a disposable nested repository/probe;
- `npm ci` outcome and baseline focused/full test outcomes before Issue #11 changes;
- sandbox, antivirus, mount, credential, or permission restrictions that affect commands.

If the current shell selects unrelated Node 24 or a sandbox denies nested ref writes, report those
results separately, switch to the supported Node when available, and rerun the relevant baseline.
Do not label environment-only failures as Issue #11 regressions, and do not omit them.

## Planned Phase-B changes

The smallest expected production change remains concentrated in `src/store.ts`:

- discriminated non-following state classifier;
- exclusive `mkdir` acquisition and internal record publication;
- exact-token release with non-recursive `rmdir`;
- bounded semantic retry mapping;
- owned recovery-marker bootstrap;
- legacy compatibility under the existing serializers;
- typed failures and deterministic test barriers.

`src/cli.ts` changes only for error/help guidance. No state-machine, runtime adapter, model,
approval, optimistic-concurrency, atomic run/artifact write, scope, or verification behavior
changes. No lock staging directory is introduced, so no new snapshot exclusion is needed.

After reapproval, the Superpowers writing-plans workflow will produce the implementation plan.
Phase B then follows test-driven development: add failing process/barrier tests, implement the
smallest protocol, run focused/repeated tests, update documentation, and perform exact-head
verification. No PR is opened during this design revision.

## Documentation changes after approval

- `docs/SECURITY.md`: forced-recovery threat model, UUID authority, no-follow/no-recursion
  invariants, force/quiescence limitation, mixed-version and filesystem trust boundaries.
- `docs/OPERATIONS.md`: directory states, semantic errors, recovery commands, incomplete and
  malformed singleton and manual unsafe/multiple-entry procedures, Windows deletion-pending
  behavior, retry exhaustion, and rollback.
- `docs/ARCHITECTURE.md`: exclusive `mkdir` claim, internal publication boundary,
  owner-conditional release, and marker bootstrap.
- `docs/adr/0006-ownership-safe-local-lock-directories.md` plus ADR index: decision, platform
  semantics, rejected rename publication, consequences, and compatibility.
- `skills/maswe/references/commands.md` and CLI guidance: live/dead/corrupt/incomplete,
  concurrent-recovery, unsafe-path, ownership-loss, and cleanup-failure messages.
- `CHANGELOG.md`: Issue #11 hardening under the unreleased section.

`docs/PRD.md` requires no scope change; this strengthens NFR-1 and fail-closed behavior.

## Residual risks and operator preconditions

- Force is not process fencing. Before forcing a live data/admin owner or an incomplete initializer,
  the operator must establish quiescence. The protocol prevents delayed cleanup from removing a
  replacement but cannot prevent an unfenced old process from continuing protected writes.
- A stale initializer can briefly create its unique temp entry in a replacement directory if
  force violated quiescence between `mkdir` and temp creation. The mandatory post-create directory
  identity check prevents it from publishing or entering and allows it to remove only its own
  unique temp entry; other actors fail closed during the transient.
- PID reuse/permission can misclassify liveness. PID never authorizes removal.
- Correctness is limited to cooperating new binaries on supported coherent local filesystems.
  Mixed binaries, direct mutation, network mounts, and distributed stores are unsupported.
- Multiple-entry and unsafe-type markers intentionally require manual quiescent repair. A single
  regular corrupt/temp entry is recoverable only by exact observed-singleton cleanup.
- Windows deletion-pending and sharing violations can exhaust bounded retries. The visible cleanup
  error is safer than claiming release.

## Design invariants

1. Only exclusive non-recursive `mkdir` claims a canonical new-format lock namespace.
2. A lock is owned only after one valid UUID entry is fully published and revalidated.
3. The exact retained UUID, not PID/timestamp/path presence, authorizes token removal.
4. Release unlinks only `lockPath/expectedToken`, then uses only non-recursive `rmdir`.
5. Missing/mismatched token or changed directory identity is ownership loss and stops removal.
6. Existing empty/incomplete directories are never overwritten.
7. A replacement's non-empty directory survives every earlier owner's release ordering.
8. A live recovery marker is never revoked, even with force.
9. Cleanup success does not confer recovery ownership; only winning `mkdir` plus token validation
   permits entry.
10. No public lock or marker is recursively deleted or followed through a link/reparse point.
11. Platform errors map to semantic categories; retry affects liveness only.
12. Unsupported primitives and ambiguous states fail closed.
13. Force may select at most one identity-stable regular singleton; it never turns cleanup into
    ownership.

## Approval gate

No production code or tests will be changed until the repository owner explicitly reapproves this
revised design. After reapproval, a detailed implementation plan and failing tests precede
production changes.

`WAITING_FOR_DESIGN_REAPPROVAL`
