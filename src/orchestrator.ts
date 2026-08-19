import type {
  AgentRuntime,
  DurableRuntimeFailureAttempt,
  DurableRuntimeFailureSummary,
  RoleId,
  RunFailureCode,
  RunRecord,
  RuntimeFinishedResult,
  WorkflowState,
} from "./domain.ts";
import { buildCommentClassifierPrompt, buildRolePrompt } from "./prompt-builder.ts";
import { gitRevParse, gitWorkspaceFingerprint, isGitWorkspaceClean } from "./git-snapshot.ts";
import {
  assertChangeScope,
  assertExpectedBranch,
  assertWorkingTreeScope,
  cleanupRunWorkspace,
  createDeterministicCommit,
  externalWorktreePath,
  invalidateStaleEvidence,
  listGitWorktreeRegistrations,
  refreshWorkspaceHead,
  workingDirectoryFor,
} from "./git-workspace.ts";
import { parseRoleMarker } from "./markers.ts";
import { resolveProjectModels } from "./model-resolution.ts";
import { renderQualityReport, runQualityChecks } from "./quality.ts";
import { isHumanGate, isTerminal } from "./state-machine.ts";
import { FileRunStore, type RunStore } from "./store.ts";
import {
  assertRevalidationFence,
  captureRevalidationFence,
  hasEnteredPullRequestReview,
  RevalidationOptimisticConflictError,
  RevalidationService,
  type RevalidationFence,
} from "./revalidation.ts";
import {
  assertBootstrapWorkspaceReady,
  captureWorkspaceBootstrapIntent,
  reconcileBootstrapWorkspace,
  reconcileRetryWorkspace,
  type WorkspaceBootstrapHooks,
} from "./workspace-bootstrap.ts";
import type { MasweConfig } from "./domain.ts";
import {
  appendFailureAggregate,
  assertRuntimeIdentity,
  DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT,
  ensureRuntimeSuccess,
  makeDurableRuntimeFailureSummary,
  reportOmittedFailureAttempts,
  runFailureCode,
  runFailureDetails,
  runFailureMessage,
  runFailureRuntime,
  RuntimeModelsExhaustedError,
  runtimeEventIdentityDetails,
  runtimeAttemptFailure,
  safeFailureMessage,
} from "./failure-diagnostics.ts";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  RunMutationSupersededError,
  withRunMutationFence,
  type RunMutationLease,
} from "./run-mutation.ts";

