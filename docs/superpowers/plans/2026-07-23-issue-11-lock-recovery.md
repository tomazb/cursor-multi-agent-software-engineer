# Issue #11 Immutable Ticket-Journal Implementation Plan

> **For the implementation agent:** The repository owner approved Phase B v3 with mandatory
> invariants on 2026-07-24. Use the Superpowers test-driven-development,
> systematic-debugging, verification-before-completion, requesting-code-review, and
> finishing-a-development-branch workflows. Do not merge.

**Issue:** #11 — Harden forced lock recovery and ownership-safe release

**Revised design:** `docs/superpowers/specs/2026-07-23-issue-11-lock-recovery-design.md`

**Defective approved design:** `882fc1c63041e946babe3b744285fa6b5b917816`

**Production baseline:** `dab10487baf7f05867b54895ec5db109ad3a3e65`

**Blocked prototype:** `a1ad79bedc8ca2a6a51d3af7597f5eb25c4faa23`

**Status:** `PHASE_B_V3_IMPLEMENTED; EXACT_HEAD_VERIFICATION_PENDING`

**Goal:** Replace reusable-path lock ownership with a version-3 append-only ticket journal whose
immutable no-clobber claims, exact-target releases, monotonic ordering, and self-serializing
administrative-recovery stream prevent a former owner or forced actor from affecting a successor.

**Architecture:** Add one focused journal module behind `FileRunStore`. Permanent per-run streams
for `data`, `admin`, and `admin-recovery` publish complete claim and release records through
temporary files plus exclusive hard links. The smallest valid unreleased ticket owns. Store code
retains existing admin/data ordering, optimistic concurrency, atomic run/artifact writes, and
approval/model/scope/verification behavior.

**Toolchain:** TypeScript ESM, Node.js 22.15+ core APIs, built-in test runner, no new runtime or
native dependency.

**Scope exclusions:** Issues #12, #13, #3, and #5; distributed stores; cross-host locks; automatic
age reclaim; automatic compaction; native addons; automatic merge; unrelated cleanup.

## Phase B authorization and baseline

- [x] Repository owner approved the revised append-only architecture through
      `APPROVED_FOR_PHASE_B_V3_WITH_MANDATORY_INVARIANTS`.
- [x] Approval explicitly accepts the hard-link filesystem boundary, including local NTFS as the
      intended Windows filesystem and fail-closed behavior on unsupported filesystems.
- [x] Redesign commit before finalization:
      `f70ee4de702afc49200c6ba7257b0a0eb6b99455`.
- [x] `origin/main` remains
      `dab10487baf7f05867b54895ec5db109ad3a3e65`; no rebase delta exists.
- [x] Confirm `origin/main` has not materially changed locking, process, filesystem, fingerprint,
      CLI recovery, test, package, or CI behavior.
- [x] Preserved prototype branch remains
      `archive/issue-11-mkdir-prototype-a1ad79b` at
      `a1ad79bedc8ca2a6a51d3af7597f5eb25c4faa23`; no prototype production lifecycle commit will be
      cherry-picked.

The pre-production baseline used Fedora Linux 44, kernel 7.1.3, x86_64, Btrfs for the worktree,
tmpfs for `/tmp`, Node 22.22.2, npm 10.9.7, and Git 2.55.0. Hard links, symlinks, child IPC, and
nested Git refs were available. `npm ci`, typecheck, build, package dry-run, and `git diff --check`
passed. The unchanged baseline full suite reproduced five unrelated failures in
`compat-doctor`, `linked-worktree-compat`, `merge-blockers-round3`,
`ready-review-corrections`, and `store-locking`; these predate v3 production changes and must not
be hidden or attributed to Issue #11. Final verification must report their disposition without
weakening unrelated behavior.

## Implementation evidence before final verification

The implementation followed the approved design without using the blocked v2 lifecycle:

- `6f2c512` finalized the mandatory v3 invariants before production edits.
- `f3b7c5f` added permanent journal initialization and hard-link capability validation.
- `ef18458` added canonical record classification and fail-closed parsing.
- `fdd7eff` added contiguous no-clobber claim publication.
- `172d2d7` integrated exact-range ownership, canonical release, data/admin recovery,
  administrative-recovery ordering, corrupt raw-digest resolution, legacy ticket zero, and store
  call sites.
- `366261f` added real-process crash/race barriers and opt-in 25/100 repetition selection.
- `bb2a7b8` implemented and tested the exact fingerprint exclusion.
- `da396d8` corrected the second-order split-observation case by merging one bounded post-release
  claims observation before exact-target and contiguity validation. Deterministic canonical and
  raw tests cover an unreleased ticket one plus a later released ticket two; the existing real-gap,
  unsafe-path, content-mutation, and pathname-replacement negatives remain fail closed.
- `1cb7e34` extends that bounded merge to every non-empty release observation, including the
  non-snapshot schedule where the first claims observation includes released ticket two but omits
  concurrently published lower ticket one. Canonical and raw known-target regressions cover the
  schedule without an attacker-controlled numeric loop.
