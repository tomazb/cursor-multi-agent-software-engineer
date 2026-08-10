# Security architecture and threat model

## Security objective

MASWE must prevent untrusted requests, model output, repository content, and PR comments from crossing approval, permission, model, shell, or merge boundaries without deterministic authorization.

## Assets

- Source code and repository history.
- Credentials for Cursor, GitHub, package registries, cloud providers, and CI.
- Approved product requirements and architecture.
- Model configuration and team policy.
- Run artifacts and reviewer comments.
- Verification and merge-readiness evidence.
- Cost and quota associated with model usage.

## Trust assumptions

- Project configuration and quality commands are controlled by trusted maintainers.
- The local operating system and current user account are trusted.
- Cursor CLI/SDK and model providers are external trusted dependencies, but their output is untrusted.
- Feature requests, repository text, dependency code, and PR comments may be malicious.
- A model may misunderstand policy, hallucinate evidence, or follow prompt injection.

## Threats and controls

### T1 — Prompt injection from repository content

**Threat:** A source file or documentation tells an agent to ignore the approved task, reveal secrets, or perform unrelated actions.

**Controls:**

- System-level role prompts restate scope and permissions.
- Deterministic state and quality logic do not accept model-generated commands or transitions.
- Human approvals are outside the model.
- Verifier and comment classifier receive explicit untrusted-input warnings.

**Gap:** Prompt-level controls cannot fully neutralize injection. Future sandbox and tool policy should restrict file and network access per role.

### T2 — Read-only role modifies code

**Threat:** Brainstormer, designer, verifier, or classifier writes files or stages changes, including authoritative `.maswe` run state or artifacts hidden by Git excludes.

**Controls:**

- Cursor CLI omits `--force` for read-only roles.
- All read-only adapters compare a workspace fingerprint before and after execution.
- In Git checkouts the fingerprint covers git status, unstaged/staged diffs, and untracked content, with `.maswe/` excluded from those Git-plane probes via explicit pathspecs (independent of `.git/info/exclude`).
- In both Git and non-Git working directories the fingerprint also covers authoritative `.maswe` state under `cwd` (project config, `runs/*/run.json`, durable artifacts) via the MASWE-plane hashing contract.
- A mismatch fails the run.

**Gap:** Detection occurs after the process runs; it is a mutation detector, not a preventive
OS-level sandbox. External side effects outside the fingerprinted working directory are not
covered. Ephemeral legacy locks, ordinary `*.tmp` staging files, and canonical synchronization
entries beneath exact `runs/<run-id>/.lock-journal-v3/` paths are intentionally excluded from the
fingerprint. Unexpected or malformed journal entries remain fingerprint-visible and fail journal
validation; the exclusion does not apply to similarly named paths elsewhere under `.maswe`.
Non-Git directories do not fingerprint ordinary files outside `.maswe` (there is no Git status/diff
plane); workspace identity fields still use the `not-a-git-repository` sentinel separately from
the digest fingerprint.

### T3 — Builder or resolver exceeds scope

**Threat:** A write role refactors unrelated code, changes APIs, or follows a reviewer request that broadens requirements.

**Controls:**

- Builder receives approved artifacts and explicit non-goals.
- PR comments require a read-only scope classification before resolution.
- Out-of-scope comments stop for a human.
- Deterministic quality and fresh independent verification follow edits.

**Gap:** v0.2 isolates builders in a dedicated worktree and rejects commits outside `policy.allowedPathGlobs`. Fine-grained path policy derived from design artifacts remains future work.

### T4 — Self-verification

**Threat:** The builder asserts success and the system accepts it.

**Controls:**

- Builder report is explicitly untrusted.
- A separate verifier role runs after deterministic quality checks.
- Resolver edits trigger a fresh verifier.
- Verifier is read-only and must emit a strict verdict.

### T5 — Model substitution or fallback

**Threat:** Runtime silently uses a cheaper, blocked, or less capable model.

**Controls:**

- Requested model is stored in configuration and event details.
- Default policy does not attempt configured fallbacks.
- Reported actual-model mismatch fails the run.
- Doctor checks available model catalogue with fail-closed structured row parsing. Empty or unparseable catalogues are failures. Logical names resolve only for new runs; existing runs validate persisted exact IDs without substitution.

**Gap:** Not every runtime reports actual model identity. Provider-side substitution may remain opaque.

