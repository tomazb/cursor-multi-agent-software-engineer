# Design: Ownership-Safe Forced Lock Recovery

**Issue:** GitHub #11 — Harden forced lock recovery and ownership-safe release

**Date:** 2026-07-24

**Status:** Approved for Phase B v3 implementation

**Redesign branch:** `issue/11-lock-recovery-redesign`

**Redesign base:** `882fc1c63041e946babe3b744285fa6b5b917816`

**Production baseline:** `dab10487baf7f05867b54895ec5db109ad3a3e65`

**Blocked prototype:** `a1ad79bedc8ca2a6a51d3af7597f5eb25c4faa23`

**Preservation ref:** `archive/issue-11-mkdir-prototype-a1ad79b`

## Decision summary

Replace the defective reusable-directory lock design with an append-only immutable ticket journal
implemented with Node.js core filesystem APIs.

- A permanent per-run journal contains separate `data`, `admin`, and `admin-recovery` streams.
- A claimant publishes a complete immutable claim at the next contiguous numeric ticket.
- Complete records are prepared in `tmp/` and atomically published with a no-clobber hard link.
- The owner is the valid unreleased claim with the smallest ticket for that lock kind.
- For valid claims, normal release, cancellation, and forced recovery publish one immutable
  release record targeting an exact claim ticket, UUID, kind, and digest. They never delete or
  modify the claim. Corrupt-claim recovery uses the separately defined raw-path/digest target.
- The administrative-recovery stream orders recoverers without a recursively higher recovery lock.
- No conforming Issue #11 path deletes a claim, release, permanent journal directory, or reusable
  canonical owner pathname.

This is a local, same-host cooperative lock. It is not distributed, leased, process-fencing,
crash-proof, or an operating-system sandbox.

## Problem and scope

PR #10 writes a complete regular-file record and publishes it to `.lock` or `.admin.lock` with
`link`. Release validates the owner token twice and then removes the shared canonical pathname.
`unlockAdmin --force` may recursively replace `.admin.lock.recovering`. Issue #11 must close two
races:

1. owner `O` validates its reusable pathname; a forced actor removes it; replacement `N` publishes
   at the same pathname; delayed `O` removes `N`;
2. two forced administrative recoverers replace or remove the same recovery marker and overlap.

The redesign changes only local file-store locking and explicit recovery. It does not change
optimistic versions, atomic run/artifact writes, approval gates, model selection, scope policy,
verification policy, runtime adapters, or state-machine transitions. Issues #12, #13, #3, and #5,
distributed stores, remote workers, automatic compaction, and automatic merge remain out of
scope.

## Confirmed architectural defect in the approved design

The design at `882fc1c63041e946babe3b744285fa6b5b917816` required exclusive
`mkdir(lockPath)` followed by capture and later validation of the created directory's stable
identity. That protocol cannot establish its own mandatory invariant through supported portable
Node.js APIs:

1. `fsPromises.mkdir(lockPath, { recursive: false })` fulfills with `undefined`; it returns no file
   or directory handle.
2. The first `lstat(lockPath)` is a separate pathname operation.
3. Between successful `mkdir` and that first `lstat`, another authorized actor can remove the
   empty directory and recreate the same pathname.
4. The claimant can then capture the replacement identity as if it were the directory it created.
5. All later temporary-file publication and final validation can remain internally consistent
   against that replacement.
6. Path-based post-`mkdir` validation therefore cannot prove the identity of the directory created
   by `mkdir`.
7. Stress tests cannot establish the missing atomic property. The decisive replacement can occur
   before the claimant has any observable identity to place behind a test barrier.
8. Node.js core does not expose portable `mkdirat`, `openat`, `linkat`, compare-and-delete,
   create-directory-and-return-handle, advisory-lock, or equivalent APIs that repair this exact
   ownership invariant.
9. Direct use of POSIX or Windows handle-relative primitives requires native code and changes
   portability, installation, packaging, CI, and security-review scope.

Opening the directory after `mkdir`, adding more `lstat` calls, or increasing stress repetitions
does not close the first-identity gap. This is an architectural contradiction, not a missing test
or a small implementation defect. The blocked prototype's green contention runs are evidence
only for barriers after its first identity capture.

## Alternatives evaluated

### A — Append-only immutable ticket journal (selected)

No active owner is represented by a pathname that must later be deleted, replaced, or reused.
Claims and releases are immutable records in a permanent namespace. Exact-target release cannot
alter a successor, and monotonic ticket order provides one owner.

Advantages:

- uses Node.js core `open`, `FileHandle.sync`, `link`, `lstat`, and `readdir`;
- removes canonical compare-and-delete from the safety argument;
- handles normal late release and competing forced recovery with the same exact-target primitive;
- preserves auditable crash and recovery history.

Costs:

- journals grow until a separately designed quiescent maintenance operation is introduced;
- queued processes publish durable claims, so a crashed queued claimant eventually requires
  explicit recovery;
- support is limited to coherent local filesystems with atomic exclusive hard-link publication;
- the read-only fingerprint must narrowly exclude this synchronization namespace, just as it
  excludes the current lock files, without excluding run records or artifacts.

### B — Native advisory-lock implementation (rejected for Issue #11)

A Node-API addon could use POSIX `fcntl`/`flock` and Windows `LockFileEx`, retain an open handle
while owning, and store metadata separately. This is mechanically strong at the OS boundary, but
it introduces:

- `node-gyp` or an equivalent compiler/toolchain at install time;
- per-Node-ABI and per-architecture prebuilt artifacts or a build fallback;
- Linux, macOS, and Windows implementations with materially different lock semantics;
- new npm packaging, signing, provenance, CI, and supply-chain requirements;
- additional crash, handle-inheritance, fork/spawn, antivirus, network-mount, and upgrade cases;
- a security review of native memory and handle lifetime;
- tension with the existing explicit dead-owner recovery policy because OS locks normally vanish
  when the owning handle/process closes.

The native option may be reconsidered in a separately approved portability decision. It is not the
smallest project-fit change for Issue #11.

### C — Platform-specific support tiers (rejected as the primary architecture)

A Linux/POSIX helper could use `openat`, `linkat`, or advisory locks; a Windows helper could use
`CreateFileW`, directory handles, file IDs, and `LockFileEx`. Selecting such a protocol would
silently abandon the PRD's Node 22 portability goal unless the repository owner approved a new
support matrix and native distribution model.

