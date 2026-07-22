import type { AgentRuntime, RoleId, RunRecord, RuntimeResult, WorkflowState } from "./domain.ts";
import { buildCommentClassifierPrompt, buildRolePrompt } from "./prompt-builder.ts";
import { gitRevParse, isGitWorkspaceClean } from "./git-snapshot.ts";
import {
  assertChangeScope,
  assertExpectedBranch,
  assertWorkingTreeScope,
  cleanupRunWorkspace,
  createDeterministicCommit,
  ensureRunWorkspace,
  invalidateStaleEvidence,
  refreshWorkspaceHead,
  restoreRunWorkspace,
  workingDirectoryFor,
} from "./git-workspace.ts";
import { parseRoleMarker } from "./markers.ts";
import { resolveProjectModels } from "./model-resolution.ts";
import { renderQualityReport, runQualityChecks } from "./quality.ts";
import { isHumanGate, isTerminal } from "./state-machine.ts";
import { FileRunStore, type RunStore } from "./store.ts";
import type { MasweConfig } from "./domain.ts";
import path from "node:path";

function ensureSuccess(result: RuntimeResult, role: RoleId): void {
  if (result.status !== "finished") {
    throw new Error(`${role} failed: ${result.output || "No output was produced."}`);
  }
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

export class Orchestrator {
  readonly store: RunStore;
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly runtime: AgentRuntime;

  constructor(cwd: string, config: MasweConfig, runtime: AgentRuntime, store?: RunStore) {
    this.cwd = cwd;
    this.config = config;
    this.runtime = runtime;
    this.store = store ?? new FileRunStore(cwd);
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
    const run = await this.store.create(title, request, resolvedConfig);
    run.workspace = await ensureRunWorkspace(this.cwd, run);
    await this.store.save(run);
    await this.store.applyEvent(run, "START", "user");
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
    while (!isTerminal(run.state) && !isHumanGate(run.state) && iterations < 20) {
      run = await this.advance(run.id);
      iterations += 1;
    }
    if (iterations >= 20) throw new Error("Workflow exceeded 20 automatic transitions.");
    return run;
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
    const run = await this.store.load(runId);
    try {
      this.assertWithinBudget(run);
      const headSha = (await this.syncWorkspace(run)) ?? run.workspace?.headSha;
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
          const accepted = report.passed || !run.config.gates.requireCiPass;
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
          const accepted = passed || !run.config.gates.requireVerifierPass;
          this.bindEvidence(run, "verification", evaluatedSha, passed);
          const successEvent =
            run.counters.commentResolutionCycles > 0
              ? "VERIFY_PASSED_AFTER_REVIEW"
              : "VERIFY_PASSED";
          return this.store.applyEvent(
            run,
            accepted ? successEvent : "VERIFY_FAILED",
            "verifier",
            {
              passed,
              required: run.config.gates.requireVerifierPass,
              requestedModel: result.requestedModel,
              actualModel: result.actualModel,
              agentId: result.agentId,
              runtimeRunId: result.runId,
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
      const message = error instanceof Error ? error.message : String(error);
      return this.failRun(run, message);
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

    return this.store.applyEvent(run, "BUILD_COMPLETED", "builder", {
      requestedModel: result.requestedModel,
      actualModel: result.actualModel,
      agentId: result.agentId,
      runtimeRunId: result.runId,
      marker: markers.marker,
      ...(beforeSha ? { inputHeadSha: beforeSha, headSha: beforeSha } : {}),
      ...(outputHeadSha ? { outputHeadSha } : {}),
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

    return this.store.applyEvent(run, "RESOLUTION_COMPLETED", "prResolver", {
      requestedModel: result.requestedModel,
      actualModel: result.actualModel,
      agentId: result.agentId,
      runtimeRunId: result.runId,
      marker: markers.marker,
      ...(beforeSha ? { inputHeadSha: beforeSha, headSha: beforeSha } : {}),
      ...(outputHeadSha ? { outputHeadSha } : {}),
    });
  }

  private async failRun(run: RunRecord, message: string): Promise<RunRecord> {
    const resumeState = isTerminal(run.state) ? undefined : run.state;
    run.failure = {
      message,
      at: new Date().toISOString(),
      ...(resumeState ? { resumeState } : {}),
    };
    await this.store.save(run);
    if (!isTerminal(run.state)) {
      const failed = await this.store.applyEvent(run, "FAIL", "orchestrator", {
        reason: message,
        ...(resumeState ? { resumeState } : {}),
      });
      return this.finalizeTerminal(failed);
    }
    return this.finalizeTerminal(run);
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
      requestedModel: result.requestedModel,
      actualModel: result.actualModel,
      agentId: result.agentId,
      runtimeRunId: result.runId,
      marker: markers.marker,
      ...(evaluatedSha ? { headSha: evaluatedSha } : {}),
    });
  }

  private async executeAgent(
    run: RunRecord,
    role: RoleId,
    prompt: string,
    roleOverride?: RunRecord["config"]["roles"][RoleId],
  ): Promise<RuntimeResult> {
    const configured = roleOverride ?? run.config.roles[role];
    const candidates = run.config.policy.rejectModelFallback
      ? [configured.model]
      : [configured.model, ...(configured.fallbackModels ?? [])];
    const failures: string[] = [];
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
        ensureSuccess(result, role);
        if (
          run.config.policy.rejectModelFallback &&
          result.actualModel &&
          result.actualModel !== result.requestedModel
        ) {
          throw new Error(
            `${role} requested ${result.requestedModel}, but runtime reported ${result.actualModel}.`,
          );
        }
        return result;
      } catch (error) {
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(`${role} failed for all configured models: ${failures.join(" | ")}`);
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

  async retryFromFailed(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    const resumeState = run.failure?.resumeState;
    if (run.state !== "FAILED" || !resumeState) {
      throw new Error("retry requires a FAILED run with failure.resumeState");
    }
    const previousFailure = run.failure;
    delete run.failure;
    if (run.config.policy.useIsolatedWorktree) {
      run.workspace = await restoreRunWorkspace(this.cwd, run);
      await this.store.save(run);
    }
    await this.store.applyEvent(run, "RETRY_FROM_FAILED", "user", {
      resumeState,
      previousFailure,
    });
    return this.runUntilBlocked(run.id);
  }

  async supersede(runId: string): Promise<RunRecord> {
    const existing = await this.store.load(runId);
    if (existing.supersededBy) {
      throw new Error(`Run ${runId} was already superseded by ${existing.supersededBy}`);
    }
    const replacement = await this.store.create(
      existing.title,
      existing.request,
      existing.config,
    );
    replacement.supersedes = existing.id;
    replacement.workspace = await ensureRunWorkspace(this.cwd, replacement);
    await this.store.save(replacement);
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
    await this.store.applyEvent(replacement, "START", "user", { supersedes: existing.id });
    return this.runUntilBlocked(replacement.id);
  }
}