### T6 — Shell injection

**Threat:** Issue text or a PR comment becomes a shell command.

**Controls:**

- Quality commands come only from trusted JSON configuration.
- Request and comment content is passed only as prompt text.
- Runtime command and model values are argument arrays rather than shell interpolation.

**Risk:** Quality commands execute with `shell: true`; malicious configuration is equivalent to local code execution. Protect config review and branch permissions.

### T7 — Secret leakage

**Threat:** Agents read `.env`, credentials, or CI secrets and include them in prompts, artifacts, or logs.

**Controls:**

- Credentials come from environment variables.
- `.env*` is ignored except the example file.
- SDK API key is passed through process environment/options, not persisted in run config.
- Persisted workspace `remote` provenance is sanitized at capture time: HTTP(S)/`ssh://` userinfo is stripped; malformed credential-like remotes are omitted rather than stored raw.
- Raw Cursor CLI stderr is transient process-adapter data. Non-zero exits return only a structured
  failure code, process metadata, and a normalized/redacted/bounded operator diagnostic. Runtime
  metadata records `stderrPresent` rather than stderr content.
- Failure diagnostics normalize unsafe controls, redact, and then truncate. Individual diagnostics
  are at most 2,048 Unicode code points and all-model aggregates at most 8,192, including the
  `… [truncated]` marker.
- Diagnostic work is bounded before redaction. The sanitizer accepts at most the requested output
  budget plus 4,096 Unicode code points of lookahead, with an absolute 12,288-code-point inspection
  ceiling. The ordinary 2,048-code-point diagnostic therefore inspects at most 6,144 code points;
  the 8,192-code-point aggregate inspects at most 12,288. Long assignments and incomplete private
  key blocks are treated as secret through the accepted-window boundary, so truncation cannot
  expose a recognized secret prefix.
- The orchestrator and file store re-sanitize failure messages, `FAIL.details.reason`, and retry
  `previousFailure.message` before persistence. They also reconstruct the allowlisted durable
  runtime-attempt subset rather than serializing arbitrary adapter metadata. CLI status rendering
  applies the same focused safeguard. `FAIL` and retry event paths remove the raw runtime object
  before cloning other details, then sanitize only the first eight runtime attempt slots.
- Durable runtime failure state stores at most eight attempts. Attempt messages are capped at 512
  Unicode code points and model display fields at 256. Total and omitted attempt counts, aggregate
  truncation, stable code, exit/timeout/duration/transport fields, stderr presence, and truncation
  are retained where applicable. Re-sanitizing a loaded or tampered record inspects only its first
  eight raw attempt slots; invalid entries are discarded rather than triggering an unbounded search
  for later valid-looking data.
- Model identifiers used for execution remain unchanged. Their diagnostic display copies are
  separately redacted, capped, collapsed to one line, and stripped of aggregate framing
  delimiters before formatting or persistence.
- Successful runtime-backed workflow events apply that same 256-code-point model-display policy to
  `requestedModel` and `actualModel`. Optional `agentId` and `runtimeRunId` values use a separately
  named 256-code-point identifier-display policy at the same persistence boundary. These display
  copies do not alter runtime invocation, exact-model comparison, catalogue selection, or fallback
  ordering.
- The JSON Schema closes the nested durable runtime attempt and summary allowlists with
  `additionalProperties: false`. Historical schema-version-1 parent objects remain open where
  required for compatibility, and failures without runtime metadata remain valid.
- MASWE has no raw provider-debug artifact or log channel. It does not persist an encrypted copy or
  any digest or hash of raw stderr.
- Cursor CLI failure adapters sanitize the bounded stderr window before trimming or composing
  summaries; catalogue and doctor diagnostics use the same ordering.
- Documentation instructs teams not to commit run artifacts by default.
- The normal constrained-heap regression uses an 8,000,000-character one-byte input, a 48 MiB V8
  old-space limit, and an exact 128-code-point output assertion. It guards against sanitizer
  overhead proportional to every input code point; it is not an absolute bound on total process
  memory or the input representation itself.

**Gaps and future work:**

