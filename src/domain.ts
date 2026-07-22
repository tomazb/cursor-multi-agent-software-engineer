export const ROLE_IDS = [
  "brainstormer",
  "designer",
  "builder",
  "verifier",
  "prResolver",
] as const;

export type RoleId = (typeof ROLE_IDS)[number];
export type PermissionMode = "read-only" | "workspace-write";
export type RuntimeKind = "mock" | "cursor-cli" | "cursor-sdk";
export type ReasoningEffort = "low" | "medium" | "high";
export type PromptTransport = "stdin" | "argv";

export interface RoleConfig {
  model: string;
  fallbackModels?: string[];
  reasoning: ReasoningEffort;
  permissions: PermissionMode;
}

export interface MasweConfig {
  version: 1;
  runtime: {
    kind: RuntimeKind;
    command: string;
    outputFormat: "json" | "text";
  };
  roles: Record<RoleId, RoleConfig>;
  gates: {
    requireBrainstormApproval: boolean;
    requireDesignApproval: boolean;
    requireCiPass: boolean;
    requireVerifierPass: boolean;
  };
  quality: {
    commands: string[];
  };
  policy: {
    rejectModelFallback: boolean;
    maxBuildVerifyCycles: number;
    maxCommentResolutionCycles: number;
    allowDirtyWorkspace: boolean;
    useIsolatedWorktree: boolean;
    promptTransport: PromptTransport;
    commandTimeoutMs: number;
    roleTimeoutMs: number;
    maxRunDurationMs?: number;
    allowedPathGlobs: string[];
  };
}

export const WORKFLOW_STATES = [
  "CREATED",
  "BRAINSTORMING",
  "WAITING_FOR_BRAINSTORM_APPROVAL",
  "DESIGNING",
  "WAITING_FOR_DESIGN_APPROVAL",
  "BUILDING",
  "CI_RUNNING",
  "VERIFYING",
  "PR_READY",
  "PR_REVIEW",
  "CLASSIFYING_COMMENT",
  "RESOLVING",
  "WAITING_FOR_HUMAN",
  "MERGE_READY",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
] as const;

export type WorkflowState = (typeof WORKFLOW_STATES)[number];

export const WORKFLOW_EVENTS = [
  "START",
  "BRAINSTORM_COMPLETED",
  "APPROVE_BRAINSTORM",
  "DESIGN_COMPLETED",
  "APPROVE_DESIGN",
  "BUILD_COMPLETED",
  "CI_PASSED",
  "CI_FAILED",
  "VERIFY_PASSED",
  "VERIFY_PASSED_AFTER_REVIEW",
  "VERIFY_FAILED",
  "PR_OPENED",
  "REVIEW_COMMENT_RECEIVED",
  "COMMENT_IN_SCOPE",
  "COMMENT_OUT_OF_SCOPE",
  "RESOLUTION_COMPLETED",
  "HUMAN_RESUME",
  "MARK_MERGE_READY",
  "COMPLETE",
  "FAIL",
  "CANCEL",
  "RETRY_FROM_FAILED",
] as const;

export type WorkflowEventType = (typeof WORKFLOW_EVENTS)[number];

export interface WorkflowEvent {
  id: string;
  at: string;
  type: WorkflowEventType;
  actor: string;
  from: WorkflowState;
  to: WorkflowState;
  details?: Record<string, unknown>;
}

export interface ArtifactReference {
  name: string;
  logicalName: string;
  attempt: number;
  path: string;
  sha256: string;
  createdAt: string;
}

export interface RunWorkspace {
  remote?: string;
  baseSha: string;
  headSha: string;
  branch: string;
  fingerprint: string;
  worktreePath?: string;
}

export interface EvidenceBinding {
  headSha: string;
  passed: boolean;
  at: string;
}

export interface RunEvidence {
  quality?: EvidenceBinding;
  verification?: EvidenceBinding;
}

export interface RunRecord {
  schemaVersion: 1;
  version: number;
  id: string;
  title: string;
  request: string;
  repositoryPath: string;
  state: WorkflowState;
  createdAt: string;
  updatedAt: string;
  approvals: {
    brainstorm: boolean;
    design: boolean;
  };
  counters: {
    buildVerifyCycles: number;
    commentResolutionCycles: number;
  };
  config: MasweConfig;
  artifacts: ArtifactReference[];
  events: WorkflowEvent[];
  workspace?: RunWorkspace;
  evidence?: RunEvidence;
  supersedes?: string;
  supersededBy?: string;
  failure?: {
    message: string;
    at: string;
    resumeState?: WorkflowState;
  };
}

export interface RuntimeRequest {
  runId: string;
  role: RoleId;
  prompt: string;
  cwd: string;
  roleConfig: RoleConfig;
  timeoutMs?: number;
}

export interface RuntimeResult {
  status: "finished" | "error";
  output: string;
  requestedModel: string;
  actualModel?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeDoctorResult {
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    message: string;
  }>;
}

export interface AgentRuntime {
  execute(request: RuntimeRequest): Promise<RuntimeResult>;
  doctor(): Promise<RuntimeDoctorResult>;
}

export interface QualityCommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface QualityReport {
  passed: boolean;
  commands: QualityCommandResult[];
}