The selected journal is multi-platform at the Node API level but still has an explicit filesystem
capability boundary. Local Windows NTFS is the intended Windows filesystem because Microsoft
documents hard links there. ReFS, FAT, network shares, and any filesystem that rejects or weakens
hard-link publication are unsupported and fail closed. This boundary is part of the approval
decision, not an implicit Linux-only fallback.

### D — Keep `mkdir` identity with more pathname checks (rejected)

The following do not resolve the contradiction:

- treating the first post-`mkdir` `lstat` as the created identity;
- relying on a small scheduling window or many stress-test passes;
- assuming forced recovery cannot overlap acquisition;
- asserting quiescence for ordinary owner release;
- opening the directory by pathname after `mkdir`;
- repeating reads before publication.

All still permit replacement before the first identity-bearing observation.

## Permanent journal namespace

Each run has one versioned permanent synchronization namespace:

```text
.maswe/runs/<run-id>/
├── .lock-journal-v3/
│   ├── format.json
│   ├── data/
│   │   ├── claims/
│   │   ├── releases/
│   │   └── tmp/
│   ├── admin/
│   │   ├── claims/
│   │   ├── releases/
│   │   └── tmp/
│   └── admin-recovery/
│       ├── claims/
│       ├── releases/
│       └── tmp/
├── .lock                         # legacy PR #10 input only
├── .admin.lock                   # legacy PR #10 input only
└── .admin.lock.recovering        # legacy PR #10 input only
```

The three journal kinds are `data`, `admin`, and `admin-recovery`. Their ticket sequences are
independent. New code never writes the three legacy canonical paths.

The journal root, manifest, kind directories, `claims/`, `releases/`, and `tmp/` directories are
permanent protocol structures. Conforming Issue #11 code never removes, renames, replaces, or
recursively deletes them and never uses their object identity as ownership.

### First-use initialization

Initialization is idempotent and is not lock acquisition:

1. Inspect every existing path component without following symbolic links. Reject symbolic links,
   junctions/reparse points detectable through Node, regular files where directories are expected,
   and unexpected object types.
2. Create missing fixed directories one level at a time with non-recursive `mkdir` and mode
   `0o700` where supported. `EEXIST` triggers non-following validation.
3. Prepare the fixed format manifest in a unique regular file with `open("wx", 0o600)`, write its
   canonical bytes, sync, close, and hard-link it to `format.json`.
4. If another initializer published `format.json`, require byte-for-byte equality with the
   supported manifest. A different or malformed manifest is corruption.
5. Before a valid manifest exists, a later initializer may resume creation only when there are no
   published claim or release entries and every existing fixed path is safe.
6. After a valid manifest exists, a missing or replaced fixed directory is corruption; it is not
   recreated automatically.

Concurrent conforming initializers may create the same permanent directories. None acquires a
lock by doing so. The first successful no-clobber manifest publication completes initialization.

The permanent namespace is the reason the prior directory identity race no longer controls
ownership: no authorized ordinary release or recovery operation removes or replaces it.

### Path and fingerprint policy

Every initialization and scan enumerates the journal root and kind-directory levels as well as
`claims/`, `releases/`, and `tmp/`. Only the exact manifest, kind directories, fixed child
directories, canonical records, and well-formed temporary basenames are allowed. A canonical or
unexpected entry that is a symlink, detectable junction/reparse point, or unexpected object type
fails closed; an unexpected ordinary entry is corruption. Final claims and releases must be
non-link regular files. Well-formed regular orphan files are allowed only in `tmp/` and never
affect ticket order.

The MASWE-plane read-only fingerprint excludes only type-validated permanent directories,
the exact valid manifest, canonical digest-validated claims/releases, and well-formed ordinary
temporary files under exact `runs/<run-id>/.lock-journal-v3/` paths as synchronization churn.
Path shape alone never qualifies an entry for exclusion. Unexpected or malformed journal entries
remain fingerprint-visible, including unsafe links, invalid canonical-looking record bytes, and
unexpected root/kind entries. The fingerprint preserves literal POSIX backslashes and hashes the
type of every non-excluded `.maswe` entry. It must continue hashing `run.json`, artifacts, config,
and every other `.maswe` path. Tests must prove that the narrow exclusion prevents valid lock
activity from false-failing a read-only role while mutations to authoritative or unexpected
journal paths still change the fingerprint. This is the journal equivalent of the existing exact
lock-file exclusions, not a general `.maswe` weakening.

## Record encoding

All records use UTF-8 canonical JSON followed by one newline. Canonical serialization has an
explicit field order, no insignificant whitespace, and rejects unknown fields. SHA-256 digests are
lowercase hexadecimal prefixed with `sha256:` and cover the canonical encoding with the record's
own digest field omitted.

Ticket strings are exactly 20 decimal digits and are parsed and compared with `BigInt`, never
JavaScript `number` and never locale or ordinary lexical ordering. Valid claim names and
exact-claim release names are:

```text
claims/<20-digit-ticket>.json
releases/<kind>.<20-digit-ticket>.<owner-uuid>.<claim-digest-hex>.json
releases/<kind>.<20-digit-ticket>.raw.<raw-content-digest-hex>.json
```

Tickets start at `00000000000000000001`. Ticket
`00000000000000000000` is reserved for the legacy compatibility overlay. The maximum is
`99999999999999999999`; attempting to allocate beyond it fails closed with
`LOCK_TICKET_OVERFLOW`.

### Claim record

A format-3 claim contains at least:

```json
{
  "format": 3,
  "record": "claim",
  "kind": "data",
  "ticket": "00000000000000000001",
  "owner": "550e8400-e29b-41d4-a716-446655440000",
  "pid": 12345,
  "process": {
    "startedAt": "2026-07-24T10:00:00.000Z",
    "platformIdentity": null
  },
  "at": "2026-07-24T10:00:01.000Z",
  "operation": "store-write",
  "claimDigest": "sha256:<digest>"
}
```

`owner` is generated with a cryptographically random UUID. `pid` is a positive integer.
`startedAt` and `at` are canonical timestamps. `platformIdentity` may contain a verified
platform-specific process-start identifier when available; otherwise it is `null` and liveness
is conservative. `operation` is a closed enum such as `store-write`, `artifact-write`,
`data-unlock`, `admin-serialize`, or `admin-unlock`. Timestamps never establish ticket order or
automatic expiry.

