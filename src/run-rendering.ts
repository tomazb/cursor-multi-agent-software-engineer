import type { RunRecord } from "./domain.ts";
import {
  normalizeModelDisplay,
  sanitizeDurableRuntimeFailureSummary,
} from "./failure-diagnostics.ts";
import {
  FAILURE_AGGREGATE_MAX_CODE_POINTS,
  sanitizeDiagnostic,
} from "./redaction.ts";

function renderRuntimeFailure(run: RunRecord): string[] {
  const runtime = sanitizeDurableRuntimeFailureSummary(
    run.failure?.runtime,
  );
  if (!runtime) return [];
  const lines = [
    `Runtime attempts: ${runtime.totalAttempts} total, ${runtime.attempts.length} stored, ${runtime.omittedAttempts} omitted by durable cap${runtime.aggregateTruncated ? ", aggregate truncated" : ""}`,
  ];
  for (const attempt of runtime.attempts) {
    const fields = [
      `code=${attempt.code}`,
      ...(attempt.exitCode !== undefined
        ? [`exit=${attempt.exitCode}`]
        : []),
      ...(attempt.timedOut !== undefined
        ? [`timeout=${attempt.timedOut ? "yes" : "no"}`]
        : []),
      ...(attempt.durationMs !== undefined
        ? [`duration=${attempt.durationMs}ms`]
        : []),
      ...(attempt.promptTransport
        ? [`transport=${attempt.promptTransport}`]
        : []),
      `stderr=${attempt.stderrPresent ? "yes" : "no"}`,
      `truncated=${attempt.truncated ? "yes" : "no"}`,
    ];
    lines.push(
      `  - ${normalizeModelDisplay(attempt.model)}: ${fields.join(", ")}`,
    );
  }
  return lines;
}

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
          ...(run.failure.code ? [`Failure code: ${run.failure.code}`] : []),
          ...renderRuntimeFailure(run),
        ]
      : []),
    ...(run.supersedes ? [`Supersedes: ${run.supersedes}`] : []),
    ...(run.supersededBy ? [`Superseded by: ${run.supersededBy}`] : []),
  ].join("\n");
}
