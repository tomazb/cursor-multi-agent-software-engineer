import type { AgentRuntime, RoleId, RunRecord, RuntimeResult } from "./domain.ts";
import { buildCommentClassifierPrompt, buildRolePrompt } from "./prompt-builder.ts";
import { isGitWorkspaceClean } from "./git-snapshot.ts";
import { renderQualityReport, runQualityChecks } from "./quality.ts";
import { isHumanGate, isTerminal } from "./state-machine.ts";
import { FileRunStore } from "./store.ts";
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

export class Orchestrator {
  readonly store: FileRunStore;
  private readonly cwd: string;
  private readonly config: MasweConfig;
  private readonly runtime: AgentRuntime;

  constructor(cwd: string, config: MasweConfig, runtime: AgentRuntime, store?: FileRunStore) {
    this.cwd = cwd;
    this.config = config;
    this.runtime = runtime;
    this.store = store ?? new FileRunStore(cwd);
  }

  async start(title: string, request: string): Promise<RunRecord> {
    if (!this.config.policy.allowDirtyWorkspace && !(await isGitWorkspaceClean(this.cwd))) {
      throw new Error("Workspace is dirty. Commit, stash, or set policy.allowDirtyWorkspace=true.");
    }
    const run = await this.store.create(title, request, this.config);
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
            run.failure = {
              message: "Maximum build/verify cycles exceeded.",
              at: new Date().toISOString(),
            };
            return this.store.applyEvent(run, "FAIL", "orchestrator", {
              reason: run.failure.message,
            });
          }
          return await this.executeRole(run, "builder", "04-builder-report.md", "BUILD_COMPLETED");
        }
        case "CI_RUNNING": {
          const report = await runQualityChecks(this.cwd, run.config.quality.commands);
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
          await this.store.writeArtifact(run, "06-verification-report.md", result.output);
          const passed = verifierPassed(result.output);
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
            run.failure = {
              message: "Maximum PR comment resolution cycles exceeded.",
              at: new Date().toISOString(),
            };
            return this.store.applyEvent(run, "FAIL", "orchestrator", {
              reason: run.failure.message,
            });
          }
          return await this.executeRole(run, "prResolver", "09-resolution-report.md", "RESOLUTION_COMPLETED");
        }
        default:
          throw new Error(`State ${run.state} requires a user or integration event.`);
      }
    } catch (error) {
      run.failure = {
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      };
      await this.store.save(run);
      if (!isTerminal(run.state)) {
        return this.store.applyEvent(run, "FAIL", "orchestrator", { reason: run.failure.message });
      }
      return run;
    }
  }

  private async executeRole(
    run: RunRecord,
    role: RoleId,
    artifactName: string,
    successEvent: "BRAINSTORM_COMPLETED" | "DESIGN_COMPLETED" | "BUILD_COMPLETED" | "RESOLUTION_COMPLETED",
  ): Promise<RunRecord> {
    const prompt = await buildRolePrompt(role, run, this.store);
    const result = await this.executeAgent(run, role, prompt);
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

    for (const model of candidates) {
      try {
        const result = await this.runtime.execute({
          runId: run.id,
          role,
          prompt,
          cwd: this.cwd,
          roleConfig: { ...configured, model },
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
}