The filename ticket, JSON ticket, lock kind, UUID, schema, operation, timestamps, and digest must
all validate. A claim file is immutable after publication.

### Release record

A normal release record contains:

```json
{
  "format": 3,
  "record": "release",
  "kind": "data",
  "ticket": "00000000000000000001",
  "owner": "550e8400-e29b-41d4-a716-446655440000",
  "claimDigest": "sha256:<target-claim-digest>",
  "targetMode": "claim",
  "releaseDigest": "sha256:<digest>"
}
```

The ownership-affecting bytes contain only deterministic target semantics. The kind, ticket,
owner UUID, and claim digest determine both the canonical bytes and the single final pathname.
`releaseDigest` is itself deterministically derived from those fields. Normal owner release,
queued cancellation, dead recovery, and forced quiescent recovery therefore converge on the same
marker for one exact claim. Actor, reason, command, PID, and timestamp differences are recorded
only in existing run events or other non-authoritative audit evidence; they never create a second
ownership interpretation.

For a well-named but corrupt regular claim, forced data/admin recovery may publish a
`targetMode: "raw-claim"` release containing the exact claim basename and SHA-256 digest of the
raw observed bytes instead of an owner UUID. It is permitted only after operator quiescence,
stable repeated reads through one non-following regular-file handle, and immediate digest
revalidation. A changed digest invalidates the release. A malformed ticket filename, ambiguous
ticket, link, unexpected type, or corrupt `admin-recovery` claim cannot be force-resolved
automatically.

Publishing a release again is idempotent only when the existing canonical bytes validly target the
same exact claim. A concurrent normal owner and forced recoverer therefore either publishes that
one marker or observes it already published. Any existing wrong-target, wrong-digest,
wrong-pathname, or noncanonical release corrupts the journal and blocks later ownership.

## Atomic publication primitive

Claims, releases, and the manifest use one shared publication helper:

1. Generate an actor UUID and a unique basename under the same kind's `tmp/`.
2. Create the temporary regular file with `open(tempPath, "wx", 0o600)`.
3. Write the entire canonical JSON record.
4. Call `FileHandle.sync()` and close the handle.
5. Make the file read-only (`0o400`) where supported and re-open/read it without following links
   to verify the complete bytes and digest.
6. Call `fsPromises.link(tempPath, deterministicFinalPath)`.
7. On success, validate the final pathname as a non-link regular file with the expected bytes and
   digest. Only then is the record published.
8. After any publication error, including `EEXIST`, inspect the deterministic final pathname.
   If the actor's exact record is present and valid, reconcile the ambiguous result as published.
   If a different valid record is present, follow the ticket/release conflict rules. If the final
   path is absent, propagate the original error. An unsafe or corrupt final path fails closed.
9. Best-effort cleanup may unlink only the actor's exact UUID temporary pathname after proving it
   is the expected regular file. Temporary cleanup failure is surfaced but does not unpublish a
   valid final record.

`link` is the no-clobber publication operation. It makes the already complete file visible at the
final name or fails if the final name exists. Ordinary rename and direct write to a final pathname
are not acceptable fallbacks. A hard link requires source and destination on the same supported
filesystem, which the layout guarantees structurally but the implementation must still probe.

A crash after hard-link publication but before temporary cleanup can leave a second read-only
hard link in `tmp/`. Conforming code never reopens or mutates an existing temporary file and never
uses it for ownership.

## Ticket allocation

For one lock kind:

1. Validate the permanent namespace and manifest.
2. Enumerate all `claims/` entries without relying on enumeration order.
3. Reject malformed names, non-regular entries, unsupported records, duplicate numeric
   interpretations, gaps in `1..highest`, digest failures, and numeric overflow.
4. Determine the highest published ticket numerically; use zero when there are no claims.
5. Propose `highest + 1`.
6. Prepare a complete claim record containing that ticket and a new UUID.
7. Hard-link it to the deterministic final claim pathname.
8. If the final pathname exists, discard no published state, rescan, and retry with the now-next
   ticket.
9. After publication, validate the full journal and the exact new claim before returning a queued
   claim handle.

Published tickets are never deleted or reused.

### Unique ticket publication

For a given ticket there is one deterministic final pathname. Hard-link publication is exclusive:
if one actor creates that directory entry, a second actor cannot replace it and receives a
conflict. Therefore at most one immutable claim record is published for a ticket.

### Monotonic claim order

Inductively, ticket 1 can be published only into its deterministic empty pathname. Ticket `T+1`
is proposed only after a scan validates a contiguous `1..T`. If another actor publishes `T+1`
first, the stale proposer conflicts and rescans. Since conforming code never deletes claims, no
lower vacant ticket can appear after a higher valid ticket. A higher ticket with a gap is
corruption, not a state the allocator repairs.

Directory enumeration order is irrelevant. Numeric parsing and contiguity validation determine
the order. On a filesystem that cannot provide coherent same-host enumeration and exclusive
publication, the journal is unsupported.

## Ownership rule

For a lock kind, the owner is:

> the valid unreleased claim with the smallest ticket among all valid published claims.

A claimant receives a queued-claim handle after publication. It may enter protected work only
after proving:

1. its exact claim is present, valid, immutable, and unreleased;
2. the legacy virtual ticket zero is absent or has an exact valid compatibility release;
3. every smaller numeric ticket exists and has a valid release targeting that exact claim;
4. no corrupt claim, release, filename, path type, version, gap, overflow, or ambiguous state
   affects the order;
5. its ticket is therefore the smallest unreleased claim;
6. under the allocation invariant, no smaller claim can appear later.

Directory enumeration is never proof that a lower ticket is absent. After publishing ticket `T`,
the positive ownership check validates deterministic exact paths for legacy ticket zero when
present and for every ticket `1..T`. Each lower position must contain one valid exact claim and
its one computed canonical release marker; the actor's own exact claim must exist and its computed
release marker must be absent. Missing positions, unexpected release names, corrupt records, or
ambiguous path types fail closed. Enumeration may discover the maximum and unexpected entries,
but exact-range path checks establish eligibility.