- Automatic secret redaction covers tested classic GitHub tokens, modern `github_pat_` fine-grained
  PAT shapes, OpenAI/Slack tokens, authorization and standalone bearer forms, URI userinfo, common
  API-key/token/AWS-secret assignments, private-key blocks, and sensitive query parameters.
  URI-userinfo recognition requires an explicit `http`, `https`, `ssh`, `git`, `git+https`,
  `git+ssh`, `sftp`, or `ftp` `scheme://` prefix; it redacts username-only and username/password
  forms while preserving the remaining URI. If a supported URI authority reaches a truncated
  inspection-window boundary before `@` or another authority delimiter, the incomplete authority
  is redacted fail-closed. SCP-like `user@host:path`, ordinary email, arbitrary schemes, and
  percent-decoded semantic interpretation are intentionally not inferred.
- The accepted grammar is deliberately narrow: classic GitHub prefixes and `github_pat_` require at
  least 20 token characters; authorization forms require an `Authorization: Bearer|Basic` header
  or standalone `Bearer`; assignment keys are ASCII identifier names ending in a tested
  API-key/token/secret/signature/AWS-secret suffix followed by `:` or `=` and a quoted or
  delimiter-terminated value (quoted values honor odd/even backslash escaping before a quote, and
  one JSON-encoded structural-quote layer is recognized); sensitive query values require a tested
  `?`/`&` parameter name; and private-key blocks require a `BEGIN … PRIVATE KEY` marker (an absent
  end marker redacts through the accepted window). The fixed-token-prefix scanner consumes only
  each prefix's documented ASCII token alphabet and redacts fail-closed if that candidate reaches
  the truncated accepted-window end, even before the complete-token minimum is observable.
- The fixed-token-prefix, assignment, URI-authority, and private-key scanners advance
  monotonically. The URI scanner records the last `@` during its forward authority pass; it does
  not search the already-consumed prefix again for each URI. That property also keeps the separate,
  potentially larger successful-artifact `redactSecrets()` path linear in the accepted text.
  Remaining regular expressions use non-overlapping grammars and failure diagnostics run them only
  on the bounded diagnostic window; none contains the former nested ambiguous provider-prefix
  repetition. Benchmarks guard scaling, but are supporting evidence rather than a formal
  complexity proof.
- Recognition remains pattern-based, best-effort protection, not a DLP product or a guarantee that
  arbitrary credentials can be recognized.
- Diagnostic framing replaces C0/C1 controls, Unicode line/paragraph separators, bidi overrides,
  and bidi isolates; CR/LF normalization and tab/newline preservation otherwise remain as
  documented.
- Default Cursor CLI prompt transport is stdin; argv remains available via `policy.promptTransport`.
- No provider-specific privacy controls beyond local redaction.

Authentication-like stderr prose remains visible only after sanitization under the structured
non-zero classification. It does not drive control flow because Cursor CLI does not expose a typed
authentication field.

### T8 — Artifact tampering

**Threat:** A user or process changes a design or verification report after approval.

**Controls:**

- Artifacts have SHA-256 digests in the run record.

**Gap:** Digests are revalidated on every read in v0.2 but are not cryptographically signed. Future versions should bind approvals to artifact digests with signatures where needed.

### T9 — Verification on stale code

**Threat:** New commits are added after verifier pass, but old evidence is treated as current.

**Controls:**

- Local read-only checks cover the workspace during the verifier execution.
- Quality, verification, and merge-ready evidence records bind to the evaluated git **head SHA**.
- Head-SHA movement after a successful stage invalidates stale evidence before merge-ready.

**Gap:** Digests and evidence are not yet cryptographically signed. Phase A mirrors SHA-bound evidence into GitHub Checks; Phase B still owns push/PR writes and comment replies.

### T10 — Webhook replay or forged GitHub event

**Threat:** An attacker replays or forges a GitHub webhook delivery.

**Controls (Phase A):**

- Verify `X-Hub-Signature-256` against the raw body (timing-safe); reject without state change.
- After exact-byte HMAC and strict UTF-8/JSON normalization, persist a lease-fenced normalized
  envelope under an immutable per-delivery journal. Completed duplicates return 200 without
  repeating side effects, queued/processing duplicates return 202, and same-ID digest conflicts
  return 409. Unsupported events are durably completed and acknowledged 200.
- Persist only the normalized event, event name, delivery ID, receive time, raw-body SHA-256, and
  operational lease fields. Raw payloads, signatures, headers, tokens, secrets, keys, and arbitrary
  exception text are excluded.
