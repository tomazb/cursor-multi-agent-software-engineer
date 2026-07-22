import type { AgentRuntime, RoleId, RunRecord, RuntimeResult, WorkflowState } from "./domain.ts";
import { buildCommentClassifierPrompt, buildRolePrompt } from "./prompt-builder.ts";
import { isGitWorkspaceClean } from "./git-snapshot.ts";
import {
  assertChangeScope,
  createDeterministicCommit,
  ensureRunWorkspace,
  workingDirectoryFor,
} from "./git-workspace.ts";
import { validateRoleMarkers } from "./markers.ts";
import { renderQualityReport, runQualityChecks } from "./quality.ts";
import { isHumanGate, isTerminal } from "./state-machine.ts";
import { FileRunStore, type RunStore } from "./store.ts";
import type { MasweConfig } from "./domain.ts";

function ensureSuccess(result: RuntimeResult, role: RoleId): void {
  if (result.status !== "finished") {
    throw new Error(`${role} failed: ${result.output || "No output was produced."}`);
  }
}

function verifierPassed(output: string): boolean {
  return /VERDICT\s*:\s*PASS\b/i.test(output);
}

function commentIsInScope(output: string): boolean {
  return /SCOPE\s*:\s*IN_SCOPE\b/i.test(output);
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

  async start(title: string, request: string): Promise<RunRecord> {
    if (!this.config.policy.allowDirtyWorkspace && !(await isGitWorkspaceClean(this.cwd))) {
      throw new Error("Workspace is dirty. Commit, stash, or set policy.allowDirtyWorkspace=true.");
    }
    const run = await this.store.create(title, request, this.config);
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

  async advance(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    try {
      this.assertWithinBudget(run);
      switch (run.state) {
        case "BRAINSTORMING": {
          const completed = await this.executeRole(
            run,
            "brainstormer",
            "02-brainstorm.md",
            "BRAINSTORM_COMPLETED",
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
          const completed = await this.executeRole(
            run,
            "builder",
            "04-builder-report.md",
            "BUILD_COMPLETED",
          );
          await this.commitBuilderChanges(completed);
          return completed;
        }
        case "CI_RUNNING": {
          const workdir = workingDirectoryFor(run);
          const report = await runQualityChecks(workdir, run.config.quality.commands, {
            timeoutMs: run.config.policy.commandTimeoutMs,
          });
          await this.store.writeArtifact(run, "05-quality-report.md", renderQualityReport(report));
          const accepted = report.passed || !run.config.gates.requireCiPass;
          return this.store.applyEvent(
            run,
            accepted ? "CI_PASSED" : "CI_FAILED",
            "quality-runner",
            { passed: report.passed, required: run.config.gates.requireCiPass },
          );
        }
        case "VERIFYING": {
          const prompt = await buildRolePrompt("verifier", run, this.store);
          const result = await this.executeAgent(run, "verifier", prompt);
          const markers = validateRoleMarkers("verifier", result.output);
          if (!markers.ok) throw new Error(markers.message);
          await this.store.writeArtifact(run, "06-verification-report.md", result.output);
          const passed = verifierPassed(result.output);
          if (!passed && run.config.gates.requireVerifierPass) {
            await this.store.writeArtifact(
              run,
              "10-verifier-defects.md",
              extractVerifierDefects(result.output),
            );
          }
          const accepted = passed || !run.config.gates.requireVerifierPass;
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
          const markers = validateRoleMarkers("prResolver", result.output, { mode: "classify" });
          if (!markers.ok) throw new Error(markers.message);
          await this.store.writeArtifact(run, "08-comment-classification.md", result.output);
          return this.store.applyEvent(
            run,
            commentIsInScope(result.output) ? "COMMENT_IN_SCOPE" : "COMMENT_OUT_OF_SCOPE",
            "pr-comment-classifier",
          );
        }
        case "RESOLVING": {
          run.counters.commentResolutionCycles += 1;
          if (run.counters.commentResolutionCycles > run.config.policy.maxCommentResolutionCycles) {
            return this.failRun(run, "Maximum PR comment resolution cycles exceeded.");
          }
          const completed = await this.executeRole(
            run,
            "prResolver",
            "09-resolution-report.md",
            "RESOLUTION_COMPLETED",
          );
          await this.commitBuilderChanges(completed, "maswe: resolve review comment");
          return completed;
        }
        default:
          throw new Error(`State ${run.state} requires a user or integration event.`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.failRun(run, message);
    }
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
      return this.store.applyEvent(run, "FAIL", "orchestrator", {
        reason: message,
        ...(resumeState ? { resumeState } : {}),
      });
    }
    return run;
  }

  private async commitBuilderChanges(
    run: RunRecord,
    message = "maswe: builder changes",
  ): Promise<void> {
    const workdir = workingDirectoryFor(run);
    if (!run.workspace || run.workspace.baseSha === "not-a-git-repository") return;
    try {
      const committed = await createDeterministicCommit(workdir, message, {
        allowedPathGlobs: run.config.policy.allowedPathGlobs,
      });
      if (committed.files.length > 0) {
        await assertChangeScope(workdir, run.workspace.baseSha, run.config.policy.allowedPathGlobs);
        run.workspace.headSha = committed.headSha;
        await this.store.save(run);
      }
    } catch (error) {
      // No git user config or empty commit is fine for non-git / clean workspaces.
      const text = error instanceof Error ? error.message : String(error);
      if (/Change-scope violation/i.test(text)) throw error;
    }
  }

  private async executeRole(
    run: RunRecord,
    role: RoleId,
    artifactName: string,
    successEvent:
      | "BRAINSTORM_COMPLETED"
      | "DESIGN_COMPLETED"
      | "BUILD_COMPLETED"
      | "RESOLUTION_COMPLETED",
  ): Promise<RunRecord> {
    const prompt = await buildRolePrompt(role, run, this.store);
    const result = await this.executeAgent(run, role, prompt);
    const markers = validateRoleMarkers(role, result.output);
    if (!markers.ok) throw new Error(markers.message);
    await this.store.writeArtifact(run, artifactName, result.output);
    return this.store.applyEvent(run, successEvent, role, {
      requestedModel: result.requestedModel,
      actualModel: result.actualModel,
      agentId: result.agentId,
      runtimeRunId: result.runId,
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
    return this.store.applyEvent(run, "MARK_MERGE_READY", "user");
  }

  async complete(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    return this.store.applyEvent(run, "COMPLETE", "user");
  }

  async cancel(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    return this.store.applyEvent(run, "CANCEL", "user");
  }

  async retryFromFailed(runId: string): Promise<RunRecord> {
    const run = await this.store.load(runId);
    const resumeState = run.failure?.resumeState;
    if (run.state !== "FAILED" || !resumeState) {
      throw new Error("retry requires a FAILED run with failure.resumeState");
    }
    const previousFailure = run.failure;
    delete run.failure;
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
      await this.store.applyEvent(existing, "CANCEL", "user", {
        reason: "superseded",
        supersededBy: replacement.id,
      });
    } else {
      await this.store.save(existing);
    }
    await this.store.applyEvent(replacement, "START", "user", { supersedes: existing.id });
    return this.runUntilBlocked(replacement.id);
  }
}