A release that appears while checking an earlier ticket can cause only a conservative false wait
when it is missed; it cannot create a second owner. Later claims have larger tickets and cannot
preempt the current owner. Immediately before invoking protected work, the process repeats the
exact check for its own computed release path. If its claim was released, it reports
`LOCK_OWNERSHIP_LOST` and does not enter. This check narrows operator-misuse exposure but does not
turn force into process fencing.

Queued claims are not owners. A contender that stops waiting publishes an exact release for its
own queued claim before reporting cancellation. Cancellation-publication failure is surfaced as
cleanup failure; the caller must not report a clean cancellation while its claim remains
unresolved. A crash while queued leaves a published claim that will block when it becomes the
smallest unreleased ticket until explicit recovery releases that exact claim.

## Normal release and safe late release

An ownership handle retains the exact kind, ticket, UUID, and claim digest. Normal release:

1. validates its immutable claim;
2. prepares a release targeting exactly those retained values;
3. hard-links the release to that ticket's deterministic release pathname;
4. validates the published or existing release;
5. reports success when the one canonical marker is published or already validly present.

Release never unlinks a claim or any canonical owner pathname. A former owner releasing after
forced recovery can only attempt the release slot of its own immutable ticket. It cannot address,
modify, release, or delete a successor ticket. This is the mechanical answer to Issue #11's
old-owner/replacement race.

If protected work and release publication both fail, both failures remain visible through
`AggregateError` or an equivalent typed structure. A release-publication or validation failure is
`LOCK_CLEANUP_FAILED`; success is never reported while cleanup is unresolved.

## Data and administrative serialization

The existing policy relationship is retained:

- data acquisition and explicit data recovery are serialized through an owned `admin` ticket;
- normal data release remains under an owned `admin` ticket so existing barriers are not weakened;
- `unlockAdmin` owns an `admin-recovery` ticket before it resolves an `admin` claim;
- automatic age reclaim remains forbidden for all kinds.

The journal removes deletion races, but retaining these ordering relationships avoids weakening
the established acquisition/recovery barrier. Each serializer is itself acquired only through
the ownership rule above.

## Explicit recovery

### Valid claims

- Valid live data/admin claim without force: `LOCK_LIVE_OWNER`.
- Valid dead data/admin claim: after owning the required serializer, publish the claim's exact
  canonical release marker.
- Valid live data/admin claim with force: require the existing explicit operator-quiescence
  assertion and publish the same exact canonical release marker.
- A valid live `admin-recovery` claim is never force-released.
- PID age is not ownership and no record expires automatically.

Force is an operator assertion, not fencing. An incorrectly forced live data/admin process can
continue executing. Every claimant therefore rechecks its own release marker immediately before
protected entry, but the protocol does not claim it can stop a process after entry. The stronger
administrative-recovery rule remains: a valid live recovery claim is never released under force.

After entering the serializer, recovery discards pre-lock observations, revalidates the complete
journal, and targets the current smallest unreleased claim. Publication success never grants the
recoverer ownership of a different stream.

### Corrupt claims

A corrupt earlier record blocks later ownership. Non-force recovery always refuses. Force may
resolve only a data/admin claim whose fixed-width ticket filename is valid and whose entry is one
stable non-link regular file. The raw release targets that exact filename and raw content digest.
After preparing the raw release, recovery repeats the same non-following stable-handle byte and
digest validation immediately before the hard link. No other awaited operation occurs between
that final validation and the publication attempt. If bytes or type change, recovery fails closed.

Corrupt `admin-recovery` claims, malformed ticket names, multiple interpretations, links,
unexpected types, and ambiguous records are not automatically force-released. Because liveness
cannot be proven, force could revoke a live recovery actor. They require separately designed
quiescent maintenance; recursive deletion is never a fallback.

## Administrative-recovery bootstrap

There is no recursively higher recovery lock. The `admin-recovery` journal bootstraps itself:

1. Each recoverer publishes its own ordered recovery claim.
2. Before testing v3 ownership, a forced recoverer may resolve an abandoned PR #10 empty recovery
   marker as virtual ticket zero only under the explicit upgrade-quiescence precondition. It
   publishes an immutable observation release and does not remove the legacy marker. Every
   contender then rescans; this legacy bootstrap publication is not ownership.
3. It validates all lower recovery claims and releases.
4. If the smallest unreleased recovery claim is valid and live, later contenders publish
   cancellation releases for their own claims and return `ADMIN_RECOVERY_CONCURRENT`, even with
   force.
5. If the smallest claim is valid and dead, non-force refuses. A forced contender may publish one
   exact release for that dead claim without owning recovery. This is bootstrap resolution, not
   critical-section ownership.
6. Multiple contenders may prepare a release for the same dead claim; the deterministic release
   pathname accepts at most one. All contenders then rescan.
7. Tickets remain ordered. Only the smallest valid unreleased recovery claim may pass the
   ownership check and enter.
8. A contender that loses or returns publishes an exact cancellation release for its own claim
   when safe.
9. The winner freshly validates and resolves the current `admin` claim.
10. On exit, the winner publishes a release only for its own recovery ticket.
11. Recovery or release-publication failure prevents a successful recovery result.

Cleanup/release publication never confers recovery ownership. If actor `A` has a lower recovery
ticket than actor `B`, releasing an abandoned predecessor can make `A` eligible but cannot make
`B` eligible while `A` remains unreleased. A late former recoverer can address only its own ticket.

## State model

The structural states below apply independently to `data`, `admin`, and `admin-recovery`.

| State | Classification and behavior |
|---|---|
| Uninitialized | No v3 root. Safe first use may initialize only after legacy/path checks. |
| Initialization in progress | Safe fixed directories exist but no manifest or records. A conforming initializer may resume. |
| Ready empty | Valid manifest and fixed directories; no claims. No owner. |
| Temporary claim | Complete, partial, or orphan regular file only in `tmp/`; not a claim and never ownership. |
| Claim publishing | Final hard-link call is in progress; before success there is no published claim. |
| Queued live claim | Valid unreleased claim is not the smallest; it is not owner. |
| Queued dead claim | Dead queued claim remains ordered and may later require explicit exact recovery. |
| Valid live owner | Smallest unreleased valid claim and live process. Only it may enter. |
| Valid dead owner | Smallest unreleased valid claim with dead process; blocks until explicit recovery. |
| Release preparing | Temporary release only; target remains unreleased. |
| Released | One valid exact release exists; the claim remains immutable history and is skipped. |
| Ownership lost | Claim was released before entry or by authorized force; actor must not enter or affect successors. |
| Corrupt earlier claim | Malformed/digest-mismatched well-named claim affects order; blocks later ownership. |
| Corrupt release | Wrong target/digest/schema, conflicting alternate release, or release for missing claim; blocks. |
| Unsafe path | Link/reparse point, unexpected entry type, replaced permanent structure, or non-following guarantee unavailable; blocks without mutation. |
| Ticket gap/duplicate | Non-contiguous sequence or duplicate numeric interpretation; blocks and is never auto-repaired. |
| Overflow | Highest ticket is maximum or cannot parse safely; allocation fails closed. |
| Recovery in progress | An owned `admin-recovery` claim is resolving the admin stream. |
| Recovered | Exact immutable recovery release published; contenders rescan ticket order. |

