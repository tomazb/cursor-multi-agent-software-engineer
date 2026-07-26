import type { RunRecord } from "./domain.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";

export function renderRun(run: RunRecord): string {
  const artifacts = run.artifacts.length
    ? run.artifacts.map((artifact) => `  - ${artifact.name}: ${artifact.path}`).join("\n")
    : "  - none";
  const workspace = run.workspace
    ? `Workspace: branch=${run.workspace.branch}, head=${run.workspace.headSha.slice(0, 12)}, worktree=${run.workspace.worktreePath ?? "(repo)"}`
    : "Workspace: (unset)";
  return [
    `Run: ${run.id}`,
    `Title: ${run.title}`,
    `State: ${run.state}`,
    `Updated: ${run.updatedAt}`,
    workspace,
    `Approvals: brainstorm=${run.approvals.brainstorm}, design=${run.approvals.design}`,
    `Cycles: build/verify=${run.counters.buildVerifyCycles}, comments=${run.counters.commentResolutionCycles}`,
    "Artifacts:",
    artifacts,
    ...(run.failure
      ? [
          `Failure: ${sanitizeDiagnostic(
            run.failure.message,
            FAILURE_AGGREGATE_MAX_CODE_POINTS,
          ).text}`,
        ]
      : []),
    ...(run.supersedes ? [`Supersedes: ${run.supersedes}`] : []),
    ...(run.supersededBy ? [`Superseded by: ${run.supersededBy}`] : []),
  ].join("\n");
}