- `05d39c8` uses the same single bounded merge when the first claims observation itself contains a
  numeric gap, covering the claims-only schedule where ticket three is observed before an
  already-linked ticket two. The focused regression proves the merged range is contiguous while a
  persistent gap still fails closed.

The implementation uses `src/lock-journal.ts`; it did not cherry-pick the blocked v2 production
lifecycle. `src/cli.ts` changes only user-facing recovery wording. Existing Issue #2 lock tests
were adapted where their reusable-path assumptions were incompatible; optimistic versions, atomic
run/artifact writes, approval/model/scope/verification policy, and state transitions were not
weakened.

## Expected files

### Production

- Add `src/lock-journal.ts`.
- Modify `src/store.ts`.
- Modify `src/git-snapshot.ts` only for the exact v3 synchronization-namespace exclusion.
- Modify `src/cli.ts` only for typed recovery/queue/filesystem guidance required by tests.

### Tests

- Add `test/fixtures/lock-journal-worker.ts`.
- Add `test/issue11-lock-journal.test.ts`.
- Add `test/issue11-lock-contention.test.ts`.
- Update `test/store-locking.test.ts`.
- Update `test/lock-ownership.test.ts`.
- Update `test/lock-barrier.test.ts`.
- Update `test/rc-review-corrections.test.ts`.
- Update `test/readonly-fingerprint.test.ts`.
- Update `test/nongit-fingerprint.test.ts`.

### Documentation

- Update `docs/ARCHITECTURE.md`.
- Update `docs/SECURITY.md`.
- Update `docs/OPERATIONS.md`.
- Replace the prototype ADR with an append-only-journal ADR and update `docs/adr/README.md`.
- Update `skills/maswe/references/commands.md`.
- Update `CHANGELOG.md`.
- Update this implementation plan only with actual evidence/status, not protocol redesign.

`docs/PRD.md` should not require a product-scope edit. If implementation evidence shows otherwise,
stop for design review rather than silently changing the portability or read-only requirements.

## Required implementation invariants

1. A permanent journal directory is never ownership.
2. A temporary file is never a claim or release.
3. A claim/release becomes published only after a complete file is hard-linked to its
   deterministic final pathname and validated there.
4. Claims and releases are never deleted, replaced, renamed aside, or modified.
5. Tickets are fixed-width decimal strings parsed with `BigInt`, contiguous from one, and never
   reused.
6. Enumeration may discover state but never proves a lower ticket absent; ownership validates the
   deterministic exact paths for ticket zero when present and every ticket `1..T`.
7. Only the smallest valid unreleased claim may enter protected work, and the actor rechecks its
   own computed release path immediately before protected entry.
8. Each exact valid claim has one canonical release pathname and canonical byte sequence derived
   from kind, ticket, UUID, and claim digest. Actor/reason/time are non-authoritative evidence.
9. A release targets one exact ticket, UUID, kind, and claim digest.
10. Forced recovery appends the same canonical exact release; it never removes or mutates the
    target claim. Force is operator quiescence, not process fencing.
11. A live `admin-recovery` claim is never force-released.
12. Resolving a predecessor never grants recovery ownership; every actor rescans ticket order.
13. No release/recovery path recursively deletes any lock-related path.
14. Unsupported or ambiguous filesystem/path/record behavior fails closed.
15. The v3 fingerprint exclusion is exact and does not hide `run.json`, artifacts, config, or
    other `.maswe` state.
16. No caller enters protected work before a positive journal ownership proof and immediate own
    release-state revalidation.

## Deterministic worker protocol

The fixture is a real Node child process connected through IPC. The parent sends `START`,
`CONTINUE:<event>`, `CANCEL`, and `EXIT`. A child sends structured messages with:

- actor UUID/name;
- PID;
- lock kind;
- proposed/published ticket;
- owner UUID when safe;
- claim/release digest when safe;
- reached transition;
- final semantic result/error code.

Planned events:

- `TEMP_READY`;
- `CLAIM_PARTIALLY_WRITTEN`;
- `CLAIM_TICKET_PROPOSED`;
- `CLAIM_PREPARED`;
- `CLAIM_LINK_ATTEMPT_READY`;
- `CLAIM_PUBLISHED`;
- `CLAIM_VALIDATED`;
- `TICKET_CONFLICT`;
- `TICKET_RESCAN`;
- `OWNERSHIP_CHECK_READY`;
- `OWNERSHIP_ENTERED`;
- `RELEASE_PREPARED`;
- `RELEASE_LINK_ATTEMPT_READY`;
- `RELEASE_PUBLISHED`;

The parent alone releases barriers. A bounded watchdog only fails a hung test. Timeouts and sleeps
never establish actor order or advance a race.

## Task 1: Re-establish the approved implementation baseline

**Files:** none