Kind-specific meaning:

| Kind | Owner's protected section | Recovery rule |
|---|---|---|
| `data` | One run/artifact mutation guarded by optimistic version checks and atomic writes. | `maswe unlock` owns `admin`, then exact-releases the current data claim. |
| `admin` | Serializes data claim/release and explicit data recovery. | `maswe unlock-admin` owns `admin-recovery`, then exact-releases the current admin claim. |
| `admin-recovery` | Serializes administrative recovery itself. | Dead predecessor may be exact-released during bootstrap with force; live claim is never revoked. |

## Crash behavior

| Crash point | Durable result |
|---|---|
| Before temporary claim creation | No claim and no ordering effect. |
| During temporary claim write | Partial UUID temp only; ignored for order. |
| After temp sync/close before publication | Complete orphan temp only; ignored for order. |
| After claim publication before ownership check | Valid queued claim; if process dies it eventually requires explicit exact recovery. |
| While queued | Published claim remains; later claims cannot skip it when it becomes earliest. |
| While owning | Published dead owner blocks until explicit exact recovery. |
| During release preparation | Temp release only; target remains unreleased. |
| After release publication | Target is durably resolved at the protocol level; retry validates idempotence. |
| During forced recovery preparation | No release until publication; target remains blocking. |
| After recovery release publication | Exact target is resolved; cleanup success does not grant recovery ownership. |
| During initialization before manifest | Safe empty fixed structure may be resumed if no records exist. |
| During initialization after manifest | Valid manifest makes missing/replaced fixed structures corruption. |

`FileHandle.sync()` establishes the repository's record-content durability boundary before
publication. Node does not expose one identical portable directory-metadata durability primitive
on all supported systems. Sudden power loss may therefore yield a missing published directory
entry or filesystem-specific recovery; the next scan fails closed. The design's crash guarantees
cover process interruption and atomic visibility, not arbitrary hardware failure.

## Corruption rules

The classifier never silently skips:

- malformed or non-fixed-width ticket filenames;
- gaps, duplicate numeric interpretations, or overflow;
- filename/JSON ticket mismatch;
- invalid UUID, PID, timestamp, kind, operation, version, or unknown field;
- claim or release digest mismatch;
- multiple or alternate release records for one ticket;
- release targeting a missing claim, wrong UUID, wrong kind, or wrong digest;
- symbolic links, detectable junctions/reparse points, devices, sockets, or directories where
  regular records are required;
- unsupported journal versions;
- truncated or modified immutable records;
- missing/replaced permanent structures after initialization.

Regular well-named `tmp/` files do not affect ownership. A symlink or unexpected type in `tmp/`
does affect safety and fails closed.

## Legacy compatibility and migration

PR #10 regular-file locks remain readable. They are treated as a virtual ticket zero that precedes
all v3 tickets:

- an absent legacy path is resolved;
- a valid live legacy data/admin record preserves live-owner rejection;
- a valid dead legacy record remains explicitly recoverable;
- corrupt/incomplete legacy records remain rejected without force;
- a recovery publication targets the exact legacy kind, canonical pathname class, and raw content
  digest;
- the new binary does not unlink or replace the legacy canonical pathname during ordinary
  operation or recovery.

Leaving the legacy object in place prevents the original compare-and-delete race. Once its exact
digest has a valid ticket-zero release, the v3 binary treats that historical object as resolved.
If the legacy bytes or path type later change, the digest no longer matches and v3 fails closed.
An empty PR #10 `.admin.lock.recovering` marker may be resolved only with force and an explicit
upgrade-quiescence assertion; it is never removed by v3.

Upgrade requires all MASWE processes to stop. The new binary validates legacy state, initializes
v3, and records exact legacy resolutions when authorized. Mixed PR #10 and v3 processes are
unsupported: an old binary does not see v3 claims, and its old release code can mutate legacy
paths.

After the first v3 claim, rollback to PR #10 is unsupported without a separately designed,
fully-quiescent archival/migration operation. Ordinary Issue #11 code never removes the permanent
journal. Operators must not manually delete it merely to run an old binary.

The blocked prototype's format-2 directory locks were never pushed or released. They have no
compatibility contract and are not accepted as v3 input.

## Platform and filesystem support

### Portable Node.js-core properties

- `fsPromises.mkdir(..., { recursive: false })` creates/validates permanent directories but does
  not confer ownership.
- `fsPromises.open(..., "wx")` creates a unique temporary file or fails if it exists.
- `FileHandle.sync()` flushes prepared record content before publication.
- `fsPromises.link(existingPath, newPath)` publishes a complete regular file at a new directory
  entry.
- `lstat`, `FileHandle.stat`, and non-following open flags where available validate entry types.

Node core does not expose `openat`, `mkdirat`, `linkat`, `flock`, `fcntl` record locks,
`LockFileEx`, Windows directory file IDs, or a portable compare-and-delete operation.

### POSIX/Linux/macOS

POSIX `open(O_CREAT|O_EXCL)` provides exclusive temporary creation, and `link` atomically creates a
new directory entry without replacing an existing name. Source and destination must be on the
same filesystem. Linux `openat`/`linkat` could give handle-relative guarantees, but Node core does
not expose them and the selected protocol does not require authorized actors to replace permanent
parents.

Linux Btrfs/tmpfs evidence from the blocked prototype is not proof for v3. Phase B must run new
ticket-journal tests. macOS requires its own exact-head CI or independent validation before native
coverage is claimed.

### Windows

