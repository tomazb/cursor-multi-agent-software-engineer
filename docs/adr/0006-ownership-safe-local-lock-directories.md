# ADR-0006: Ownership-safe local lock directories

- Status: Accepted
- Date: 2026-07-23

## Context

PR #10 used complete regular-file lock records, but owner release still validated a shared
pathname before unlinking it. Forced removal and replacement could occur between those operations,
allowing a delayed old owner to unlink a replacement. The empty, unowned
`.admin.lock.recovering` directory also allowed two forced actors to confuse cleanup with recovery
ownership.

Ordinary directory `rename()` is not a portable no-clobber publication primitive. POSIX permits
replacement of an existing empty destination directory; Linux `renameat2(RENAME_NOREPLACE)` is
Linux/filesystem-specific and not exposed by the supported Node promise API; Windows conflict
semantics differ.

## Decision

New data, admin, and recovery locks are canonical directories claimed with exclusive
non-recursive `mkdir`. Each contains exactly one finalized UUID-named regular file with format,
PID, owner UUID, timestamp, kind, and recovery metadata.

`mkdir` claims the namespace but does not grant ownership. The claimer captures stable directory
identity, exclusively creates and syncs an internal temporary record, renames it to its unique UUID
name, and then revalidates the unchanged canonical identity and exact sole record. Protected work
begins only after that final validation.

Release uses the retained UUID and directory identity. It validates and unlinks only the exact UUID
entry, then calls non-recursive `rmdir`. Missing/mismatched identity stops before directory removal;
a replacement's non-empty directory survives delayed cleanup.

Administrative recovery uses the same protocol for `.admin.lock.recovering`. Live markers are
never revoked. Forced dead/incomplete cleanup is conditional and does not grant entry; every
contender must subsequently win `mkdir`, publish, and validate a fresh token. There is no higher
or recursive recovery lock.

PR #10 regular-file locks remain readable for quiescent upgrade compatibility, but new code never
writes them. Mixed-version active locking and non-coherent/distributed filesystems are unsupported.

## Consequences

### Positive

- Old-owner cleanup cannot select a replacement owner's different UUID entry.
- Empty-only `rmdir` mechanically preserves non-empty replacements.
- Crash-before-publication is explicit incomplete state rather than false ownership.
- Forced administrative recovery has one validated critical-section owner.
- No recursive public-lock deletion or age-based reclaim is needed.

### Negative

- Locks use a directory plus record instead of one file.
- Interrupted publication and cleanup require explicit recovery.
- Stable identity and non-following primitives are a support boundary; unsupported filesystems
  fail closed.
- Windows deletion-pending states can delay liveness and surface a typed cleanup failure.
- Rollback requires quiescence and removal of version-2 directories with the new binary.

## Rejected alternatives

- Repeated read/compare followed by canonical-path unlink: retains a time-of-check/time-of-use
  window.
- Ordinary directory rename publication: not portable no-clobber.
- Rename-aside recovery: can move a current owner and create a lock-free window.
- Advisory locks/native helpers: Node core has no portable primitive matching the required
  explicit recovery policy; native code is outside Issue #11.
- A higher recovery mutex: recursively reproduces the bootstrap problem.