- [ ] Fetch remote refs and record current local/remote/design/base SHAs.
- [ ] Confirm a clean worktree and that only the approved redesign commits precede implementation.
- [ ] Inspect every `origin/main` commit after `dab10487...` if the tip moved.
- [ ] Record OS/version, kernel, architecture, Node, npm, Git, worktree filesystem, temporary
      filesystem, hard-link capability, symlink capability, child-process/IPC capability, nested
      Git ref capability, and sandbox restrictions.
- [ ] Prefer the repository-supported Node environment (currently documented as Node 22.22.2 when
      installed); report any other runtime separately.
- [ ] Run the clean baseline:

  ```bash
  npm ci
  npm run typecheck
  npm test
  npm run build
  npm_config_cache=/tmp/maswe-issue11-npm-cache npm run pack:dry
  npm run check
  git diff --check
  ```

- [ ] Classify every failure as product defect, runtime mismatch, sandbox restriction, filesystem
      restriction, Git permission restriction, or unrelated pre-existing failure.
- [ ] Do not modify unrelated behavior to green the baseline.

No commit.

## Task 2: Journal manifest, fixed namespace, and semantic errors

**Files**

- Add `src/lock-journal.ts`.
- Add `test/issue11-lock-journal.test.ts`.

### RED

- [ ] Add failing tests for absent root, safe concurrent initialization, crash before manifest,
      crash after manifest, valid ready-empty layout, missing fixed directory after manifest,
      wrong manifest, unsafe root component, unexpected child type, and hard-link capability
      failure.
- [ ] Add failing tests for semantic error codes:
      `LOCK_LIVE_OWNER`, `LOCK_DEAD_OWNER`, `LOCK_QUEUED`, `LOCK_CORRUPT`,
      `LOCK_INCOMPLETE`, `LOCK_UNSAFE_PATH_TYPE`, `LOCK_OWNERSHIP_LOST`,
      `ADMIN_RECOVERY_CONCURRENT`, `LOCK_CLEANUP_FAILED`,
      `LOCK_UNSUPPORTED_FILESYSTEM`, and `LOCK_TICKET_OVERFLOW`.
- [ ] Run:

  ```bash
  node --experimental-strip-types --test test/issue11-lock-journal.test.ts
  ```

- [ ] Confirm failure is missing journal behavior, not a broken fixture.

### GREEN

- [ ] Implement `LockKind`, paths, manifest schema, semantic error class, platform-code mapping,
      non-following inspection, and idempotent fixed-directory initialization.
- [ ] Use non-recursive `mkdir` for each fixed component; do not treat success as ownership.
- [ ] Publish the manifest through the shared temp/sync/hard-link pattern.
- [ ] Add an initialization-only hard-link capability probe under `tmp/`; clean only exact probe
      temp names.
- [ ] Refuse to recreate missing fixed structures after a valid manifest.
- [ ] Re-run the focused test and adjacent existing store tests.

### Commit

```bash
git add src/lock-journal.ts test/issue11-lock-journal.test.ts
git commit -m "feat: initialize immutable lock journals"
```

## Task 3: Canonical records and fail-closed classifier

**Files**

- Modify `src/lock-journal.ts`.
- Modify `test/issue11-lock-journal.test.ts`.

### RED

- [ ] Add failing cases for valid claim/release records and every malformed field: version,
      record type, kind, ticket, UUID, PID, process identity, timestamp, operation, target mode,
      digest, unknown keys, and newline/canonical encoding.
- [ ] Add malformed fixed-width ticket, duplicate numeric interpretation, ticket gap, wrong JSON
      ticket, overflow, truncated file, digest mutation, wrong release target/digest, missing-claim
      release, alternate release basename, symbolic-link record, directory/device entry, and
      unsafe `tmp/` entry cases.
- [ ] Add shuffled enumeration and assert numeric classification is unchanged.
- [ ] Run the focused test and capture expected classifier failures.

### GREEN

- [ ] Implement explicit canonical serializers with deterministic field order.
- [ ] Compute SHA-256 with the record's digest field omitted.
- [ ] Parse 20-digit tickets with `BigInt`; reserve zero for legacy and reject above the maximum.
- [ ] Require a contiguous `1..highest` claim sequence.
- [ ] Validate deterministic release path and exact claim relationship.
- [ ] Ignore only well-formed ordinary regular files in `tmp/`; reject links/unexpected types.
- [ ] Re-run focused tests.

### Commit

```bash
git add src/lock-journal.ts test/issue11-lock-journal.test.ts
git commit -m "feat: classify immutable lock journal records"
```

## Task 4: Atomic record publication and monotonic ticket allocation

**Files**