Node translates exclusive regular-file create to Windows create-new semantics. Node's hard-link
API is the shared publication abstraction, but Microsoft documents `CreateHardLinkW` as NTFS-only
and not supported on ReFS. Therefore:

- local NTFS is the intended supported Windows filesystem;
- same-volume hard-link capability is probed during journal initialization;
- ReFS, FAT, unsupported reparse layouts, SMB/network shares, and hard-link failures return
  `LOCK_UNSUPPORTED_FILESYSTEM`;
- Phase B must prove on native Windows that Node's non-following inspection detects the junction
  and reparse fixtures in scope; if that proof fails, Windows support remains blocked rather than
  accepting an undetectable unsafe layout;
- no rename/copy/direct-write fallback is allowed;
- Windows-native support is claimed only after exact-head Windows/NTFS tests run;
- Linux-injected error tests are labeled injected, never Windows-native.

Windows native APIs can open an existing directory with `CreateFileW` plus
`FILE_FLAG_BACKUP_SEMANTICS`, avoid reparse traversal with `FILE_FLAG_OPEN_REPARSE_POINT`, obtain
file IDs, and lock file byte ranges with `LockFileEx`. Those APIs are not exposed by Node's
documented filesystem promises in the required form; using them would select the native-addon
alternative.

### Unsupported deployments

NFS, SMB, distributed FUSE, object-store-backed mounts, cross-host locking, and distributed
workers are unsupported. Node explicitly warns that exclusive-create flags may not work on
network filesystems. The implementation performs a same-directory hard-link capability probe and
fails closed when publication is unavailable, but it cannot prove every mount's coherence through
Node alone. Deployment documentation must require a coherent same-host local filesystem.

## Semantic errors

Stable typed categories include:

| Code | Meaning |
|---|---|
| `LOCK_LIVE_OWNER` | Smallest unreleased data/admin claim is live; non-force refuses. |
| `LOCK_DEAD_OWNER` | Smallest unreleased claim is dead and needs explicit recovery. |
| `LOCK_QUEUED` | Claim is valid but a lower unreleased claim exists; no protected entry. |
| `LOCK_CORRUPT` | Record, order, digest, legacy overlay, or release relationship is ambiguous. |
| `LOCK_INCOMPLETE` | Initialization is safely resumable or only an unpublished temp exists; it is not ownership. |
| `LOCK_UNSAFE_PATH_TYPE` | Link/reparse point or unexpected object type detected. |
| `LOCK_OWNERSHIP_LOST` | Actor's exact claim was released or is no longer eligible before entry/release completion. |
| `ADMIN_RECOVERY_CONCURRENT` | Another live/lower recovery claim owns or precedes this actor. |
| `LOCK_CLEANUP_FAILED` | Exact release or actor-temp cleanup failed; success is not claimed. |
| `LOCK_UNSUPPORTED_FILESYSTEM` | Required coherent no-clobber hard-link or non-following behavior is unavailable. |
| `LOCK_TICKET_OVERFLOW` | Next exact ticket cannot be represented. |

Messages include safe context such as run ID, kind, ticket, expected UUID/digest, observed state,
and recovery command. They retain platform errors as causes without exposing secrets or
unnecessary absolute paths.

## Formal safety arguments

### 1. Unique ticket publication

One fixed final pathname represents each ticket. Atomic no-clobber hard-link publication lets at
most one conforming actor create it. Record validation rejects alternate encodings and duplicate
numeric interpretations.

### 2. Monotonic claim order

An actor proposes only the successor of a validated contiguous prefix. A stale proposal conflicts
at the deterministic path and rescans. Claims are never deleted or reused. Thus a lower claim
cannot appear after a higher valid claim.

### 3. Single owner

For a totally ordered finite set of valid unreleased claims, at most one element has the smallest
ticket. Only that claim can pass the ownership check, so at most one conforming actor enters.

### 4. Safe late release

A release pathname and content target one immutable ticket, UUID, kind, and digest. A former owner
has no operation that addresses a successor claim and no operation that deletes a shared owner
pathname. Its late release therefore cannot affect the successor.

### 5. Safe forced recovery

Forced recovery publishes an immutable exact-target release. It does not delete, replace, or
modify the claim. A digest change or ambiguous target fails closed.

### 6. Recovery serialization

Recovery claims use the same monotonic order. Releasing an abandoned predecessor does not grant
ownership; all actors rescan. Only the earliest unreleased valid recovery claim may enter, and a
live recovery claim is never force-released.

### 7. Crash safety

Incomplete temporary records are outside `claims/` and `releases/` and cannot affect ownership.
A final hard link exposes only a previously completed record. A published dead claim remains in
the order until an exact release is published.

### 8. No canonical compare-and-delete

The safety proof contains no deletion or replacement of a reusable owner pathname. Permanent
journal structures and immutable final records remain in place. Ordinary correctness therefore
does not depend on a portable atomic compare-and-delete primitive.

### Assumptions

- a coherent same-host local filesystem provides atomic exclusive regular-file publication;
- source and final hard links are on the same filesystem;
- conforming v3 processes never remove or replace permanent journal structures or final records;
- upgrade is quiescent and mixed old/new operation does not occur;
- force is operator-authorized quiescence, not process fencing;
- the local OS and user account are trusted; malicious OS-level actors that can arbitrarily mutate
  files during validation are outside the current threat model.

## Deterministic test strategy

Correctness tests use real Node child processes and explicit IPC or filesystem barriers controlled
by the parent. A bounded watchdog may fail a hung test but never advances an actor. Arbitrary
sleeps are not a correctness mechanism.

Useful worker events include `TEMP_PREPARED`, `CLAIM_TICKET_PROPOSED`, `CLAIM_PUBLISH_READY`,
`CLAIM_PUBLISHED`, `CLAIM_VALIDATED`, `QUEUED`, `OWNERSHIP_VALIDATED`,
`RELEASE_PUBLISH_READY`, `RELEASE_PUBLISHED`, `DEAD_CLAIM_OBSERVED`,
`RECOVERY_RELEASE_PUBLISHED`, and `RECOVERY_ENTERED`.

