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
covered. Ephemeral legacy locks, `*.tmp` staging files, and exact
`runs/<run-id>/.lock-journal-v3/**` synchronization paths are intentionally excluded from the
fingerprint; the exclusion does not apply to similarly named paths elsewhere under `.maswe`.
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
- Documentation instructs teams not to commit run artifacts by default.

**Gaps and future work:**

- Automatic secret redaction covers common token/PEM/Authorization patterns; it is best-effort, not a DLP product.
- Default Cursor CLI prompt transport is stdin; argv remains available via `policy.promptTransport`.
- No provider-specific privacy controls beyond local redaction.

A near-term change should pass large prompts through stdin or SDK calls rather than command-line arguments where supported.

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

**Gap:** Digests and evidence are not yet cryptographically signed, and remote GitHub check-run automation remains a later milestone. Production GitHub integration must continue to invalidate verification on every head-SHA change.

### T10 — Webhook replay or forged GitHub event

**Future threat:** An attacker replays a review or approval event.

**Planned controls:**

- Verify GitHub webhook signatures.
- Store delivery IDs and reject duplicates.
- Use installation-scoped tokens.
- Authorize approvals by repository role/team.
- Use idempotency keys for side effects.

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