- Modify `src/lock-journal.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Add `test/fixtures/lock-journal-worker.ts`.
- Add `test/issue11-lock-contention.test.ts`.

### RED

- [ ] Unit-test temp creation with `wx`, full write, sync/close, read-only mode where supported,
      hard-link publication, final validation, conflict handling, and exact-temp cleanup errors.
- [ ] Inject an ambiguous publication outcome where the final link exists but the call reports an
      error; require exact final-record reconciliation rather than duplicate allocation or false
      absence.
- [ ] Add a two-child barrier:
  1. both validate the same highest ticket;
  2. both propose the same successor;
  3. parent releases both publication calls;
  4. exactly one publishes;
  5. loser rescans and publishes the next ticket.
- [ ] Add a three-child allocator test and assert the final sequence is contiguous independent of
      completion order.
- [ ] Add crash before temp, during temp, after sync, after hard link, and before temp cleanup.
- [ ] Run focused child tests outside any sandbox that intercepts child execution.

### GREEN

- [ ] Implement one publication helper for manifest/claim/release records.
- [ ] Never use ordinary rename, copy, or direct final-path writes as a fallback.
- [ ] Implement scan-highest/propose/link/conflict/rescan allocation.
- [ ] Return a queued-claim handle containing exact kind, ticket, UUID, and digest only after final
      publication validation.
- [ ] Fail closed on unsupported link semantics, incoherent/gapped scans, or overflow.
- [ ] Re-run focused and adjacent tests.

### Commit

```bash
git add src/lock-journal.ts test/issue11-lock-journal.test.ts \
  test/fixtures/lock-journal-worker.ts test/issue11-lock-contention.test.ts
git commit -m "feat: publish monotonic lock tickets"
```

## Task 5: Ownership proof, queueing, and store acquisition

**Files**

- Modify `src/lock-journal.ts`.
- Modify `src/store.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Modify `test/issue11-lock-contention.test.ts`.
- Modify `test/store-locking.test.ts`.
- Modify `test/lock-barrier.test.ts`.

### RED

- [ ] Prove a higher ticket cannot enter while a lower ticket is unreleased.
- [ ] Prove one lower release enables exactly the next ticket.
- [ ] Queue three children and prove protected entry order is numeric.
- [ ] Prove a valid queued claim is not ownership.
- [ ] Crash a queued child and prove it blocks when it becomes earliest.
- [ ] Assert no protected callback/event occurs before `OWNERSHIP_ENTERED`.
- [ ] Add store regressions for normal data/admin acquisition and contention.

### GREEN

- [ ] Implement direct deterministic validation of legacy ticket zero and claims/releases
      `1..ownTicket`.
- [ ] Return ownership only when every lower ticket has an exact valid release and the actor's own
      claim remains valid/unreleased.
- [ ] Implement bounded waiting as liveness only; scans determine correctness.
- [ ] On deliberate wait cancellation, publish the actor's exact queued release before returning.
- [ ] Surface cancellation-release failure; never report clean cancellation with an unresolved
      queued claim.
- [ ] Route data and admin acquisition through journal claims while retaining existing
      `withAdminLock` ordering and retry bounds.
- [ ] Ensure no optimistic version, atomic write, artifact, or state-machine code changes.
- [ ] Re-run focused, store-locking, lock-barrier, optimistic-version, and artifact tests.

### Commit

```bash
git add src/lock-journal.ts src/store.ts test/issue11-lock-journal.test.ts \
  test/issue11-lock-contention.test.ts test/store-locking.test.ts \
  test/lock-barrier.test.ts
git commit -m "feat: acquire locks by immutable ticket order"
```

## Task 6: Exact-target release and failure preservation

**Files**

- Modify `src/lock-journal.ts`.
- Modify `src/store.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Modify `test/issue11-lock-contention.test.ts`.
- Modify `test/lock-ownership.test.ts`.

### RED

- [ ] Test exact kind/ticket/UUID/digest targeting.
- [ ] Test missing/mismatched claim, existing identical canonical release, concurrent publication
      by actors with different audit reasons, wrong-digest release, publication failure,
      validation failure, and temp-cleanup failure.
- [ ] Reproduce:
  1. `O` owns;
  2. forced actor publishes exact release for `O`;
  3. `N` publishes the next ticket and enters;
  4. delayed `O` releases.
- [ ] Assert `O` touches only its own deterministic release pathname and `N` remains owner.
- [ ] Race old normal release and forced release on the same claim; exactly one record publishes,
      both observe safe resolution, and neither affects a later ticket.
- [ ] Test protected-work plus release failure preserves both errors.

### GREEN

- [ ] Implement the one deterministic exact release pathname and canonical byte sequence derived
      from kind, ticket, UUID, and claim digest.
- [ ] Keep actor, reason, command, PID, and timestamp out of ownership-affecting bytes and paths.
- [ ] Treat the same valid exact-target marker as idempotently released regardless of the
      competing actor's non-authoritative audit reason.
- [ ] Never unlink/rename/modify a claim or permanent structure.
- [ ] Retain exact handle fields through every `FileRunStore` release call.
- [ ] Preserve primary and release errors using `AggregateError`.
- [ ] Keep normal data release under admin serialization.
- [ ] Re-run focused and adjacent regressions.

### Commit

```bash
git add src/lock-journal.ts src/store.ts test/issue11-lock-journal.test.ts \
  test/issue11-lock-contention.test.ts test/lock-ownership.test.ts