| # | Required case | Deterministic evidence |
|---:|---|---|
| 1 | Two claimants propose the same next ticket | Parent holds both after scan/proposal and verifies identical ticket. |
| 2 | Exactly one publishes that ticket | Parent releases both hard-link calls; one final claim exists and one actor conflicts. |
| 3 | Loser rescans and publishes next ticket | Conflict loser is released to rescan and publishes the contiguous successor. |
| 4 | Higher ticket cannot enter before lower release | Both claims published; higher reports queued until parent permits lower release publication. |
| 5 | Lower release enables exactly next owner | After exact lower release, one next ticket passes ownership and no later ticket does. |
| 6 | Three or more queued actors preserve ordering | Three children enter in numeric ticket order through parent-controlled release gates. |
| 7 | Crash before claim publication | Kill after temp sync; no final claim and no ownership effect. |
| 8 | Crash after claim publication | Kill after final link; dead published claim blocks and is exact-recoverable. |
| 9 | Crash after release publication | Kill after release link; retry validates completed release idempotently. |
| 10 | Old owner releases after successor ownership | Force-release old exact claim, successor enters, old late release cannot affect successor. |
| 11 | Forced recovery and old release race | Both target one release pathname; one publishes, the other observes exact resolution. |
| 12 | Two actors recover one dead claim | Shared release barrier proves one immutable release and safe loser rescan. |
| 13 | Two actors queue for administrative recovery | Both publish ordered recovery claims from explicit barriers. |
| 14 | Exactly one recovery claimant enters | Only smallest unreleased recovery ticket reaches `RECOVERY_ENTERED`. |
| 15 | Live recovery owner survives force | Forced contender cancels its own claim and receives `ADMIN_RECOVERY_CONCURRENT`; live claim unchanged. |
| 16 | Corrupt earlier claim blocks later ownership | Later valid child remains queued/fails closed; corrupt record is not skipped. |
| 17 | Mismatched release digest does not release | Wrong digest makes journal corrupt and no later owner enters. |
| 18 | Duplicate/conflicting release records fail closed | Unexpected alternate release entry or wrong deterministic record blocks. |
| 19 | Symlink/unsafe entries fail closed | Canonical and child link/reparse fixtures are not followed or mutated. |
| 20 | Temporary records do not affect ordering | Partial and complete regular temps remain outside ticket order. |
| 21 | Ticket overflow fails closed | Maximum ticket fixture rejects allocation without wrap or lexical error. |
| 22 | Listing order does not affect owner | Inject/shuffle enumeration results; numeric/direct-path validation selects the same owner. |
| 23 | Focused allocation contention repeated 25 times | Real child process barrier suite records 25/25, zero duplicate tickets and zero dual owners. |
| 24 | Old-owner/recovery/successor repeated 100 times | Exact race records 100/100, zero successor releases or deletions. |
| 25 | No final or journal deletion in production | Source audit and filesystem-operation spy prove no claim/release/permanent-path removal or recursive deletion. |

Additional tests cover concurrent initialization, crash during initialization, manifest mismatch,
kind separation, cancellation while queued, queued-child crash, raw corrupt recovery, malformed
ticket refusal, missing-claim release, legacy virtual ticket zero, live/dead/corrupt legacy policy,
mixed-version rejection, narrow fingerprint exclusion, normal store operations, admin acquisition,
explicit unlock commands, optimistic versions, atomic writes, artifacts, CLI behavior, and
protected-work plus release dual failure.

The required 25- and 100-iteration commands run separately from the ordinary suite and record exact
head, OS, filesystem, Node/npm versions, duration, pass/fail/flake counts, dual-owner count,
successor-damage count, and forbidden-deletion count. Any failure is blocking and retained in the
investigation record.

## Journal growth and maintenance

Ordinary Issue #11 operation never deletes final claims or releases. Each successful lock cycle
normally writes one claim and one release; existing admin serialization can add additional pairs.
A canonical record is expected to be roughly 0.5–1.0 KiB, while common filesystems may allocate a
full block per record. A data mutation that acquires/releases both data and admin tickets may
consume roughly 4–24 KiB depending on serializer use, block size, and orphan temps. Ten thousand
mutations may therefore use tens to a few hundred MiB.

Allocation and cold ownership validation are linear in journal history. Repeated acquisitions can
therefore create quadratic lifetime I/O if no validated immutable prefix is cached. Phase B must
characterize representative large histories, record scan duration and filesystem operations, and
may add an in-process cache only as a performance optimization: every cached item must be keyed by
kind/ticket/digest and a cache miss or process restart must safely fall back to full validation.
No mutable checkpoint may become a safety authority. Orphan temporary hard links also contribute
to growth and must be counted separately.

Compaction, checkpoints, archival, and journal deletion are outside Issue #11. A future operation
must be separately designed, require full quiescence, preserve ticket/release semantics, and never
run as ordinary acquisition or recovery. Operators may monitor size but must not manually prune
individual claims or releases.

## Prototype reuse disposition

No blocked production lifecycle commit is cherry-picked. The archive is evidence.

| Prototype commit | Disposition |
|---|---|
| `2dfdf01` implementation plan | Evidence-only; replace with the v3 journal plan. |
| `20444fd` classifier/errors | Reusable after redesign: schema validation, non-following inspection, and typed-error patterns; format-2 states are incompatible. |
| `36e6550` lifecycle | Incompatible: acquisition/release/admin bootstrap depend on the defective directory identity. Aggregate failure handling is a reusable pattern only. |
| `d94d491` race tests | Reusable after redesign: child IPC structure and parent barriers; directory/token scenarios must be rewritten as ticket races. |
| `c7c8325` documentation | Reusable after redesign for force/no-recursion/operator guidance; all format-2 protocol wording is incompatible. |
| `805cea1` publication fix | Reusable after redesign: the no-clobber hard-link insight directly supports immutable final records; directory lifecycle remains incompatible. |
| `735a2e7` barrier fix | Reusable after redesign: parent-controlled transition gates and no sleep ordering. |
| `b7cc2ec` loser-exit fix | Reusable after redesign in the worker harness after result protocol changes. |
| `a1ad79b` defect record | Reusable substantively and incorporated into this design. |

