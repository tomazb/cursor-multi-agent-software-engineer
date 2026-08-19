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
import { gitRevParse, isGitWorkspaceClean } from "./git-snapshot.ts";
import {
  assertChangeScope,
  assertExpectedBranch,
  assertWorkingTreeScope,
  cleanupRunWorkspace,
  createDeterministicCommit,
  invalidateStaleEvidence,
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
}

interface ActiveRevalidationPreflight {
  run: RunRecord;
  headSha: string | undefined;
  alignmentError?: Error;
}

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
    if (!this.config.policy.allowDirtyWorkspace && !(await isGitWorkspaceClean(this.cwd))) {
      throw new Error("Workspace is dirty. Commit, stash, or set policy.allowDirtyWorkspace=true.");
    }
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
      actor: "local-runner",
      observedWorkspace: observed.workspace!,
    });
  }

  private async preflightActiveRevalidation(
    run: RunRecord,
  ): Promise<ActiveRevalidationPreflight> {
    if (!run.revalidation) {
      return { run, headSha: (await this.syncWorkspace(run)) ?? run.workspace?.headSha };
    }
    const observedHeadSha = await this.observeRevalidationWorkspace(run);
    if (!observedHeadSha || !run.workspace) {
      throw new Error(`Run ${run.id} has no observable revalidation workspace HEAD`);
    }
    const source = run.github ? "github" : "local-workspace";
    const requiredHeadSha = run.github?.headSha ?? observedHeadSha;
    const previousRequestedHeadSha = run.revalidation.requestedHeadSha;
    const routed = await new RevalidationService(this.store).route(run.id, {
      source,
      previousHeadSha: previousRequestedHeadSha,
      requestedHeadSha: requiredHeadSha,
      actor: source === "github" ? "github-app" : "local-runner",
      observedWorkspace: run.workspace,
    });
    if (observedHeadSha !== requiredHeadSha) {
      return {
        run: routed,
        headSha: observedHeadSha,
        alignmentError: new Error(
          `Required revalidation target ${requiredHeadSha} does not match workspace HEAD ${observedHeadSha}`,
        ),
      };
    }
    return { run: routed, headSha: observedHeadSha };
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

  async advance(runId: string): Promise<RunRecord> {
    let run = await this.store.load(runId);
    try {
      this.assertWithinBudget(run);
      let headSha: string | undefined;
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
        case "BUILDING": {
          run.counters.buildVerifyCycles += 1;
          if (run.counters.buildVerifyCycles > run.config.policy.maxBuildVerifyCycles) {
            return this.failRun(run, "Maximum build/verify cycles exceeded.");
          }
          return await this.executeBuilderWithPublish(run, headSha);
        }
        case "CI_RUNNING": {
          const workdir = workingDirectoryFor(run);
          const evaluatedSha =
            (await refreshWorkspaceHead(run)) ?? headSha ?? "not-a-git-repository";
          if (evaluatedSha !== "not-a-git-repository" && !(await isGitWorkspaceClean(workdir))) {
            throw new Error(`CI requires a clean worktree at ${evaluatedSha}`);
          }
          const report = await runQualityChecks(workdir, run.config.quality.commands, {
            timeoutMs: run.config.policy.commandTimeoutMs,
          });
          if (evaluatedSha !== "not-a-git-repository") {
            if (!(await isGitWorkspaceClean(workdir))) {
              throw new Error("Quality commands left the worktree dirty; evidence is not trustworthy.");
            }
            const afterQualitySha = await gitRevParse(workdir);
            if (afterQualitySha !== evaluatedSha) {
              throw new Error(
                `HEAD moved during quality commands (before ${evaluatedSha}, after ${afterQualitySha})`,
              );
            }
          }
          await this.store.writeArtifact(run, "05-quality-report.md", renderQualityReport(report));
          const fence = this.captureOptionalRevalidationFence(run);
          const accepted = report.passed || !run.config.gates.requireCiPass;
          await this.assertOptionalRevalidationFence(run, fence);
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
        }
        case "VERIFYING": {
          const workdir = workingDirectoryFor(run);
          const evaluatedSha =
            (await refreshWorkspaceHead(run)) ?? headSha ?? "not-a-git-repository";
          if (evaluatedSha !== "not-a-git-repository" && !(await isGitWorkspaceClean(workdir))) {
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
              throw new Error("Verifier left the worktree dirty; evidence is not trustworthy.");
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
          await this.assertOptionalRevalidationFence(run, fence);
          this.bindEvidence(run, "verification", evaluatedSha, passed);
          const successEvent =
            run.revalidation?.returnState === "PR_READY"
              ? "VERIFY_PASSED"
              : run.revalidation?.returnState === "PR_REVIEW"
                ? "VERIFY_PASSED_AFTER_REVIEW"
                : run.counters.commentResolutionCycles > 0
                  ? "VERIFY_PASSED_AFTER_REVIEW"
                  : "VERIFY_PASSED";
          if (accepted && run.revalidation) {
            await this.assertOptionalRevalidationFence(run, fence);
            delete run.revalidation;
          }
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
    } catch (error) {
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
      await this.assertOptionalRevalidationFence(run, fence);
      const committed = await createDeterministicCommit(workdir, "maswe: builder changes", {
        allowedPathGlobs: run.config.policy.allowedPathGlobs,
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
    }

    const evaluatedHeadSha = outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
    await this.assertOptionalRevalidationFence(run, fence);
    return this.store.applyEvent(run, "BUILD_COMPLETED", "builder", {
      ...runtimeEventIdentityDetails(result),
      marker: markers.marker,
      ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
      ...(evaluatedHeadSha
        ? { headSha: evaluatedHeadSha, outputHeadSha: evaluatedHeadSha }
        : {}),
    });
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
      await this.assertOptionalRevalidationFence(run, fence);
      const committed = await createDeterministicCommit(workdir, "maswe: resolve review comment", {
        allowedPathGlobs: run.config.policy.allowedPathGlobs,
      });
      if (!(await isGitWorkspaceClean(workdir))) {
        throw new Error("worktree remained dirty after deterministic commit");
      }
      outputHeadSha = committed.headSha;
      run.workspace.headSha = committed.headSha;
      invalidateStaleEvidence(run, committed.headSha);
    }

    const evaluatedHeadSha = outputHeadSha ?? beforeSha ?? run.workspace?.headSha;
    await this.assertOptionalRevalidationFence(run, fence);
    return this.store.applyEvent(run, "RESOLUTION_COMPLETED", "prResolver", {
      ...runtimeEventIdentityDetails(result),
      marker: markers.marker,
      ...(beforeSha ? { inputHeadSha: beforeSha } : {}),
      ...(evaluatedHeadSha
        ? { headSha: evaluatedHeadSha, outputHeadSha: evaluatedHeadSha }
        : {}),
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
      const priorRecordIsUnchanged = JSON.stringify(observed) === JSON.stringify(prior);
      if (priorRecordIsUnchanged) throw error;

      const completePublication =
        JSON.stringify(observed) === JSON.stringify(candidate) &&
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

  async markMergeReady(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    const previousVerificationSha = run.evidence?.verification?.headSha;
    const headSha = (await this.syncWorkspace(run)) ?? run.workspace?.headSha;
    const workdir = workingDirectoryFor(run);
    if (run.workspace && run.workspace.baseSha !== "not-a-git-repository") {
      if (!(await isGitWorkspaceClean(workdir))) {
        throw new Error("Merge-ready requires a clean worktree with fresh verification evidence.");
      }
    }
    if (
      previousVerificationSha &&
      (!run.evidence?.verification || run.evidence.verification.headSha !== headSha)
    ) {
      throw new Error(
        `Verification evidence is stale for head SHA ${headSha}; re-run CI and verification before merge-ready.`,
      );
    }
    if (
      run.config.gates.requireVerifierPass &&
      (!run.evidence?.verification?.passed ||
        run.evidence.verification.headSha !== run.workspace?.headSha)
    ) {
      throw new Error(
        "Merge-ready requires fresh verification evidence bound to the current head SHA.",
      );
    }
    if (
      run.config.gates.requireCiPass &&
      (!run.evidence?.quality?.passed || run.evidence.quality.headSha !== run.workspace?.headSha)
    ) {
      throw new Error("Merge-ready requires present, passing quality evidence for the current HEAD.");
    }
    const mergeReadySha = run.workspace?.headSha;
    if (mergeReadySha && mergeReadySha !== "not-a-git-repository") {
      run.evidence = {
        ...(run.evidence ?? {}),
        mergeReady: {
          headSha: mergeReadySha,
          passed: true,
          at: new Date().toISOString(),
        },
      };
    }
    return this.store.applyEvent(run, "MARK_MERGE_READY", "user", {
      ...(mergeReadySha ? { headSha: mergeReadySha } : {}),
    });
  }

  async complete(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    if (run.state !== "MERGE_READY") {
      throw new Error(`complete requires MERGE_READY, currently ${run.state}`);
    }
    const mergeReadySha =
      run.evidence?.mergeReady?.headSha ??
      [...run.events].reverse().find((event) => event.type === "MARK_MERGE_READY")?.details?.headSha;
    const headSha = await this.syncWorkspace(run);
    const workdir = workingDirectoryFor(run);
    if (run.workspace && run.workspace.baseSha !== "not-a-git-repository") {
      if (!(await isGitWorkspaceClean(workdir))) {
        throw new Error("Complete requires a clean worktree matching merge-ready evidence.");
      }
      if (!headSha || !mergeReadySha || headSha !== mergeReadySha) {
        throw new Error(
          `Complete rejected: HEAD ${headSha ?? "(unknown)"} does not match merge-ready SHA ${String(mergeReadySha)}.`,
        );
      }
      if (
        run.config.gates.requireCiPass &&
        (!run.evidence?.quality?.passed || run.evidence.quality.headSha !== headSha)
      ) {
        throw new Error("Complete requires present, passing quality evidence for the current HEAD.");
      }
      if (
        run.config.gates.requireVerifierPass &&
        (!run.evidence?.verification?.passed || run.evidence.verification.headSha !== headSha)
      ) {
        throw new Error(
          "Complete requires present, passing verification evidence for the current HEAD.",
        );
      }
    }
    const completed = await this.store.applyEvent(run, "COMPLETE", "user", {
      ...(headSha ? { headSha } : {}),
      ...(mergeReadySha ? { mergeReadySha } : {}),
    });
    return this.finalizeTerminal(completed);
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    const cancelled = await this.store.applyEvent(run, "CANCEL", "user");
    return this.finalizeTerminal(cancelled);
  }

  private async reconcileFailedRevalidationTarget(prior: RunRecord): Promise<RunRecord> {
    if (!prior.revalidation) return prior;
    const observed = structuredClone(prior);
    const observedHeadSha = await this.observeRevalidationWorkspace(observed);
    if (!observedHeadSha || !observed.workspace) {
      throw new Error(`Run ${prior.id} has no exact retry revalidation workspace`);
    }
    const exactWorkspace = await reconcileRetryWorkspace(this.cwd, observed);
    if (!exactWorkspace) {
      throw new Error(`Run ${prior.id} has no exact retry revalidation workspace`);
    }
    const source = prior.github ? "github" : "local-workspace";
    const requiredHeadSha = prior.github?.headSha ?? observedHeadSha;
    await new RevalidationService(this.store).route(prior.id, {
      source,
      previousHeadSha: prior.revalidation.requestedHeadSha,
      requestedHeadSha: requiredHeadSha,
      actor: source === "github" ? "github-app" : "local-runner",
      observedWorkspace: exactWorkspace,
    });
    return this.store.load(prior.id);
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
    const candidate = structuredClone(prior);
    const workspace = await reconcileRetryWorkspace(this.cwd, candidate);
    if (workspace) candidate.workspace = workspace;
    else delete candidate.workspace;
    delete candidate.failure;
    await this.beforeRetryPublication?.(candidate);
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