git commit -m "fix: release only exact immutable lock claims"
```

## Task 7: Explicit data recovery and corrupt exact-digest recovery

**Files**

- Modify `src/lock-journal.ts`.
- Modify `src/store.ts`.
- Modify `src/cli.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Modify `test/lock-ownership.test.ts`.

### RED

- [ ] Test live/dead data claims with and without force.
- [ ] Test non-force corrupt claim refusal.
- [ ] Test force resolving one well-named stable non-link corrupt data claim by raw digest.
- [ ] Test content change, type change, malformed filename, ambiguity, or multiple interpretations
      prevents raw recovery.
- [ ] Pause after raw-release preparation, mutate the exact corrupt target, and prove the
      immediate pre-link stable-handle revalidation prevents release publication.
- [ ] Prove pre-admin observations are discarded and a fresh smallest-unreleased claim is targeted.
- [ ] Prove age never authorizes release.

### GREEN

- [ ] Implement fresh serialized recovery classification.
- [ ] Publish the one canonical exact release marker; record dead/forced reason only in
      non-authoritative evidence.
- [ ] Implement raw-digest target mode only for eligible data/admin regular records.
- [ ] Repeat exact raw bytes/digest validation after release preparation and immediately before
      the hard link, with no intervening await or ownership inference.
- [ ] Require operator quiescence for live force and raw corrupt recovery.
- [ ] Add precise CLI messages without changing command names or force semantics.
- [ ] Re-run focused, CLI, CAS, atomic-write, and artifact tests.

### Commit

```bash
git add src/lock-journal.ts src/store.ts src/cli.ts \
  test/issue11-lock-journal.test.ts test/lock-ownership.test.ts
git commit -m "feat: recover exact data lock tickets"
```

## Task 8: Administrative-recovery journal bootstrap

**Files**

- Modify `src/lock-journal.ts`.
- Modify `src/store.ts`.
- Modify `test/fixtures/lock-journal-worker.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Modify `test/issue11-lock-contention.test.ts`.
- Modify `test/rc-review-corrections.test.ts`.

### RED

- [ ] Two recoverers publish ordered recovery claims; exactly the first enters.
- [ ] Keep the first live and prove force never releases it.
- [ ] Create one dead earliest recovery claim; race two forced contenders publishing its exact
      release; one release wins, all rescan, and exactly the next eligible ticket enters.
- [ ] Crash a queued/owning recovery child and recover it through exact release.
- [ ] Prove cleanup/release success alone never emits `OWNERSHIP_ENTERED`.
- [ ] Prove late previous recoverer release cannot affect a successor.
- [ ] Prove corrupt recovery claim remains fail closed even with force.
- [ ] Prove absent admin state still requires validated recovery ownership before success.

### GREEN

- [ ] Implement recovery claims through the same allocator.
- [ ] Permit bootstrap exact release only for a valid dead earliest recovery claim and only with
      force.
- [ ] Never force-release a valid live or corrupt/ambiguous recovery claim.
- [ ] After resolving a predecessor, rescan full order; do not infer ownership.
- [ ] Cancel losing actor's own queued claim before returning when safely possible.
- [ ] Only an owned recovery claim may freshly classify/release the admin stream.
- [ ] On exit publish only the winner's exact recovery release.
- [ ] Surface admin failure and recovery-release failure together.
- [ ] Re-run focused and all existing admin recovery tests.

### Commit

```bash
git add src/lock-journal.ts src/store.ts test/fixtures/lock-journal-worker.ts \
  test/issue11-lock-journal.test.ts test/issue11-lock-contention.test.ts \
  test/rc-review-corrections.test.ts
git commit -m "feat: serialize recovery with immutable tickets"
```

## Task 9: Legacy virtual ticket zero and migration boundary

**Files**

- Modify `src/lock-journal.ts`.
- Modify `src/store.ts`.
- Modify `src/cli.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Modify `test/lock-ownership.test.ts`.
- Modify `test/rc-review-corrections.test.ts`.

### RED

- [ ] Test absent, valid live, valid dead, corrupt, incomplete, changed-content, link, and
      unexpected-type PR #10 data/admin files.
- [ ] Treat unresolved legacy as ticket zero and prove v3 ticket one cannot enter.
- [ ] Publish an exact legacy-digest release and prove v3 ownership can proceed without deleting
      the legacy path.
- [ ] Change legacy bytes after resolution and prove v3 fails closed.
- [ ] Test the empty legacy recovery marker only under explicit forced upgrade quiescence.
- [ ] Replace that empty marker during release publication and prove the recreated directory
      cannot inherit the old ticket-zero release.
- [ ] Test mixed-version sentinel detection/guidance and unsupported rollback.
- [ ] Prove blocked format-2 prototype directories are not treated as v3.

### GREEN

- [ ] Implement virtual ticket-zero classification and release validation.
- [ ] Bind an empty legacy recovery marker to stable filesystem identity, recheck after
      publication, and fail closed where that identity is unavailable.