- Acquire installation-scoped tokens only for the handling installation; tokens are not persisted.
- Idempotency keys for check-run side effects under `.maswe/github/side-effects/`.
- Repository allowlist; installation removal suspends associations.
- Generic HTTP 500 responses contain no internal error text; internal failures go only to the local
  diagnostic callback. Every production GitHub HTTP request has a 30-second default deadline.
- Full-digest `external_id` values bind repository, PR, head SHA, check name, and attempt; bounded
  paginated reconciliation searches all advertised check pages before a replacement create.
- Startup migrates legacy delivery artifacts into hash-addressed retained evidence and recovers
  pending queue state before the listener accepts traffic. Active tombstones/journals are not
  silently pruned because removing replay evidence could re-enable a signed delivery.

**Boundary:** Phase A supports one listener/worker plus simultaneous manual publishers using
cooperative same-host locking on one coherent local filesystem with atomic no-clobber hard links.
Quiescent retained-path migration is required from legacy state; multiple listeners, mixed old/new
binaries, and network/distributed filesystems are unsupported. Digest-bound GitHub approval
authorization by repository role/team remains Phase B.

### T11 — Resource and cost exhaustion

**Threat:** A loop or malicious comment triggers repeated expensive model calls.

**Controls:**

- Build/verify and comment-resolution cycles are bounded.
- Automatic loop has a hard transition limit.
- Fallback models are disabled by default.

**Future controls:** per-run token, time, and monetary budgets; concurrency quotas; organization-level kill switch.

### T12 — Lock recovery releases a replacement owner

**Threat:** A delayed owner or forced recoverer validates a reusable lock pathname, another process
replaces it, and the delayed actor removes the replacement. Concurrent administrative recoverers
could similarly overlap.

**Controls:**

- Version-3 ownership is an immutable claim in a permanent append-only journal, never a reusable
  pathname or directory identity.
- Claims and releases are complete, canonical, digest-validated regular files published with an
  atomic no-clobber hard link.
- The owner is the smallest valid unreleased contiguous ticket; every claimant validates exact
  lower paths and its own release state immediately before protected work.
- Normal release and force publish one canonical marker for an exact claim identity. They never
  delete claims, releases, successors, or journal infrastructure.
- Administrative recoverers use their own ordered stream. A live recovery claim cannot be
  force-released.
- Links, detectable junctions/reparse points, unexpected types, gaps, malformed records, digest
  mismatch, unsupported filesystems, and ambiguous process identity fail closed.

**Boundary:** This is cooperative same-host locking on a coherent local filesystem. `--force` is
an operator assertion of quiescence, not process fencing; misuse cannot stop a genuinely active
process. Malicious same-user or OS-level replacement of permanent journal infrastructure is outside
the current threat model. NFS, SMB, distributed FUSE, object-store mounts, cross-host access, and
filesystems without coherent no-clobber hard links are unsupported. General Windows support is not
claimed without exact-head native NTFS validation.

## Least-privilege target design

| Role | Repository read | Repository write | Shell | Network/integrations |
|---|---:|---:|---:|---:|
| Brainstormer | Yes | No | Read-only inspection | Limited |
| Designer | Yes | Documentation artifact only | Read-only inspection | Limited |
| Builder | Yes | Feature worktree | Project commands | Approved integrations |
| Verifier | Yes | No | Test commands only | None by default |
| PR resolver | Yes | Allowed files only | Targeted tests | GitHub reply through orchestrator only |

v0.1 approximates this policy through prompts, Cursor CLI flags, and post-run fingerprinting. It does not yet enforce the full matrix.

## Dependency and supply-chain policy

- Pin released dependencies with a lock file when registry access is available.
- Keep `@cursor/sdk` optional and behind an adapter.
- Use Dependabot and CI.
- Review all GitHub Actions by commit SHA for high-assurance deployments; starter workflow uses major tags for maintainability and should be hardened before production.
- Do not execute code downloaded by an agent without review.

## Incident response

1. Stop active runs and revoke affected tokens.
2. Preserve `run.json`, artifacts, command logs, git reflog, and provider request IDs.
3. Determine whether workspace or remote side effects occurred.
4. Rotate exposed credentials.
5. Revert unauthorized code and invalidate verification/check results.
6. Patch policy or runtime controls and add a regression test.
7. Document impact and notify affected users according to organizational policy.