function isCanonicalFileStoreTimestamp(value: string): boolean {
  if (value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function areCanonicalFileStoreTimestamps(
  ...values: Array<string | undefined>
): boolean {
  return values.every(
    (value) => value === undefined || isCanonicalFileStoreTimestamp(value),
  );
}

export function extractVerifierDefects(report: string): string {
  const lines = report.split(/\r?\n/);
  const defects: string[] = [];
  for (const line of lines) {
    if (/^\s*([-*]|\d+\.)\s+/.test(line) || /\b(FAIL|BLOCK|DEFECT|FINDING)\b/i.test(line)) {
      defects.push(line.trim());
    }
  }
  if (defects.length === 0) {
    return [
      "# Verifier defects",
      "",
      "Verifier returned VERDICT: FAIL without a structured defect list.",
      "Review the full verification report and address blocking findings.",
      "",
      report.trim(),
      "",
    ].join("\n");
  }
  return ["# Verifier defects", "", ...defects.map((line) => `- ${line}`), ""].join("\n");
}

export interface OrchestratorOptions {
  /** Test-only seam for exercising bounded automatic workflow transitions. */
  automaticTransitionLimit?: number;
  /** Test seam immediately after durable bootstrap intent publication. */
  beforeBootstrapReconcile?: (run: RunRecord) => Promise<void>;
  /** Failure barriers around deterministic branch/worktree reconciliation. */
  bootstrapHooks?: WorkspaceBootstrapHooks;
  /** Failure barrier after the CREATED workspace checkpoint has been reloaded. */
  afterWorkspaceCheckpoint?: (run: RunRecord) => Promise<void>;
  /** Test seam immediately before the single retry event publication. */
  beforeRetryPublication?: (candidate: RunRecord) => Promise<void>;
  /** Deterministic barrier after final authority reload under the mutation fence. */
  afterRunMutationReload?: (
    phase: "builder" | "resolver" | "quality" | "verifier" | "merge-ready" | "complete",
    authoritative: RunRecord,
  ) => Promise<void>;
}

interface ActiveRevalidationPreflight {
  run: RunRecord;
  headSha: string | undefined;
  alignmentError?: Error;
}

const REVALIDATION_STABILITY_ATTEMPTS = 8;

export class Orchestrator {
  readonly store: RunStore;
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly runtime: AgentRuntime;
  private readonly automaticTransitionLimit: number;
  private readonly beforeBootstrapReconcile: ((run: RunRecord) => Promise<void>) | undefined;
  private readonly bootstrapHooks: WorkspaceBootstrapHooks;
  private readonly afterWorkspaceCheckpoint: ((run: RunRecord) => Promise<void>) | undefined;
  private readonly beforeRetryPublication: ((candidate: RunRecord) => Promise<void>) | undefined;
  private readonly afterRunMutationReload: OrchestratorOptions["afterRunMutationReload"];

  constructor(
    cwd: string,
    config: MasweConfig,
    runtime: AgentRuntime,
    store?: RunStore,
    options: OrchestratorOptions = {},
  ) {
    this.cwd = cwd;
    this.config = config;
    this.runtime = runtime;
    this.store = store ?? new FileRunStore(cwd);
    this.automaticTransitionLimit = options.automaticTransitionLimit ?? 20;
    this.beforeBootstrapReconcile = options.beforeBootstrapReconcile;
    this.bootstrapHooks = options.bootstrapHooks ?? {};
    this.afterWorkspaceCheckpoint = options.afterWorkspaceCheckpoint;
    this.beforeRetryPublication = options.beforeRetryPublication;
    this.afterRunMutationReload = options.afterRunMutationReload;
    if (
      !Number.isSafeInteger(this.automaticTransitionLimit) ||
      this.automaticTransitionLimit <= 0
    ) {
      throw new Error("automaticTransitionLimit must be a positive safe integer");
    }
  }

  private async createPlannedRun(
    title: string,
    request: string,
    config: MasweConfig,
    options: { supersedes?: string } = {},
  ): Promise<RunRecord> {
    if (!config.policy.allowDirtyWorkspace && !(await isGitWorkspaceClean(this.cwd))) {
      throw new Error("Workspace is dirty. Commit, stash, or set policy.allowDirtyWorkspace=true.");
    }
    const workspaceBootstrap = await captureWorkspaceBootstrapIntent(this.cwd, config);
    const run = await this.store.create(title, request, config, {
      workspaceBootstrap,
      ...options,
    });
    await this.beforeBootstrapReconcile?.(run);
    return run;
  }

  private recordsEqual(left: unknown, right: unknown): boolean {
    return isDeepStrictEqual(left, right);
  }

  private isCompleteBootstrapStart(prior: RunRecord, candidate: RunRecord): boolean {
    if (
      prior.state !== "CREATED" ||
      !prior.workspace ||
      !prior.workspaceBootstrap ||
      candidate.state !== "BRAINSTORMING" ||
      candidate.workspaceBootstrap !== undefined ||
      candidate.version !== prior.version + 1 ||
      candidate.events.length !== prior.events.length + 1 ||
      JSON.stringify(candidate.events.slice(0, prior.events.length)) !==
        JSON.stringify(prior.events)
    ) {
      return false;
    }
    const event = candidate.events.at(-1);
    const expectedDetails = prior.supersedes ? { supersedes: prior.supersedes } : undefined;
    if (
      !event ||
      event.type !== "START" ||
      event.actor !== "user" ||
      event.from !== "CREATED" ||
      event.to !== "BRAINSTORMING" ||
      JSON.stringify(event.details) !== JSON.stringify(expectedDetails)
    ) {
      return false;
    }

    const expected = structuredClone(prior);
    expected.state = "BRAINSTORMING";
    expected.version = candidate.version;
    expected.updatedAt = candidate.updatedAt;
    expected.events = candidate.events;
    delete expected.workspaceBootstrap;
    return this.recordsEqual(candidate, expected);
  }

  /** Establish and publish the durable CREATED workspace checkpoint before START. */
  async bootstrapCreatedRun(runId: string): Promise<RunRecord> {
    const prior = await this.store.load(runId);
    if (prior.state !== "CREATED") {
      throw new Error(`Run ${runId} bootstrap requires CREATED state, found ${prior.state}`);
    }
    let checkpointExpected: RunRecord | undefined;
    let startExpected: RunRecord | undefined;
    try {
      if (prior.workspace) {
        checkpointExpected = structuredClone(prior);
        await assertBootstrapWorkspaceReady(this.cwd, checkpointExpected);
      } else {
        const workspace = await reconcileBootstrapWorkspace(
          this.cwd,
          prior,
          this.bootstrapHooks,
        );
        checkpointExpected = structuredClone(prior);
        checkpointExpected.workspace = workspace;
        await this.store.save(checkpointExpected);
      }

      const checkpoint = await this.store.load(runId);
      if (!checkpointExpected || !this.recordsEqual(checkpoint, checkpointExpected)) {
        throw new Error("Authoritative CREATED workspace checkpoint changed during bootstrap");
      }
      await this.afterWorkspaceCheckpoint?.(checkpoint);
      const reloaded = await this.store.load(runId);
      if (!this.recordsEqual(reloaded, checkpoint)) {
        throw new Error("Authoritative CREATED workspace checkpoint changed before START");
      }
      await assertBootstrapWorkspaceReady(this.cwd, reloaded);

      startExpected = structuredClone(reloaded);
      delete startExpected.workspaceBootstrap;
      const details = startExpected.supersedes
        ? { supersedes: startExpected.supersedes }
        : undefined;
      return await this.store.applyEvent(startExpected, "START", "user", details);
    } catch (error) {
      const observed = await this.store.load(runId);
      if (checkpointExpected && this.isCompleteBootstrapStart(checkpointExpected, observed)) {
        return observed;
      }
      const exactPrior = this.recordsEqual(observed, prior);
      const exactCheckpoint = checkpointExpected
        ? this.recordsEqual(observed, checkpointExpected)
        : false;
      if (observed.state === "CREATED" && observed.workspaceBootstrap && (exactPrior || exactCheckpoint)) {
        return this.failRun(
          observed,
          runFailureMessage(error),
          runFailureCode(error),
          runFailureRuntime(error),
          { preserveCreatedWorkspace: true },
        );
      }
      throw new Error(
        "Workspace bootstrap publication outcome is ambiguous: authoritative state is neither an exact actionable CREATED checkpoint nor a complete START publication.",
        { cause: error },
      );
    }
  }

  private assertWithinBudget(run: RunRecord): void {
    const max = run.config.policy.maxRunDurationMs;
    if (!max) return;
    const elapsed = Date.now() - Date.parse(run.createdAt);
    if (elapsed > max) {
      throw new Error(`Run exceeded maxRunDurationMs (${max}).`);
    }
  }

  private async finalizeTerminal(run: RunRecord): Promise<RunRecord> {
    if (isTerminal(run.state)) {
      try {
        await cleanupRunWorkspace(run);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Run reached ${run.state} but worktree cleanup failed: ${message}`);
      }
    }
    return run;
  }

  async start(title: string, request: string): Promise<RunRecord> {
    const catalogue = await this.runtime.listModels();
    const resolvedConfig = resolveProjectModels(this.config, catalogue);
    const planned = await this.createPlannedRun(title, request, resolvedConfig);
    const run = await this.bootstrapCreatedRun(planned.id);
    return this.runUntilBlocked(run.id);
  }

  async approve(runId: string, gate: "brainstorm" | "design"): Promise<RunRecord> {
    const run = await this.store.load(runId);
    if (gate === "brainstorm") {
      run.approvals.brainstorm = true;
      await this.store.applyEvent(run, "APPROVE_BRAINSTORM", "user");
    } else {
      run.approvals.design = true;
      await this.store.applyEvent(run, "APPROVE_DESIGN", "user");
    }
    return this.runUntilBlocked(run.id);
  }

  async runUntilBlocked(runId: string): Promise<RunRecord> {
    let run = await this.store.load(runId);
    let iterations = 0;
    while (!isTerminal(run.state)) {
      if (isHumanGate(run.state)) {
        if (run.state !== "PR_READY" && run.state !== "PR_REVIEW") return run;
        try {
          const preflight = await this.preflightReturnGate(run);
          run = preflight;
          if (run.state !== "PR_READY" && run.state !== "PR_REVIEW") continue;
          return run;
        } catch (error) {
          return this.failRun(
            run,
            runFailureMessage(error),
            runFailureCode(error),
            runFailureRuntime(error),
            { preserveWorkspace: true },
          );
        }
      }
      run = await this.advance(run.id);
      iterations += 1;
      if (isTerminal(run.state)) return run;
      if (iterations >= this.automaticTransitionLimit && !isHumanGate(run.state)) {
        return this.failRun(
          run,
          `Workflow exceeded ${this.automaticTransitionLimit} automatic transitions.`,
          "automatic-transition-limit-exceeded",
        );
      }
    }
    return run;
  }

  private hasCurrentGateEvidence(run: RunRecord, headSha: string): boolean {
    return (
      run.evidence?.quality?.headSha === headSha &&
      run.evidence.verification?.headSha === headSha
    );
  }

  private async observeRevalidationWorkspace(run: RunRecord): Promise<string | undefined> {
    if (!run.workspace) {
      throw new Error(`Run ${run.id} has no workspace for revalidation`);
    }
    const workdir = workingDirectoryFor(run);
    if (!(await isGitWorkspaceClean(workdir))) {
      throw new Error(`Revalidation workspace is dirty at ${run.workspace.headSha}`);
    }
    const headSha = (await refreshWorkspaceHead(run)) ?? run.workspace.headSha;
    if (!(await isGitWorkspaceClean(workdir))) {
      throw new Error(`Revalidation workspace changed while observing HEAD ${headSha}`);
    }
    return headSha;
  }

  private async preflightReturnGate(run: RunRecord): Promise<RunRecord> {
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return run;
    const previousHeadSha = run.workspace.headSha;
    const observed = structuredClone(run);
    const requestedHeadSha = await this.observeRevalidationWorkspace(observed);
    if (!requestedHeadSha) return run;
    if (
      requestedHeadSha === previousHeadSha &&
      this.hasCurrentGateEvidence(run, requestedHeadSha)
    ) {
      return run;
    }
    return new RevalidationService(this.store).route(run.id, {
      source: "local-workspace",
      previousHeadSha,
      requestedHeadSha,
      expectedRunVersion: run.version,
      actor: "local-runner",
      observedWorkspace: observed.workspace!,
    });
  }

  private currentWorkflowTarget(run: RunRecord): string | undefined {
    return run.revalidation?.requestedHeadSha ?? run.workspace?.headSha;
  }

  private async preflightCommittedAssociationHead(run: RunRecord): Promise<RunRecord> {
    let snapshot = run;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      const github = snapshot.github;
      if (!github || github.suspended === true) return snapshot;
      const currentTarget = this.currentWorkflowTarget(snapshot);
      if (!currentTarget) {
        throw new Error(
          `Run ${run.id} has no authoritative workflow target for committed GitHub HEAD ${github.headSha}`,
        );
      }
      if (github.headSha === currentTarget) return snapshot;

      const committedHeadSha = github.headSha;
      try {
        await new RevalidationService(this.store).route(run.id, {
          source: "github",
          previousHeadSha: currentTarget,
          requestedHeadSha: committedHeadSha,
          expectedRunVersion: snapshot.version,
          actor: "local-runner",
        });
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        const authoritative = await this.store.load(run.id);
        if (
          authoritative.github?.suspended !== true &&
          authoritative.github?.headSha === committedHeadSha &&
          this.currentWorkflowTarget(authoritative) === committedHeadSha
        ) {
          return authoritative;
        }
        snapshot = authoritative;
        continue;
      }

      const authoritative = await this.store.load(run.id);
      if (
        authoritative.github?.suspended !== true &&
        authoritative.github?.headSha === committedHeadSha &&
        this.currentWorkflowTarget(authoritative) === committedHeadSha
      ) {
        return authoritative;
      }
      snapshot = authoritative;
    }
    throw new Error(`Run ${run.id} committed GitHub association target did not stabilize`);
  }

  private async preflightActiveRevalidation(
    run: RunRecord,
  ): Promise<ActiveRevalidationPreflight> {
    let snapshot = run;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      if (!snapshot.revalidation) {
        return {
          run: snapshot,
          headSha: (await this.syncWorkspace(snapshot)) ?? snapshot.workspace?.headSha,
        };
      }
      const observed = structuredClone(snapshot);
      const observedHeadSha = await this.observeRevalidationWorkspace(observed);
      if (!observedHeadSha || !observed.workspace) {
        throw new Error(`Run ${run.id} has no observable revalidation workspace HEAD`);
      }
      const source = snapshot.github ? "github" : "local-workspace";
      const requiredHeadSha = snapshot.github?.headSha ?? observedHeadSha;
      if (
        snapshot.revalidation.requestedHeadSha === requiredHeadSha &&
        observedHeadSha !== requiredHeadSha
      ) {
        return {
          run: snapshot,
          headSha: observedHeadSha,
          alignmentError: new Error(
            `Required revalidation target ${requiredHeadSha} does not match workspace HEAD ${observedHeadSha}`,
          ),
        };
      }

      let routed: RunRecord;
      try {
        routed = await new RevalidationService(this.store).route(run.id, {
          source,
          previousHeadSha: snapshot.revalidation.requestedHeadSha,
          requestedHeadSha: requiredHeadSha,
          expectedRunVersion: snapshot.version,
          actor: source === "github" ? "github-app" : "local-runner",
          observedWorkspace: observed.workspace,
        });
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        snapshot = await this.store.load(run.id);
        continue;
      }

      const authoritative = await this.store.load(run.id);
      if (!this.recordsEqual(authoritative, routed)) {
        snapshot = authoritative;
        continue;
      }
      if (!authoritative.revalidation) {
        return {
          run: authoritative,
          headSha: authoritative.workspace?.headSha,
        };
      }
      const stableObserved = structuredClone(authoritative);
      const stableObservedHeadSha = await this.observeRevalidationWorkspace(stableObserved);
      if (!stableObservedHeadSha || !stableObserved.workspace) {
        throw new Error(`Run ${run.id} has no observable revalidation workspace HEAD`);
      }
      const stableRequiredHeadSha = authoritative.github?.headSha ?? stableObservedHeadSha;
      if (authoritative.revalidation.requestedHeadSha !== stableRequiredHeadSha) {
        snapshot = authoritative;
        continue;
      }
      if (stableObservedHeadSha !== stableRequiredHeadSha) {
        return {
          run: authoritative,
          headSha: stableObservedHeadSha,
          alignmentError: new Error(
            `Required revalidation target ${stableRequiredHeadSha} does not match workspace HEAD ${stableObservedHeadSha}`,
          ),
        };
      }
      return { run: authoritative, headSha: stableObservedHeadSha };
    }
    throw new Error(`Run ${run.id} revalidation target did not stabilize`);
  }

  private captureOptionalRevalidationFence(run: RunRecord): RevalidationFence | undefined {
    return run.revalidation ? captureRevalidationFence(run) : undefined;
  }

  private async assertOptionalRevalidationFence(
    run: RunRecord,
    fence: RevalidationFence | undefined,
  ): Promise<void> {
    if (fence) await assertRevalidationFence(this.store, run.id, fence);
  }

  private async withRunPublicationFence<T>(
    run: RunRecord,
    phase: "builder" | "resolver" | "quality" | "verifier",
    fence: RevalidationFence | undefined,
    publish: () => Promise<T>,
    ownedLease?: RunMutationLease,
    queuedTargetLinearizedBeforeWork = false,
  ): Promise<T> {
    const publishUnderLease = async (lease: RunMutationLease): Promise<T> => {
      const authoritative = fence
        ? await assertRevalidationFence(this.store, run.id, fence)
        : await this.store.load(run.id);
      if (!fence && authoritative.version !== run.version) {
        throw new Error(
          `Run ${run.id} changed before ${phase} publication: expected ${run.version}, authoritative ${authoritative.version}`,
        );
      }
      await this.afterRunMutationReload?.(phase, authoritative);
      if (!queuedTargetLinearizedBeforeWork) {
        await lease.assertNoQueuedTargetMutation();
      }
      return publish();
    };
    if (ownedLease) return publishUnderLease(ownedLease);
    return withRunMutationFence(
      run.repositoryPath,
      run.id,
      "publication",
      publishUnderLease,
    );
  }

  private async assertExpectedGitPublicationInput(
    run: RunRecord,
    expectedHeadSha: string,
    label: string,
  ): Promise<void> {
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return;
    const workdir = workingDirectoryFor(run);
    await assertExpectedBranch(workdir, run.workspace.branch);
    const actualHeadSha = await gitRevParse(workdir, "HEAD");
    if (actualHeadSha !== expectedHeadSha) {
      run.workspace.headSha = actualHeadSha;
      run.workspace.fingerprint = await gitWorkspaceFingerprint(workdir);
      invalidateStaleEvidence(run, actualHeadSha);
      throw new Error(
        `${label} expected HEAD ${expectedHeadSha}, but authoritative publication observed ${actualHeadSha}`,
      );
    }
  }

  private async assertExactGitPublicationState(
    run: RunRecord,
    expectedHeadSha: string,
    label: string,
  ): Promise<void> {
    await this.assertExpectedGitPublicationInput(run, expectedHeadSha, label);
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return;
    const workdir = workingDirectoryFor(run);
    if (!(await isGitWorkspaceClean(workdir))) {
      throw new Error(`${label} requires a clean worktree at ${expectedHeadSha}`);
    }
    await assertExpectedBranch(workdir, run.workspace.branch);
    const finalHeadSha = await gitRevParse(workdir, "HEAD");
    if (finalHeadSha !== expectedHeadSha) {
      run.workspace.headSha = finalHeadSha;
      run.workspace.fingerprint = await gitWorkspaceFingerprint(workdir);
      invalidateStaleEvidence(run, finalHeadSha);
      throw new Error(
        `${label} final HEAD moved from ${expectedHeadSha} to ${finalHeadSha}`,
      );
    }
  }

  private async syncWorkspace(run: RunRecord): Promise<string | undefined> {
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return undefined;
    const workdir = workingDirectoryFor(run);
    await assertExpectedBranch(workdir, run.workspace.branch);
    const headSha = await refreshWorkspaceHead(run);
    if (headSha && invalidateStaleEvidence(run, headSha)) {
      await this.store.save(run);
    }
    return headSha;
  }

  private bindEvidence(
    run: RunRecord,
    kind: "quality" | "verification",
    headSha: string,
    passed: boolean,
  ): void {
    run.evidence = {
      ...(run.evidence ?? {}),
      [kind]: {
        headSha,
        passed,
        at: new Date().toISOString(),
      },
    };
  }

  private async advanceGitDependentAutomaticWork(
    run: RunRecord,
    headSha: string | undefined,
  ): Promise<
    | { kind: "completed"; run: RunRecord }
    | { kind: "retry"; run: RunRecord }
  > {
    return withRunMutationFence(
      run.repositoryPath,
      run.id,
      "publication",
      async (lease) => {
        const authoritative = await this.store.load(run.id);
        if (authoritative.repositoryPath !== run.repositoryPath) {
          throw new Error(`Run ${run.id} repository path changed before automatic work`);
        }
        if (
          authoritative.version !== run.version ||
          authoritative.state !== run.state
        ) {
          return { kind: "retry", run: authoritative };
        }
        const github = authoritative.github;
        if (github?.suspended !== true) {
          const currentTarget = this.currentWorkflowTarget(authoritative);
          if (github && !currentTarget) {
            throw new Error(
              `Run ${run.id} has no authoritative workflow target for committed GitHub HEAD ${github.headSha}`,
            );
          }
          if (github && github.headSha !== currentTarget) {
            return { kind: "retry", run: authoritative };
          }
        }
        // Mutable builder work linearizes here: a later target waits for its
        // clean commit. Evidence-only phases retain their final queued-target
        // scan and are still superseded before publication.
        await lease.assertNoQueuedTargetMutation();

        switch (run.state) {
          case "BUILDING": {
            run.counters.buildVerifyCycles += 1;
            if (run.counters.buildVerifyCycles > run.config.policy.maxBuildVerifyCycles) {
              return {
                kind: "completed",
                run: await this.failRun(run, "Maximum build/verify cycles exceeded."),
              };
            }
            return {
              kind: "completed",
              run: await this.executeBuilderWithPublish(run, headSha, lease),
            };
          }
          case "CI_RUNNING": {
            const workdir = workingDirectoryFor(run);
            const evaluatedSha =
              (await refreshWorkspaceHead(run)) ?? headSha ?? "not-a-git-repository";
            if (
              run.revalidation &&
              evaluatedSha !== run.revalidation.requestedHeadSha
            ) {
              throw new Error(
                `CI revalidation target ${run.revalidation.requestedHeadSha} does not match evaluated HEAD ${evaluatedSha}`,
              );
            }
            if (
              evaluatedSha !== "not-a-git-repository" &&
              !(await isGitWorkspaceClean(workdir))
            ) {
              throw new Error(`CI requires a clean worktree at ${evaluatedSha}`);
            }
            const report = await runQualityChecks(workdir, run.config.quality.commands, {
              timeoutMs: run.config.policy.commandTimeoutMs,
            });
            if (evaluatedSha !== "not-a-git-repository") {
              if (!(await isGitWorkspaceClean(workdir))) {
                throw new Error(
                  "Quality commands left the worktree dirty; evidence is not trustworthy.",
                );
              }
              const afterQualitySha = await gitRevParse(workdir);
              if (afterQualitySha !== evaluatedSha) {
                throw new Error(
                  `HEAD moved during quality commands (before ${evaluatedSha}, after ${afterQualitySha})`,
                );
              }
            }
            await this.store.writeArtifact(
              run,
              "05-quality-report.md",
              renderQualityReport(report),
            );
            const fence = this.captureOptionalRevalidationFence(run);
            const accepted = report.passed || !run.config.gates.requireCiPass;
            const completed = await this.withRunPublicationFence(
              run,
              "quality",
              fence,
              async () => {
                await this.assertExactGitPublicationState(
                  run,
                  evaluatedSha,
                  "Quality publication",
                );
                this.bindEvidence(run, "quality", evaluatedSha, report.passed);
                return this.store.applyEvent(
                  run,
                  accepted ? "CI_PASSED" : "CI_FAILED",
                  "quality-runner",
                  {
                    passed: report.passed,
                    required: run.config.gates.requireCiPass,
                    headSha: evaluatedSha,
                  },
                );
              },
              lease,
            );
            return { kind: "completed", run: completed };
          }
          case "VERIFYING": {
            const workdir = workingDirectoryFor(run);
            const evaluatedSha =
              (await refreshWorkspaceHead(run)) ?? headSha ?? "not-a-git-repository";
            if (
              run.revalidation &&
              evaluatedSha !== run.revalidation.requestedHeadSha
            ) {
              throw new Error(
                `Verifier revalidation target ${run.revalidation.requestedHeadSha} does not match evaluated HEAD ${evaluatedSha}`,
              );
            }
            if (
              evaluatedSha !== "not-a-git-repository" &&
              !(await isGitWorkspaceClean(workdir))
            ) {
              throw new Error(`Verifier requires a clean worktree at ${evaluatedSha}`);
            }
            if (run.config.gates.requireCiPass) {
              if (
                !run.evidence?.quality ||
                !run.evidence.quality.passed ||
                run.evidence.quality.headSha !== evaluatedSha
              ) {
                throw new Error(
                  "VERIFYING requires present, passing quality evidence for the current HEAD",
                );
              }
            } else if (
              run.evidence?.quality?.headSha &&
              run.evidence.quality.headSha !== evaluatedSha
            ) {
              throw new Error(
                `Quality evidence is stale for head SHA ${evaluatedSha}; re-run CI before verification.`,
              );
            }
            const prompt = await buildRolePrompt("verifier", run, this.store);
            const result = await this.executeAgent(run, "verifier", prompt);
            if (evaluatedSha !== "not-a-git-repository") {
              if (!(await isGitWorkspaceClean(workdir))) {
                throw new Error(
                  "Verifier left the worktree dirty; evidence is not trustworthy.",
                );
              }
              const afterVerifySha = await gitRevParse(workdir);
              if (afterVerifySha !== evaluatedSha) {
                throw new Error(
                  `HEAD moved during verification (before ${evaluatedSha}, after ${afterVerifySha})`,
                );
              }
            }
            const markers = parseRoleMarker("verifier", result.output);
            if (!markers.ok) throw new Error(markers.message);
            await this.store.writeArtifact(run, "06-verification-report.md", result.output);
            const passed = markers.value === "PASS";
            if (!passed && run.config.gates.requireVerifierPass) {
              await this.store.writeArtifact(
                run,
                "10-verifier-defects.md",
                extractVerifierDefects(result.output),
              );
            }
            const fence = this.captureOptionalRevalidationFence(run);
            const accepted = passed || !run.config.gates.requireVerifierPass;
            const completed = await this.withRunPublicationFence(
              run,
              "verifier",
              fence,
              async () => {
                await this.assertExactGitPublicationState(
                  run,
                  evaluatedSha,
                  "Verification publication",
                );
                this.bindEvidence(run, "verification", evaluatedSha, passed);
                const successEvent =
                  run.revalidation?.returnState === "PR_READY"
                    ? "VERIFY_PASSED"
                    : run.revalidation?.returnState === "PR_REVIEW"
                      ? "VERIFY_PASSED_AFTER_REVIEW"
                      : hasEnteredPullRequestReview(run)
                        ? "VERIFY_PASSED_AFTER_REVIEW"
                        : "VERIFY_PASSED";
                if (accepted && run.revalidation) delete run.revalidation;
                return this.store.applyEvent(
                  run,
                  accepted ? successEvent : "VERIFY_FAILED",
                  "verifier",
                  {
                    passed,
                    required: run.config.gates.requireVerifierPass,
                    ...runtimeEventIdentityDetails(result),
                    headSha: evaluatedSha,
                    marker: markers.marker,
                  },
                );
              },
              lease,
            );
            return { kind: "completed", run: completed };
          }
          default:
            throw new Error(`State ${run.state} is not Git-dependent automatic work`);
        }
      },
    );
  }

  async advance(runId: string): Promise<RunRecord> {
    let run = await this.store.load(runId);
    try {
      for (let entryAttempt = 0; ; entryAttempt += 1) {
        this.assertWithinBudget(run);
        let headSha: string | undefined;
        if (
          run.state === "BUILDING" ||
          run.state === "CI_RUNNING" ||
          run.state === "VERIFYING"
        ) {
          run = await this.preflightCommittedAssociationHead(run);
          if (
            run.state !== "BUILDING" &&
            run.state !== "CI_RUNNING" &&
            run.state !== "VERIFYING"
          ) {
            return run;
          }
        }
        if (
          run.revalidation &&
          (run.state === "BUILDING" || run.state === "CI_RUNNING" || run.state === "VERIFYING")
        ) {
          const preflight = await this.preflightActiveRevalidation(run);
          run = preflight.run;
          headSha = preflight.headSha;
          if (preflight.alignmentError) throw preflight.alignmentError;
        } else {
          headSha = (await this.syncWorkspace(run)) ?? run.workspace?.headSha;
        }
        if (
          run.state === "BUILDING" ||
          run.state === "CI_RUNNING" ||
          run.state === "VERIFYING"
        ) {
          const attempt = await this.advanceGitDependentAutomaticWork(run, headSha);
          if (attempt.kind === "completed") return attempt.run;
          run = attempt.run;
          if (entryAttempt + 1 >= REVALIDATION_STABILITY_ATTEMPTS) {
            throw new Error(`Run ${run.id} automatic work authority did not stabilize`);
          }
          continue;
        }
        switch (run.state) {
        case "BRAINSTORMING": {
          const completed = await this.executeRole(
            run,
            "brainstormer",
            "02-brainstorm.md",
            "BRAINSTORM_COMPLETED",
            headSha,
          );
          if (!completed.config.gates.requireBrainstormApproval) {
            completed.approvals.brainstorm = true;
            return this.store.applyEvent(completed, "APPROVE_BRAINSTORM", "policy");
          }
          return completed;
        }
        case "DESIGNING": {
          const completed = await this.executeRole(
            run,
            "designer",
            "03-specification-and-design.md",
            "DESIGN_COMPLETED",
            headSha,
          );
          if (!completed.config.gates.requireDesignApproval) {
            completed.approvals.design = true;
            return this.store.applyEvent(completed, "APPROVE_DESIGN", "policy");
          }
          return completed;
        }
        case "CLASSIFYING_COMMENT": {
          const comment = (await this.store.readArtifact(run, "07-review-comment.md")) ?? "";
          const prompt = await buildCommentClassifierPrompt(run, this.store, comment);
          const result = await this.executeAgent(run, "prResolver", prompt, {
            ...run.config.roles.prResolver,
            permissions: "read-only",
          });
          const markers = parseRoleMarker("prResolver", result.output, { mode: "classify" });
          if (!markers.ok) throw new Error(markers.message);
          await this.store.writeArtifact(run, "08-comment-classification.md", result.output);
          return this.store.applyEvent(
            run,
            markers.value === "IN_SCOPE" ? "COMMENT_IN_SCOPE" : "COMMENT_OUT_OF_SCOPE",
            "pr-comment-classifier",
            {
              marker: markers.marker,
              ...(headSha ? { headSha } : {}),
            },
          );
        }
        case "RESOLVING": {
          run.counters.commentResolutionCycles += 1;
          if (run.counters.commentResolutionCycles > run.config.policy.maxCommentResolutionCycles) {
            return this.failRun(run, "Maximum PR comment resolution cycles exceeded.");
          }
          return await this.executeResolverWithPublish(run, headSha);
        }
        default:
          throw new Error(`State ${run.state} requires a user or integration event.`);
        }
      }
    } catch (error) {
      if (error instanceof RunMutationSupersededError) throw error;
      return this.failRun(
        run,
        runFailureMessage(error),
        runFailureCode(error),
        runFailureRuntime(error),
        { preserveWorkspace: run.revalidation !== undefined },
      );
    }
  }

  private async executeBuilderWithPublish(
    run: RunRecord,
    inputHeadSha: string | undefined,
    ownedLease?: RunMutationLease,
  ): Promise<RunRecord> {
    const workdir = workingDirectoryFor(run);
    const beforeSha =
      inputHeadSha ??
      (run.workspace && run.workspace.baseSha !== "not-a-git-repository"
        ? await gitRevParse(workdir)
        : undefined);

    const prompt = await buildRolePrompt("builder", run, this.store);
    const result = await this.executeAgent(run, "builder", prompt);
    const markers = parseRoleMarker("builder", result.output);
    if (!markers.ok) throw new Error(markers.message);
    await this.store.writeArtifact(run, "04-builder-report.md", result.output);
    const fence = this.captureOptionalRevalidationFence(run);

    let outputHeadSha = beforeSha;
    if (run.workspace && run.workspace.baseSha !== "not-a-git-repository" && beforeSha) {
      await assertExpectedBranch(workdir, run.workspace.branch);
      const afterBuilderSha = await gitRevParse(workdir);
      if (afterBuilderSha !== beforeSha) {
        throw new Error(
          "HEAD moved during builder execution (model-created commit, reset, or rebase is not allowed)",
        );
      }
      await assertWorkingTreeScope(workdir, run.config.policy.allowedPathGlobs);
    }
    return this.withRunPublicationFence(run, "builder", fence, async () => {
      if (run.workspace && run.workspace.baseSha !== "not-a-git-repository" && beforeSha) {
        await this.assertExpectedGitPublicationInput(run, beforeSha, "Builder commit publication");
        const committed = await createDeterministicCommit(workdir, "maswe: builder changes", {
          allowedPathGlobs: run.config.policy.allowedPathGlobs,
          expectedParentSha: beforeSha,
        });
        if (!(await isGitWorkspaceClean(workdir))) {
          throw new Error("worktree remained dirty after deterministic commit");
        }
        if (committed.files.length > 0) {
          await assertChangeScope(workdir, run.workspace.baseSha, run.config.policy.allowedPathGlobs);
        }
        outputHeadSha = committed.headSha;
        run.workspace.headSha = committed.headSha;
        invalidateStaleEvidence(run, committed.headSha);
        await this.assertExactGitPublicationState(
          run,
          committed.headSha,
          "Builder event publication",
        );
      }
      const evaluatedHeadSha = outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
      return this.store.applyEvent(run, "BUILD_COMPLETED", "builder", {
        ...runtimeEventIdentityDetails(result),
        marker: markers.marker,
        ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
        ...(evaluatedHeadSha
          ? { headSha: evaluatedHeadSha, outputHeadSha: evaluatedHeadSha }
          : {}),
      });
    }, ownedLease, ownedLease !== undefined);
  }

  private async executeResolverWithPublish(
    run: RunRecord,
    inputHeadSha: string | undefined,
  ): Promise<RunRecord> {
    const workdir = workingDirectoryFor(run);
    const beforeSha =
      inputHeadSha ??
      (run.workspace && run.workspace.baseSha !== "not-a-git-repository"
        ? await gitRevParse(workdir)
        : undefined);

    const prompt = await buildRolePrompt("prResolver", run, this.store);
    const result = await this.executeAgent(run, "prResolver", prompt);
    const markers = parseRoleMarker("prResolver", result.output);
    if (!markers.ok) throw new Error(markers.message);
    await this.store.writeArtifact(run, "09-resolution-report.md", result.output);
    const fence = this.captureOptionalRevalidationFence(run);

    let outputHeadSha = beforeSha;
    if (run.workspace && run.workspace.baseSha !== "not-a-git-repository" && beforeSha) {
      await assertExpectedBranch(workdir, run.workspace.branch);
      const afterSha = await gitRevParse(workdir);
      if (afterSha !== beforeSha) {
        throw new Error(
          "HEAD moved during resolver execution (model-created commit, reset, or rebase is not allowed)",
        );
      }
      await assertWorkingTreeScope(workdir, run.config.policy.allowedPathGlobs);
    }
    return this.withRunPublicationFence(run, "resolver", fence, async () => {
      if (run.workspace && run.workspace.baseSha !== "not-a-git-repository" && beforeSha) {
        await this.assertExpectedGitPublicationInput(run, beforeSha, "Resolver commit publication");
        const committed = await createDeterministicCommit(workdir, "maswe: resolve review comment", {
          allowedPathGlobs: run.config.policy.allowedPathGlobs,
          expectedParentSha: beforeSha,
        });
        if (!(await isGitWorkspaceClean(workdir))) {
          throw new Error("worktree remained dirty after deterministic commit");
        }
        outputHeadSha = committed.headSha;
        run.workspace.headSha = committed.headSha;
        invalidateStaleEvidence(run, committed.headSha);
        await this.assertExactGitPublicationState(
          run,
          committed.headSha,
          "Resolver event publication",
        );
      }
      const evaluatedHeadSha = outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
      return this.store.applyEvent(run, "RESOLUTION_COMPLETED", "prResolver", {
        ...runtimeEventIdentityDetails(result),
        marker: markers.marker,
        ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
        ...(evaluatedHeadSha
          ? { headSha: evaluatedHeadSha, outputHeadSha: evaluatedHeadSha }
          : {}),
      });
    });
  }

  private async failRun(
    run: RunRecord,
    message: string,
    code: RunFailureCode = "workflow-failure",
    runtime?: DurableRuntimeFailureSummary,
    options: { preserveCreatedWorkspace?: boolean; preserveWorkspace?: boolean } = {},
  ): Promise<RunRecord> {
    const resumeState = isTerminal(run.state) ? undefined : run.state;
    if (options.preserveCreatedWorkspace && resumeState !== "CREATED") {
      throw new Error("Workspace preservation is allowed only for a CREATED bootstrap failure");
    }
    const finishFailure = (record: RunRecord): Promise<RunRecord> =>
      options.preserveCreatedWorkspace || options.preserveWorkspace
        ? Promise.resolve(record)
        : this.finalizeTerminal(record);
    const safeMessage = safeFailureMessage(message);
    const candidate = structuredClone(run);
    candidate.failure = {
      code,
      message: safeMessage,
      at: new Date().toISOString(),
      ...(resumeState ? { resumeState } : {}),
      ...(runtime ? { runtime } : {}),
    };
    if (isTerminal(candidate.state)) {
      await this.store.save(candidate);
      return finishFailure(candidate);
    }

    const prior = await this.store.load(run.id);
    const priorEventIds = new Set(prior.events.map((event) => event.id));
    let failed: RunRecord;
    try {
      failed = await this.store.applyEvent(candidate, "FAIL", "orchestrator", {
        ...runFailureDetails(code, safeMessage, runtime),
        ...(resumeState ? { resumeState } : {}),
      });
    } catch (error) {
      const observed = await this.store.load(run.id);
      const newEvents = observed.events.filter((event) => !priorEventIds.has(event.id));
      const observedEvent = newEvents[0];
      const expectedNewEvents = candidate.events.filter((event) => !priorEventIds.has(event.id));
      const expectedEvent = expectedNewEvents[0];
      const priorRecordIsUnchanged = this.recordsEqual(observed, prior);
      if (priorRecordIsUnchanged) throw error;

      const completePublication =
        this.recordsEqual(observed, candidate) &&
        newEvents.length === 1 &&
        expectedNewEvents.length === 1 &&
        observedEvent !== undefined &&
        expectedEvent !== undefined &&
        observedEvent.id === expectedEvent.id &&
        observedEvent.type === "FAIL" &&
        observedEvent.from === resumeState &&
        observedEvent.to === "FAILED";
      if (completePublication) return finishFailure(observed);

      throw new Error(
        "Failure publication outcome is ambiguous: authoritative state is neither unchanged nor a complete failed run.",
        { cause: error },
      );
    }
    return finishFailure(failed);
  }

  private async executeRole(
    run: RunRecord,
    role: RoleId,
    artifactName: string,
    successEvent: "BRAINSTORM_COMPLETED" | "DESIGN_COMPLETED",
    headSha?: string,
  ): Promise<RunRecord> {
    const prompt = await buildRolePrompt(role, run, this.store);
    const result = await this.executeAgent(run, role, prompt);
    const markers = parseRoleMarker(role, result.output);
    if (!markers.ok) throw new Error(markers.message);
    await this.store.writeArtifact(run, artifactName, result.output);
    const evaluatedSha = headSha ?? run.workspace?.headSha;
    return this.store.applyEvent(run, successEvent, role, {
      ...runtimeEventIdentityDetails(result),
      marker: markers.marker,
      ...(evaluatedSha ? { headSha: evaluatedSha } : {}),
    });
  }

  private async executeAgent(
    run: RunRecord,
    role: RoleId,
    prompt: string,
    roleOverride?: RunRecord["config"]["roles"][RoleId],
  ): Promise<RuntimeFinishedResult> {
    const configured = roleOverride ?? run.config.roles[role];
    const candidates = run.config.policy.rejectModelFallback
      ? [configured.model]
      : [configured.model, ...(configured.fallbackModels ?? [])];
    let aggregate = `${role} failed for all configured models: `;
    let aggregateHasEntries = false;
    let aggregateFull = false;
    let aggregateOmittedAttempts = 0;
    let totalFailureAttempts = 0;
    const durableAttempts: DurableRuntimeFailureAttempt[] = [];
    const workdir = workingDirectoryFor(run);

    for (const model of candidates) {
      try {
        const result = await this.runtime.execute({
          runId: run.id,
          role,
          prompt,
          cwd: workdir,
          roleConfig: { ...configured, model },
          timeoutMs: run.config.policy.roleTimeoutMs,
          managedWorktree: Boolean(
            run.workspace?.worktreePath && path.resolve(workdir) === path.resolve(run.workspace.worktreePath),
          ),
        });
        ensureRuntimeSuccess(result, role);
        if (
          run.config.policy.rejectModelFallback &&
          result.actualModel &&
          result.actualModel !== result.requestedModel
        ) {
          assertRuntimeIdentity(result, role);
        }
        return result;
      } catch (error) {
        totalFailureAttempts += 1;
        const failure = runtimeAttemptFailure(model, error);
        if (
          durableAttempts.length <
          DURABLE_RUNTIME_FAILURE_ATTEMPT_LIMIT
        ) {
          durableAttempts.push(failure.durable);
        }
        if (aggregateFull) {
          aggregateOmittedAttempts += 1;
        } else {
          const appended = appendFailureAggregate(
            aggregate,
            failure.rendered,
            aggregateHasEntries,
          );
          aggregate = appended.text;
          aggregateFull = appended.full;
          aggregateHasEntries = true;
        }
      }
    }
    const message = reportOmittedFailureAttempts(
      aggregate,
      aggregateOmittedAttempts,
    );
    throw new RuntimeModelsExhaustedError(
      message,
      makeDurableRuntimeFailureSummary(
        durableAttempts,
        totalFailureAttempts,
        aggregateFull,
      ),
    );
  }

  async markPrOpened(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    return this.store.applyEvent(run, "PR_OPENED", "user");
  }

  async receiveReviewComment(runId: string, comment: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    await this.store.writeArtifact(run, "07-review-comment.md", comment);
    await this.store.applyEvent(run, "REVIEW_COMMENT_RECEIVED", "github");
    return this.runUntilBlocked(run.id);
  }

  async resumeHumanReview(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    return this.store.applyEvent(run, "HUMAN_RESUME", "user");
  }

  private async assertExactCurrentHeadGate(
    run: RunRecord,
    gate: "merge-ready" | "complete",
  ): Promise<string> {
    const label = gate === "merge-ready" ? "Merge-ready" : "Complete";
    if (run.revalidation) {
      throw new Error(`${label} requires revalidation to finish for the current HEAD.`);
    }
    if (
      !run.workspace ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(run.workspace.headSha)
    ) {
      throw new Error(`${label} requires a known exact workspace HEAD.`);
    }
    if (!run.config.policy.useIsolatedWorktree || !run.workspace.worktreePath) {
      throw new Error(`${label} requires an isolated MASWE-managed worktree.`);
    }

    const canonicalWorktreePath = path.resolve(externalWorktreePath(run.repositoryPath, run.id));
    if (run.workspace.worktreePath !== canonicalWorktreePath) {
      throw new Error(`${label} requires the canonical MASWE-managed worktree path.`);
    }
    const canonicalBranch = `maswe/${run.id}`;
    if (run.workspace.branch !== canonicalBranch) {
      throw new Error(`${label} requires the canonical MASWE-managed branch ${canonicalBranch}.`);
    }

    const registrations = await listGitWorktreeRegistrations(run.repositoryPath);
    const pathRegistration = registrations.find(
      (registration) => registration.worktreePath === canonicalWorktreePath,
    );
    if (!pathRegistration) {
      throw new Error(`${label} requires a registered canonical MASWE-managed worktree.`);
    }
    if (pathRegistration.prunable) {
      throw new Error(`${label} rejected the prunable canonical worktree registration.`);
    }
    const branchRegistration = registrations.find(
      (registration) => registration.branch === canonicalBranch,
    );
    if (
      pathRegistration.branch !== canonicalBranch ||
      branchRegistration?.worktreePath !== canonicalWorktreePath
    ) {
      throw new Error(`${label} requires the registered path and branch to identify the same worktree.`);
    }
    const expectedHeadSha = run.workspace.headSha;
    if (pathRegistration.headSha !== expectedHeadSha) {
      throw new Error(
        `${label} rejected: registered HEAD ${pathRegistration.headSha} does not match recorded workspace HEAD ${expectedHeadSha}.`,
      );
    }
    await this.assertExactGitPublicationState(run, expectedHeadSha, label);
    const headSha = expectedHeadSha;
    if (run.github && run.github.headSha !== headSha) {
      throw new Error(
        `${label} rejected: associated GitHub HEAD ${run.github.headSha} does not match workspace HEAD ${headSha}.`,
      );
    }
    if (
      (!run.evidence?.quality?.passed || run.evidence.quality.headSha !== headSha)
    ) {
      throw new Error(`${label} requires present, passing quality evidence for the current HEAD.`);
    }
    if (
      (!run.evidence?.verification?.passed || run.evidence.verification.headSha !== headSha)
    ) {
      throw new Error(
        `${label} requires present, passing verification evidence for the current HEAD.`,
      );
    }
    if (
      gate === "complete" &&
      (!run.evidence?.mergeReady?.passed || run.evidence.mergeReady.headSha !== headSha)
    ) {
      throw new Error("Complete requires current, passing merge-ready evidence for the current HEAD.");
    }
    await this.assertExactGitPublicationState(run, headSha, label);
    return headSha;
  }

  private async withFinalGatePublicationFence(
    runId: string,
    gate: "merge-ready" | "complete",
    publish: (run: RunRecord, headSha: string) => Promise<RunRecord>,
  ): Promise<RunRecord> {
    const loaded = await this.store.load(runId);
    const initial = await this.preflightCommittedAssociationHead(loaded);
    return withRunMutationFence(
      initial.repositoryPath,
      runId,
      "publication",
      async (lease) => {
        const authoritative = await this.store.load(runId);
        if (
          authoritative.repositoryPath !== initial.repositoryPath ||
          authoritative.version !== initial.version
        ) {
          throw new Error(
            `Run ${runId} changed before ${gate} publication: expected version ${initial.version}, authoritative ${authoritative.version}`,
          );
        }
        if (gate === "complete" && authoritative.state !== "MERGE_READY") {
          throw new Error(`complete requires MERGE_READY, currently ${authoritative.state}`);
        }
        await this.afterRunMutationReload?.(gate, authoritative);
        await lease.assertNoQueuedTargetMutation();
        const headSha = await this.assertExactCurrentHeadGate(authoritative, gate);
        return publish(authoritative, headSha);
      },
    );
  }

  async markMergeReady(runId: string): Promise<RunRecord> {
    return this.withFinalGatePublicationFence(runId, "merge-ready", async (run, headSha) => {
      run.evidence = {
        ...(run.evidence ?? {}),
        mergeReady: {
          headSha,
          passed: true,
          at: new Date().toISOString(),
        },
      };
      return this.store.applyEvent(run, "MARK_MERGE_READY", "user", {
        headSha,
      });
    });
  }

  async complete(runId: string): Promise<RunRecord> {
    const completed = await this.withFinalGatePublicationFence(
      runId,
      "complete",
      async (run, headSha) => this.store.applyEvent(run, "COMPLETE", "user", {
        headSha,
        mergeReadySha: headSha,
      }),
    );
    return this.finalizeTerminal(completed);
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    const cancelled = await this.store.applyEvent(run, "CANCEL", "user");
    return this.finalizeTerminal(cancelled);
  }

  private async reconcileFailedRevalidationTarget(prior: RunRecord): Promise<RunRecord> {
    let snapshot = prior;
    for (let attempt = 0; attempt < REVALIDATION_STABILITY_ATTEMPTS; attempt += 1) {
      if (!snapshot.revalidation) return snapshot;
      const observed = structuredClone(snapshot);
      const observedHeadSha = await this.observeRevalidationWorkspace(observed);
      if (!observedHeadSha || !observed.workspace) {
        throw new Error(`Run ${prior.id} has no exact retry revalidation workspace`);
      }
      const exactWorkspace = await reconcileRetryWorkspace(this.cwd, observed);
      if (!exactWorkspace) {
        throw new Error(`Run ${prior.id} has no exact retry revalidation workspace`);
      }
      const source = snapshot.github ? "github" : "local-workspace";
      const requiredHeadSha = snapshot.github?.headSha ?? observedHeadSha;
      const workspaceForRoute =
        snapshot.revalidation.requestedHeadSha === requiredHeadSha &&
        exactWorkspace.headSha !== requiredHeadSha
          ? undefined
          : exactWorkspace;

      let routed: RunRecord;
      try {
        routed = await new RevalidationService(this.store).route(prior.id, {
          source,
          previousHeadSha: snapshot.revalidation.requestedHeadSha,
          requestedHeadSha: requiredHeadSha,
          expectedRunVersion: snapshot.version,
          actor: source === "github" ? "github-app" : "local-runner",
          ...(workspaceForRoute ? { observedWorkspace: workspaceForRoute } : {}),
        });
      } catch (error) {
        if (!(error instanceof RevalidationOptimisticConflictError)) throw error;
        snapshot = await this.store.load(prior.id);
        continue;
      }

      const authoritative = await this.store.load(prior.id);
      if (!this.recordsEqual(authoritative, routed)) {
        snapshot = authoritative;
        continue;
      }
      if (!authoritative.revalidation) return authoritative;
      const stableRequiredHeadSha = authoritative.github?.headSha ?? observedHeadSha;
      if (authoritative.revalidation.requestedHeadSha !== stableRequiredHeadSha) {
        snapshot = authoritative;
        continue;
      }
      return authoritative;
    }
    throw new Error(`Run ${prior.id} retry revalidation target did not stabilize`);
  }

  async retryFromFailed(runId: string): Promise<RunRecord> {
    let prior = await this.store.load(runId);
    if (prior.state !== "FAILED" || !prior.failure?.resumeState || !prior.failure) {
      throw new Error("retry requires a FAILED run with failure.resumeState");
    }
    prior = await this.reconcileFailedRevalidationTarget(prior);
    const resumeState = prior.failure?.resumeState;
    if (prior.state !== "FAILED" || !resumeState || !prior.failure) {
      throw new Error("retry requires a FAILED run with failure.resumeState");
    }
    const previousFailure = structuredClone(prior.failure);
    const priorEventIds = new Set(prior.events.map((event) => event.id));
    const retryFence = this.captureOptionalRevalidationFence(prior);
    const candidate = structuredClone(prior);
    const workspace = await reconcileRetryWorkspace(this.cwd, candidate);
    if (workspace) candidate.workspace = workspace;
    else delete candidate.workspace;
    delete candidate.failure;
    await this.beforeRetryPublication?.(candidate);
    await this.assertOptionalRevalidationFence(prior, retryFence);
    const publicationCandidate = structuredClone(candidate);

    let resumed: RunRecord;
    try {
      resumed = await this.store.applyEvent(candidate, "RETRY_FROM_FAILED", "user", {
        resumeState,
        previousFailure,
      });
    } catch (error) {
      const observed = await this.store.load(runId);
      const newEvents = observed.events.filter((event) => !priorEventIds.has(event.id));
      const retryEvent = newEvents.length === 1 ? newEvents[0] : undefined;
      const historicalPrefixExact =
        observed.events.length === prior.events.length + 1 &&
        this.recordsEqual(
          { ...prior, events: observed.events.slice(0, prior.events.length) },
          prior,
        );
      const expected = structuredClone(publicationCandidate);
      expected.state = resumeState;
      expected.version = observed.version;
      expected.updatedAt = observed.updatedAt;
      expected.events = observed.events;
      const completePublication =
        observed.version === prior.version + 1 &&
        areCanonicalFileStoreTimestamps(
          prior.updatedAt,
          retryEvent?.at,
          observed.updatedAt,
        ) &&
        historicalPrefixExact &&
        observed.failure === undefined &&
        retryEvent?.type === "RETRY_FROM_FAILED" &&
        retryEvent.actor === "user" &&
        retryEvent.from === "FAILED" &&
        retryEvent.to === resumeState &&
        this.recordsEqual(retryEvent.details, { resumeState, previousFailure }) &&
        this.recordsEqual(observed, expected);
      if (completePublication) {
        resumed = observed;
      } else {
        const unchangedPrior = this.recordsEqual(observed, prior);
        const oneStepConflict = structuredClone(prior);
        oneStepConflict.version = prior.version + 1;
        oneStepConflict.updatedAt = observed.updatedAt;
        const validOneStepConflict =
          observed.version === prior.version + 1 &&
          areCanonicalFileStoreTimestamps(
            prior.updatedAt,
            undefined,
            observed.updatedAt,
          ) &&
          this.recordsEqual(observed, oneStepConflict);
        const originalRetryRemains =
          newEvents.length === 0 &&
          observed.state === "FAILED" &&
          this.recordsEqual(observed.failure, previousFailure) &&
          (unchangedPrior || validOneStepConflict);
        if (originalRetryRemains) throw error;
        throw new Error(
          "Retry publication outcome is inconsistent: authoritative state is neither the original retryable FAILED record nor one complete retry publication.",
          { cause: error },
        );
      }
    }

    if (resumed.state === "CREATED") {
      resumed = await this.bootstrapCreatedRun(resumed.id);
    }
    return this.runUntilBlocked(resumed.id);
  }

  async supersede(runId: string): Promise<RunRecord> {
    const existing = await this.store.load(runId);
    if (existing.supersededBy) {
      throw new Error(`Run ${runId} was already superseded by ${existing.supersededBy}`);
    }
    const replacement = await this.createPlannedRun(
      existing.title,
      existing.request,
      existing.config,
      { supersedes: existing.id },
    );
    existing.supersededBy = replacement.id;
    if (!isTerminal(existing.state)) {
      existing.failure = {
        message: `Superseded by ${replacement.id}`,
        at: new Date().toISOString(),
        resumeState: existing.state as WorkflowState,
      };
      const cancelled = await this.store.applyEvent(existing, "CANCEL", "user", {
        reason: "superseded",
        supersededBy: replacement.id,
      });
      await this.finalizeTerminal(cancelled);
    } else {
      await this.store.save(existing);
      await this.finalizeTerminal(existing);
    }
    await this.bootstrapCreatedRun(replacement.id);
    return this.runUntilBlocked(replacement.id);
  }
}