- [ ] Never unlink or replace legacy canonical paths in v3 ordinary/recovery code.
- [ ] Preserve live/dead/corrupt non-force policies.
- [ ] Require quiescent upgrade and reject mixed activity.
- [ ] Update CLI migration/rollback guidance.
- [ ] Re-run focused and existing legacy tests.

### Commit

```bash
git add src/lock-journal.ts src/store.ts src/cli.ts \
  test/issue11-lock-journal.test.ts test/lock-ownership.test.ts \
  test/rc-review-corrections.test.ts
git commit -m "feat: overlay legacy locks on ticket zero"
```

## Task 10: Path safety, filesystem boundary, and fingerprint preservation

**Files**

- Modify `src/lock-journal.ts`.
- Modify `src/git-snapshot.ts`.
- Modify `test/issue11-lock-journal.test.ts`.
- Modify `test/readonly-fingerprint.test.ts`.
- Modify `test/nongit-fingerprint.test.ts`.

### RED

- [ ] Test canonical symlink, claim symlink, release symlink, unsafe temp, regular-file directory,
      unexpected entry type, and replaced/missing permanent structure.
- [ ] Test hard-link unsupported, cross-device/injected `EXDEV`, permission, network-warning
      classification, and no fallback.
- [ ] Add native Windows junction/reparse and NTFS hard-link cases when running on Windows;
      otherwise label injected semantics.
- [ ] If Node cannot detect the native junction/reparse fixtures required by the design, fail the
      Windows support gate with `LOCK_UNSUPPORTED_FILESYSTEM`; do not waive the test.
- [ ] Assert lock-journal churn leaves read-only fingerprint unchanged.
- [ ] Assert unexpected or malformed root/kind/record/temp journal entries remain
      fingerprint-visible and fail closed during journal validation.
- [ ] Assert canonical-looking journal paths are excluded only after object-type and canonical
      byte/digest validation; unsafe links and invalid JSON remain fingerprint-visible.
- [ ] Assert non-journal symlinks/directories contribute their type and literal POSIX backslashes
      are not normalized into journal separators.
- [ ] Assert `run.json`, artifact, config, and non-journal `.maswe` mutation still changes the
      fingerprint.
- [ ] Source-audit no deletion of claims/releases/permanent paths and no recursive lock deletion.

### GREEN

- [ ] Implement conservative non-following classification and semantic mapping.
- [ ] Return `LOCK_UNSUPPORTED_FILESYSTEM` rather than rename/copy/direct-write fallback.
- [ ] Exclude only canonical protocol entries beneath exact
      `runs/<run-id>/.lock-journal-v3/` paths; unexpected or malformed journal entries must remain
      fingerprint-visible.
- [ ] Re-run focused fingerprint, read-only, non-Git, and path tests.

### Commit

```bash
git add src/lock-journal.ts src/git-snapshot.ts \
  test/issue11-lock-journal.test.ts test/readonly-fingerprint.test.ts \
  test/nongit-fingerprint.test.ts
git commit -m "test: enforce journal path and fingerprint boundaries"
```

## Task 11: Complete deterministic contention matrix and repetitions

**Files**

- Modify `test/fixtures/lock-journal-worker.ts`.
- Modify `test/issue11-lock-contention.test.ts`.
- Modify `package.json` only if dedicated repeat scripts materially improve reproducibility.

- [ ] Complete all 25 approved deterministic cases listed below.
- [ ] Each iteration uses a fresh run/journal path.
- [ ] Add a selection/count environment variable or test option for reproducible repetition.
- [ ] Run focused allocation contention 25 times, releasing both same-ticket hard-link barriers
      before awaiting either actor's publication result.
- [ ] Run exact old-owner/recovery/successor race 100 times: prepare both exact releases, publish
      recovery first, admit the successor, then resume the delayed old-owner release.
- [ ] Characterize a representative large immutable history and record cold allocation/ownership
      scan duration, filesystem-operation count, and orphan-temp count. Any in-process prefix cache
      is optimization only and must fall back safely to full digest validation.
- [ ] Record exact commands, selections, iteration/pass/fail/flake counts, total durations,
      dual-owner count, successor-damage count, forbidden-deletion count, OS, filesystem, Node,
      npm, and exact head.
- [ ] Any failure is blocking. Preserve first-failure evidence, apply systematic debugging, and
      record disposition; do not hide it behind a later pass.

Suggested commit:

```bash
git add test/fixtures/lock-journal-worker.ts test/issue11-lock-contention.test.ts package.json
git commit -m "test: reproduce immutable ticket races"
```

Omit `package.json` from the commit if unchanged. Do not add dependencies or commit
`package-lock.json`.

## Task 12: Documentation

**Files**

- Modify `docs/ARCHITECTURE.md`.
- Modify `docs/SECURITY.md`.
- Modify `docs/OPERATIONS.md`.
- Add or replace `docs/adr/0006-immutable-local-lock-journals.md`.
- Modify `docs/adr/README.md`.
- Modify `skills/maswe/references/commands.md`.
- Modify `CHANGELOG.md`.

