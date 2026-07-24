# ADR-0006: Use immutable ticket journals for local lock ownership

- Status: Accepted for Issue #11
- Date: 2026-07-24

## Context

PR #10 represented ownership with a reusable regular-file pathname. A delayed owner could validate
that path, forced recovery could remove it, a replacement could acquire it, and the delayed owner
could then remove the replacement.

The first Issue #11 redesign changed the pathname to a directory created by `mkdir`. Node's
`fsPromises.mkdir` returns no directory handle, however, so a remover can replace the empty
directory before the claimant's first `lstat`. The claimant can capture the replacement identity
as its own. More pathname reads and stress runs cannot supply the missing atomic identity.

## Decision

Each run has permanent `.lock-journal-v3` infrastructure with separate `data`, `admin`, and
`admin-recovery` streams. A stream contains immutable `claims`, immutable `releases`, and
non-authoritative `tmp` records.

Claims receive contiguous fixed-width `BigInt` tickets. Complete canonical JSON is written and
synced to an exclusive temporary regular file, closed, and atomically hard-linked without
clobbering to the deterministic final claim path. The smallest valid unreleased ticket owns.
Ownership checks validate exact paths for every lower ticket and recheck the claimant's own release
state immediately before protected work.

Normal release, queued cancellation, and forced recovery publish the same deterministic release
marker for one exact claim kind, ticket, UUID, and digest. No conforming lifecycle path deletes or
modifies a published claim, published release, successor, or journal directory. Administrative
recoverers use the same ordered protocol; a live recovery claim is never force-released.

PR #10 locks are a read-only virtual ticket-zero overlay bound to exact raw bytes and digest.
Version 3 never deletes or rewrites the legacy pathname.

## Consequences

### Positive

- A late owner or forced actor cannot affect a successor claim.
- Concurrent valid releasers converge on one canonical marker.
- Crash-visible claims remain auditable and explicitly recoverable.
- The protocol uses Node core APIs and adds no native dependency.

### Negative

- Claims and releases grow without bound; compaction is outside Issue #11.
- A dead queued claim eventually blocks and requires explicit recovery.
- Allocation and cold ownership validation are linear in journal history.
- The protocol requires coherent same-host local filesystem and atomic no-clobber hard links.
- Force is not process fencing and depends on correct operator quiescence.
- General Windows support remains unclaimed until exact-head native NTFS validation.

## Rejected alternatives

- **Reusable `mkdir` ownership:** cannot identify the directory created by Node's handle-less
  `mkdir` before a replacement race.
- **More pathname validation or stress:** narrows or samples the race without proving identity.
- **Native advisory locks:** mechanically attractive, but adds native toolchains, binaries,
  platform implementations, packaging, and security-review scope.
- **Implicit Linux-only support:** would change the product support boundary without approval.
- **Weaker identity requirements:** would preserve the replacement-owner deletion defect.

## Support and operations boundary

NFS, SMB, distributed FUSE, object-store mounts, cross-host access, filesystems without hard-link
support, and incoherent caching filesystems are unsupported. Local NTFS is the intended Windows
filesystem, but support is qualified only by native exact-head validation. ReFS, FAT, unsupported
reparse layouts, and network shares fail closed.

Journal infrastructure and final records must not be manually deleted. Upgrade requires all MASWE
processes to stop. Mixed PR #10/v3 operation is unsupported, and rollback after the first v3 claim
requires a separately designed quiescent migration.