| Prototype path | Disposition |
|---|---|
| `src/lock-protocol.ts` | Evidence-only as code; classifier/error/publication concepts may be reimplemented, not cherry-picked. |
| `src/store.ts` | Lifecycle changes incompatible; call-site map and `AggregateError` behavior reusable after redesign. |
| `src/cli.ts` | Error-guidance intent reusable after redesign; exact text is format-2-specific. |
| `test/fixtures/lock-worker.ts` | Reusable after redesign with new ticket/release events. |
| `test/issue11-lock-contention.test.ts` | Reusable after redesign for spawn/IPC/watchdog utilities; race cases require replacement. |
| `test/issue11-lock-recovery.test.ts` | Reusable after redesign for unsafe-path/error techniques; format-2 state expectations are incompatible. |
| `test/rc-review-corrections.test.ts` | Reusable after redesign after legacy/admin assertions are adapted. |
| Architecture/security/operations/ADR/commands/changelog edits | Reusable after redesign only as topic checklist; protocol descriptions must be rewritten. |
| Prior implementation plan and design status edit | Replaced by the two redesign documents. |

## Required implementation documentation

During Phase B, implementation updates:

- `docs/ARCHITECTURE.md`: permanent v3 journal, ticket ownership, exact release, serializer flow,
  and fingerprint boundary;
- `docs/SECURITY.md`: cooperative-process assumptions, force not fencing, immutable-record and
  no-delete invariants, path/reparse policy, and local-filesystem boundary;
- `docs/OPERATIONS.md`: queue/dead/corrupt states, explicit recovery, migration, unsupported
  filesystems, growth monitoring, and rollback prohibition;
- a replacement ADR for the append-only journal and rejected native/pathname designs;
- CLI command guidance and `CHANGELOG.md`;
- development/CI guidance for Windows-native versus injected coverage.

## Residual risks

- Force cannot stop an incorrectly judged live data/admin process from continuing protected work.
  Exact release prevents successor deletion but is not fencing.
- PID reuse and permissions can make liveness inconclusive; ambiguity fails closed.
- A dead queued claim can reduce liveness and require explicit recovery.
- Journal corruption deliberately blocks later owners and may require future quiescent maintenance.
- Journal growth and cold-scan cost are unbounded in Issue #11; Phase B must publish measured
  operational evidence rather than claim a scale not tested.
- Node cannot positively prove every mount is coherent or local; unsupported deployments remain an
  operator/environment boundary.
- Windows support requires local NTFS and exact-head native validation. ReFS and network filesystems
  have no weaker fallback.
- A malicious local user or OS-level actor able to rewrite immutable files or replace permanent
  directories is outside the current threat model.

## Authoritative source validation

| Source | Property supported |
|---|---|
| [Node.js 22.22 `fsPromises.mkdir`](https://nodejs.org/download/release/v22.22.0/docs/api/fs.html#fspromisesmkdirpath-options) | Non-recursive success fulfills with `undefined`, not a directory handle; an existing directory rejects when `recursive` is false. |
| [Node.js 22.22 `fsPromises.open`](https://nodejs.org/download/release/v22.22.0/docs/api/fs.html#fspromisesopenpath-flags-mode) | `open` returns a `FileHandle`; this differs from `mkdir` and supports preparing/syncing a complete regular file. |
| [Node.js 22.22 `FileHandle.sync`](https://nodejs.org/download/release/v22.22.0/docs/api/fs.html#filehandlesync) | Requests that file data be flushed; the exact durability is operating-system and device specific. |
| [Node.js 22.22 filesystem flags](https://nodejs.org/download/release/v22.22.0/docs/api/fs.html#file-system-flags) | `wx` fails if the path exists; Node warns exclusive flags may not work on network filesystems and maps create-exclusive semantics on Windows. |
| [Node.js 22.22 `fsPromises.link`](https://nodejs.org/download/release/v22.22.0/docs/api/fs.html#fspromiseslinkexistingpath-newpath) | Node exposes path-based creation of a new hard link and fulfills with `undefined`; it exposes no `linkat` directory-handle parameters. |
| [POSIX `open`/`openat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html) | `O_CREAT\|O_EXCL` fails when the name exists; `openat` binds relative resolution to an existing directory descriptor and avoids pathname-parent races at the native API level. |
| [POSIX `link`/`linkat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/link.html) | `link` atomically creates a new directory entry and creates none on failure; `linkat` offers descriptor-relative resolution in native APIs. |
| [POSIX `mkdir`/`mkdirat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/mkdir.html) | `mkdir` creates an empty directory; `mkdirat` is descriptor-relative. Node exposes the former behavior but not the latter signature. |
| [Linux `link(2)`](https://man7.org/linux/man-pages/man2/link.2.html) | Existing `newpath` is not overwritten, `EEXIST` reports conflict, hard links cannot cross filesystems, and unsupported filesystems may return `EPERM`. |
| [Windows `CreateHardLinkW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw) | Windows hard links are file-only, same-volume, documented as NTFS-only, and not supported on ReFS; this defines the Windows filesystem boundary. |
| [Windows `CreateFileW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) | Native Windows can return file handles, uses `CREATE_NEW` for no-clobber file create, needs `FILE_FLAG_BACKUP_SEMANTICS` for directory handles, and offers `FILE_FLAG_OPEN_REPARSE_POINT`; these are native APIs, not equivalent Node promise signatures. |
| [Windows directory handles](https://learn.microsoft.com/en-us/windows/win32/fileio/obtaining-a-handle-to-a-directory) | `CreateFile` with backup semantics obtains an existing directory handle for native implementations. |
| [Windows file identity](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/ns-fileapi-by_handle_file_information) | Native handle APIs can obtain file identifiers, including a 128-bit ID through `GetFileInformationByHandleEx`; Node core does not expose this contract directly. |
| [Windows `LockFileEx`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex) | Native Windows supports exclusive/shared byte-range locks tied to a file handle and releases them after handle close/process termination; selecting it requires native bindings. |
| [Linux `flock(2)`](https://man7.org/linux/man-pages/man2/flock.2.html) | Linux offers descriptor-associated advisory locks released on final close, with network-filesystem semantic differences; Node core does not expose `flock`. |

The absence conclusion is about the documented Node.js 22 core API surface, not about what POSIX
or Windows kernels can do through native code.

## Approval

The repository owner recorded `APPROVED_FOR_PHASE_B_V3_WITH_MANDATORY_INVARIANTS` on Issue #11 on
2026-07-24. This revision incorporates the mandatory exact-range, immutable-publication,
single-release-identity, permanent-infrastructure, force-boundary, contiguous-ticket, temporary
record, and legacy-ticket-zero invariants. Phase B may proceed from this tracked revision without
resuming any blocked v2 lifecycle code.