- [ ] Document version-3 layout, initialization, ticket allocation, queued versus owned,
      exact-target release, force semantics, admin-recovery bootstrap, crash/corruption behavior,
      semantic errors, and no-delete/no-recursion rules.
- [ ] Document narrow fingerprint exclusion without weakening authoritative-state checks.
- [ ] Document local-filesystem assumptions, Windows NTFS native versus injected coverage, and
      unsupported ReFS/network filesystems.
- [ ] Document legacy virtual ticket zero, quiescent upgrade, mixed-version prohibition, and
      rollback unsupported after first v3 claim without future maintenance.
- [ ] Document journal growth and explicitly defer compaction.
- [ ] Do not describe the protocol as distributed, leased, process-fencing, crash-proof, or a
      sandbox.
- [ ] Run documentation searches and `git diff --check`.

Commit:

```bash
git add docs/ARCHITECTURE.md docs/SECURITY.md docs/OPERATIONS.md \
  docs/adr/0006-immutable-local-lock-journals.md docs/adr/README.md \
  skills/maswe/references/commands.md CHANGELOG.md
git commit -m "docs: document immutable ticket lock journals"
```

## Task 13: Verification, audit, review, push, and draft PR

- [ ] Read and apply verification-before-completion.
- [ ] From a clean exact-head worktree run:

  ```bash
  npm ci
  node --experimental-strip-types --test test/issue11-lock-journal.test.ts
  node --experimental-strip-types --test test/issue11-lock-contention.test.ts
  MASWE_ISSUE11_ALLOCATION_ITERATIONS=25 \
    node --experimental-strip-types --test \
      --test-name-pattern="allocation contention repetition" \
      test/issue11-lock-contention.test.ts
  MASWE_ISSUE11_RELEASE_ITERATIONS=100 \
    node --experimental-strip-types --test \
      --test-name-pattern="owner recovery successor repetition" \
      test/issue11-lock-contention.test.ts
  npm run typecheck
  npm test
  npm run build
  npm_config_cache=/tmp/maswe-issue11-npm-cache npm run pack:dry
  npm run check
  git diff --check
  git status --short
  ```

- [ ] Run child-process/Git tests in a suitable local environment when the managed sandbox
      intercepts them; report the sandbox failure and unrestricted result separately.
- [ ] Audit production call sites:

  ```bash
  rg -n 'rm\(|unlink\(|rmdir\(|rename\(|link\(|open\(|mkdir\(|recursive:|force:|\.lock-journal-v3|\.admin\.lock|\.lock' src
  ```

- [ ] Confirm:
  - no claim/release/permanent journal deletion;
  - no recursive lock deletion;
  - no rename/copy/direct-final-write publication fallback;
  - no age reclaim;
  - no protected work before ownership validation;
  - exact handle fields reach every release;
  - cleanup errors remain visible;
  - fingerprint exclusion is exact.
- [ ] Inspect base-to-head log/stat/name-status/check and confirm Issues #12, #13, #3, and #5 are
      untouched.
- [ ] Use requesting-code-review. Resolve only blocking Issue #11 findings through TDD and rerun
      exact-head verification after every behavioral change.
- [ ] Push the tracking Issue #11 branch only after verification. Do not force-push after review
      without explicit explanation.
- [ ] Open a draft PR against `main`, title `Harden ownership-safe lock recovery`, with:
  - `Closes #11`;
  - exact implementation base, design, plan, and head SHAs;
  - protocol and safety proof;
  - acceptance matrix;
  - 25/100 evidence;
  - baseline environment/failures;
  - all verification commands;
  - deletion-call-site audit;
  - legacy/migration/growth/support statements;
  - Windows-native versus injected distinction;
  - Issues #12/#13/#3/#5 out-of-scope statement;
  - no-merge authorization statement.
- [ ] Wait for CI associated with the exact PR head and record run/workflow/job/artifact IDs and
      conclusions. Earlier-head CI is not evidence for a later head.
- [ ] Keep the PR draft until independent exact-head validation completes. Do not merge.

## Acceptance criteria and 25-case test matrix

