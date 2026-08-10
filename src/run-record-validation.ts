import { assertSafeRunId } from "./git-workspace.ts";
import {
  WORKFLOW_EVENTS,
  WORKFLOW_STATES,
  type ArtifactReference,
  type MasweConfig,
  type RunRecord,
  type WorkflowEvent,
  type WorkflowEventType,
  type WorkflowState,
} from "./domain.ts";

function exactObject(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[] = allowed,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const allowedSet = new Set(allowed);
  const unsupported = Object.keys(record).find((key) => !allowedSet.has(key));
  if (unsupported) throw new Error(`Unsupported ${label} field: ${unsupported}`);
  const missing = required.find((key) => !(key in record));
  if (missing) throw new Error(`${label}.${missing} is required`);
  return record;
}

export function requiredRunRecordString(
  value: unknown,
  label: string,
  allowEmpty = true,
): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${label} must be ${allowEmpty ? "a string" : "a non-empty string"}`);
  }
  return value;
}

export function nonNegativeRunRecordInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return Number(value);
}

function validateWorkspace(value: unknown): NonNullable<RunRecord["workspace"]> {
  const workspace = exactObject(
    value,
    "run record workspace",
    ["remote", "baseSha", "headSha", "branch", "fingerprint", "worktreePath"],
    ["baseSha", "headSha", "branch", "fingerprint"],
  );
  return {
    ...(workspace.remote !== undefined
      ? { remote: requiredRunRecordString(workspace.remote, "Run record workspace.remote") }
      : {}),
    baseSha: requiredRunRecordString(workspace.baseSha, "Run record workspace.baseSha"),
    headSha: requiredRunRecordString(workspace.headSha, "Run record workspace.headSha"),
    branch: requiredRunRecordString(workspace.branch, "Run record workspace.branch"),
    fingerprint: requiredRunRecordString(
      workspace.fingerprint,
      "Run record workspace.fingerprint",
    ),
    ...(workspace.worktreePath !== undefined
      ? {
          worktreePath: requiredRunRecordString(
            workspace.worktreePath,
            "Run record workspace.worktreePath",
          ),
        }
      : {}),
  };
}

function validateEvidence(value: unknown): NonNullable<RunRecord["evidence"]> {
  const evidence = exactObject(
    value,
    "run record evidence",
    ["quality", "verification", "mergeReady"],
    [],
  );
  const result: NonNullable<RunRecord["evidence"]> = {};
  for (const key of ["quality", "verification", "mergeReady"] as const) {
    if (evidence[key] === undefined) continue;
    const binding = exactObject(
      evidence[key],
      `run record evidence.${key}`,
      ["headSha", "passed", "at"],
    );
    if (typeof binding.passed !== "boolean") {
      throw new Error(`Run record evidence.${key}.passed must be a boolean`);
    }
    result[key] = {
      headSha: requiredRunRecordString(
        binding.headSha,
        `Run record evidence.${key}.headSha`,
      ),
      passed: binding.passed,
      at: requiredRunRecordString(binding.at, `Run record evidence.${key}.at`),
    };
  }
  return result;
}

function validateEvents(value: unknown): WorkflowEvent[] {
  if (!Array.isArray(value)) throw new Error("Run record events must be an array");
  return value.map((item, index) => {
    const event = exactObject(
      item,
      `run record event[${index}]`,
      ["id", "at", "type", "actor", "from", "to", "details"],
      ["id", "at", "type", "actor", "from", "to"],
    );
    if (!WORKFLOW_EVENTS.includes(event.type as WorkflowEventType)) {
      throw new Error(`Run record event[${index}].type is invalid`);
    }
    if (!WORKFLOW_STATES.includes(event.from as WorkflowState)) {
      throw new Error(`Run record event[${index}].from is invalid`);
    }
    if (!WORKFLOW_STATES.includes(event.to as WorkflowState)) {
      throw new Error(`Run record event[${index}].to is invalid`);
    }
    if (
      event.details !== undefined &&
      (!event.details || typeof event.details !== "object" || Array.isArray(event.details))
    ) {
      throw new Error(`Run record event[${index}].details must be an object`);
    }
    return {
      id: requiredRunRecordString(event.id, `Run record event[${index}].id`, false),
      at: requiredRunRecordString(event.at, `Run record event[${index}].at`),
      type: event.type as WorkflowEventType,
      actor: requiredRunRecordString(event.actor, `Run record event[${index}].actor`),
      from: event.from as WorkflowState,
      to: event.to as WorkflowState,
      ...(event.details !== undefined
        ? { details: event.details as Record<string, unknown> }
        : {}),
    };
  });
}

function validateFailure(value: unknown): NonNullable<RunRecord["failure"]> {
  const failure = exactObject(
    value,
    "run record failure",
    ["code", "message", "at", "resumeState", "runtime"],
    ["message", "at"],
  );
  if (
    failure.code !== undefined &&
    failure.code !== "runtime-models-exhausted" &&
    failure.code !== "workflow-failure"
  ) {
    throw new Error("Run record failure.code is invalid");
  }
  if (
    failure.resumeState !== undefined &&
    !WORKFLOW_STATES.includes(failure.resumeState as WorkflowState)
  ) {
    throw new Error("Run record failure.resumeState is invalid");
  }
  return {
    ...(failure.code !== undefined ? { code: failure.code } : {}),
    message: requiredRunRecordString(failure.message, "Run record failure.message"),
    at: requiredRunRecordString(failure.at, "Run record failure.at"),
    ...(failure.resumeState !== undefined
      ? { resumeState: failure.resumeState as WorkflowState }
      : {}),
    ...(failure.runtime !== undefined
      ? {
          runtime: failure.runtime as NonNullable<
            NonNullable<RunRecord["failure"]>["runtime"]
          >,
        }
      : {}),
  };
}

export function exactRunRecord(
  candidate: Record<string, unknown>,
  version: number,
  config: MasweConfig,
  artifacts: ArtifactReference[],
): RunRecord {
  const id = requiredRunRecordString(candidate.id, "Run record id", false);
  assertSafeRunId(id);
  if (!WORKFLOW_STATES.includes(candidate.state as WorkflowState)) {
    throw new Error("Run record state is invalid");
  }
  const approvals = exactObject(
    candidate.approvals,
    "run record approvals",
    ["brainstorm", "design"],
  );
  if (typeof approvals.brainstorm !== "boolean" || typeof approvals.design !== "boolean") {
    throw new Error("Run record approvals must contain booleans");
  }
  const counters = exactObject(
    candidate.counters,
    "run record counters",
    ["buildVerifyCycles", "commentResolutionCycles"],
  );
  return {
    schemaVersion: 1,
    version,
    id,
    title: requiredRunRecordString(candidate.title, "Run record title"),
    request: requiredRunRecordString(candidate.request, "Run record request"),
    repositoryPath: requiredRunRecordString(
      candidate.repositoryPath,
      "Run record repositoryPath",
    ),
    state: candidate.state as WorkflowState,
    createdAt: requiredRunRecordString(candidate.createdAt, "Run record createdAt"),
    updatedAt: requiredRunRecordString(candidate.updatedAt, "Run record updatedAt"),
    approvals: {
      brainstorm: approvals.brainstorm,
      design: approvals.design,
    },
    counters: {
      buildVerifyCycles: nonNegativeRunRecordInteger(
        counters.buildVerifyCycles,
        "Run record counters.buildVerifyCycles",
      ),
      commentResolutionCycles: nonNegativeRunRecordInteger(
        counters.commentResolutionCycles,
        "Run record counters.commentResolutionCycles",
      ),
    },
    config,
    artifacts,
    events: validateEvents(candidate.events),
    ...(candidate.workspace !== undefined
      ? { workspace: validateWorkspace(candidate.workspace) }
      : {}),
    ...(candidate.evidence !== undefined
      ? { evidence: validateEvidence(candidate.evidence) }
      : {}),
    ...(candidate.github !== undefined
      ? { github: candidate.github as NonNullable<RunRecord["github"]> }
      : {}),
    ...(candidate.supersedes !== undefined
      ? {
          supersedes: requiredRunRecordString(candidate.supersedes, "Run record supersedes"),
        }
      : {}),
    ...(candidate.supersededBy !== undefined
      ? {
          supersededBy: requiredRunRecordString(
            candidate.supersededBy,
            "Run record supersededBy",
          ),
        }
      : {}),
    ...(candidate.failure !== undefined
      ? { failure: validateFailure(candidate.failure) }
      : {}),
  };
}