| # | Acceptance behavior | Planned focused test |
|---:|---|---|
| 1 | Two claimants propose the same next ticket | Worker barrier at `CLAIM_TICKET_PROPOSED`. |
| 2 | Exactly one publishes that ticket | Shared hard-link barrier; one deterministic final record. |
| 3 | Loser rescans and publishes next ticket | Conflict child resumes and publishes contiguous successor. |
| 4 | Higher cannot enter before lower release | Higher remains `QUEUED` at explicit ownership barrier. |
| 5 | Lower release enables exactly next owner | Publish exact lower release; count one next entry. |
| 6 | Three queued actors preserve ordering | Three-child ticket and protected-entry sequence assertion. |
| 7 | Crash before claim publication | Kill after temp sync; claims directory unchanged. |
| 8 | Crash after claim publication | Kill after final link; exact dead recovery required. |
| 9 | Crash after release publication | Kill after release link; retry is idempotently complete. |
| 10 | Old owner releases after successor | Force old exact release, successor enters, late old release is harmless. |
| 11 | Forced and old release race | One deterministic release wins; neither affects successor. |
| 12 | Two recover one dead claim | Shared exact-release barrier; one record, safe rescans. |
| 13 | Two queue for admin recovery | Both publish ordered recovery tickets. |
| 14 | Exactly one recovery actor enters | Only smallest unreleased recovery ticket reaches entry. |
| 15 | Live recovery survives force | Forced contender cancels itself and returns concurrent. |
| 16 | Corrupt earlier claim blocks | Later valid claimant cannot enter or skip it. |
| 17 | Wrong release digest does not release | Classifier corrupt; no ownership transition. |
| 18 | Conflicting release records fail closed | Unexpected alternate/wrong deterministic release blocks. |
| 19 | Symlink/unsafe entries fail closed | Non-following canonical/child fixtures survive unchanged. |
| 20 | Temps do not affect order | Partial/complete regular temps ignored; unsafe temps reject. |
| 21 | Overflow fails closed | Maximum fixed-width ticket cannot wrap. |
| 22 | Listing order irrelevant | Shuffled enumeration yields same numeric owner. |
| 23 | 25 allocation-contention repetitions | Required 25/25; zero duplicate tickets/dual owners. |
| 24 | 100 old/recovery/successor repetitions | Required 100/100; zero successor damage. |
| 25 | No lock journal deletion | Source audit plus filesystem-operation spy. |

Issue #11 traceability:

| Issue acceptance criterion | Planned evidence |
|---|---|
| Deterministically reproduce normal-release versus force/replacement | Cases 10, 11, and 24. |
| Original releaser cannot remove replacement | Exact-ticket release proof plus cases 10/24. |
| Reproduce concurrent forced admin recoverers | Cases 12–15. |
| At most one recovery critical-section owner | Monotonic recovery tickets plus cases 13–15. |
| Preserve live/corrupt/incomplete non-force refusal | Journal state tests, cases 15–20, and legacy tests. |
| Preserve explicit dead-owner recovery | Cases 8 and 12 plus data/admin focused recovery. |
| Repeated real-process barriers | Cases 23/24 with exact evidence. |
| Documentation and verification | Tasks 12/13. |

Preserved regressions:

- normal data acquisition and release;
- normal admin acquisition and release;
- normal data/admin unlock;
- dead-owner data/admin recovery;
- non-force live/corrupt/incomplete rejection;
- optimistic version checks;
- atomic run and artifact writes;
- artifact digests and attempts;
- read-only fingerprint behavior;
- CLI behavior;
- PR #10 legacy records;
- all existing package and CI checks.

## Compatibility strategy

- New code writes only v3 journal records.
- PR #10 locks are a virtual ticket zero and are never deleted by v3.
- Existing live/dead/corrupt/incomplete policy is preserved.
- Mixed old/v3 binaries are unsupported.
- Upgrade requires quiescence.
- The blocked format-2 prototype was never released and is not accepted.
- Rollback after first v3 publication requires future quiescent archival tooling and is not
  implemented by Issue #11.

## Windows coverage classification

- Shared design uses Node core hard-link publication.
- Intended native Windows support is local NTFS.
- ReFS, FAT, network shares, and unsupported reparse layouts fail with
  `LOCK_UNSUPPORTED_FILESYSTEM`; there is no weaker fallback.
- Linux-injected platform errors are labeled injected.
- Windows-native behavior is claimed only for an exact-head run on Windows/NTFS.
- A native addon is not introduced.

## Prototype reuse disposition

No prototype production commit is cherry-picked.

- Reimplement classifier/error concepts from `20444fd`; discard format-2 state assumptions.
- Reimplement exact hard-link publication insight from `805cea1`.
- Adapt child IPC/barrier utilities from `d94d491`, `735a2e7`, and `b7cc2ec`.
- Retain `AggregateError` behavior patterns from `36e6550`, but discard its directory lifecycle.
- Rewrite all format-2 documentation from `c7c8325`.
- Carry the `a1ad79b` defect explanation into the revised design.
- Treat all green prototype tests as evidence for the old barriers only, never validation of v3.

## Commit boundaries

1. documentation-only redesign (this approval gate);
2. journal initialization and errors;
3. record classifier;
4. ticket publication/allocation;
5. ownership and acquisition integration;
6. exact-target release;
7. data recovery;
8. administrative-recovery bootstrap;
9. legacy compatibility;
10. path/filesystem/fingerprint boundaries;
11. deterministic/repeated race tests;
12. documentation;
13. focused verification corrections, if any.

Every behavior follows RED → focused expected failure → minimum GREEN → focused pass → adjacent
regressions → cohesive commit. Do not implement the entire protocol before tests.

## Execution gate

Phase B v3 is authorized only after the design and plan finalization commit is created with no
production or test changes. The implementation must then follow each RED/GREEN boundary above.
No merge is authorized.
