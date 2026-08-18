import type { WorkflowEventType, WorkflowState } from "./domain.ts";

const TRANSITIONS: Partial<Record<WorkflowState, Partial<Record<WorkflowEventType, WorkflowState>>>> = {
  CREATED: { START: "BRAINSTORMING" },
  BRAINSTORMING: { BRAINSTORM_COMPLETED: "WAITING_FOR_BRAINSTORM_APPROVAL" },
  WAITING_FOR_BRAINSTORM_APPROVAL: { APPROVE_BRAINSTORM: "DESIGNING" },
  DESIGNING: { DESIGN_COMPLETED: "WAITING_FOR_DESIGN_APPROVAL" },
  WAITING_FOR_DESIGN_APPROVAL: { APPROVE_DESIGN: "BUILDING" },
  BUILDING: {
    BUILD_COMPLETED: "CI_RUNNING",
    REVALIDATION_RETARGETED: "CI_RUNNING",
  },
  CI_RUNNING: {
    CI_PASSED: "VERIFYING",
    CI_FAILED: "BUILDING",
    REVALIDATION_RETARGETED: "CI_RUNNING",
  },
  VERIFYING: {
    VERIFY_PASSED: "PR_READY",
    VERIFY_PASSED_AFTER_REVIEW: "PR_REVIEW",
    VERIFY_FAILED: "BUILDING",
    REVALIDATION_RETARGETED: "CI_RUNNING",
  },
  PR_READY: {
    PR_OPENED: "PR_REVIEW",
    MARK_MERGE_READY: "MERGE_READY",
    REVALIDATE_REQUESTED: "CI_RUNNING",
  },
  PR_REVIEW: {
    REVIEW_COMMENT_RECEIVED: "CLASSIFYING_COMMENT",
    MARK_MERGE_READY: "MERGE_READY",
    REVALIDATE_REQUESTED: "CI_RUNNING",
  },
  CLASSIFYING_COMMENT: {
    COMMENT_IN_SCOPE: "RESOLVING",
    COMMENT_OUT_OF_SCOPE: "WAITING_FOR_HUMAN",
  },
  RESOLVING: { RESOLUTION_COMPLETED: "CI_RUNNING" },
  WAITING_FOR_HUMAN: { HUMAN_RESUME: "PR_REVIEW" },
  MERGE_READY: { COMPLETE: "COMPLETED" },
};

const TERMINAL_STATES: WorkflowState[] = ["COMPLETED", "FAILED", "CANCELLED"];

const RESUMABLE_STATES: WorkflowState[] = [
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
];

export interface TransitionContext {
  retryResumeState?: WorkflowState;
  failureResumeState?: WorkflowState;
  hasRevalidation?: boolean;
}

export function transition(
  state: WorkflowState,
  event: WorkflowEventType,
  context: TransitionContext = {},
): WorkflowState {
  if (event === "CANCEL" && !TERMINAL_STATES.includes(state)) return "CANCELLED";
  if (event === "FAIL" && !TERMINAL_STATES.includes(state)) return "FAILED";
  if (event === "RETRY_FROM_FAILED") {
    if (state !== "FAILED") throw new Error(`Event RETRY_FROM_FAILED is not allowed from state ${state}`);
    if (
      !context.retryResumeState ||
      !RESUMABLE_STATES.includes(context.retryResumeState)
    ) {
      throw new Error("RETRY_FROM_FAILED requires a resumable resumeState");
    }
    return context.retryResumeState;
  }
  if (event === "REVALIDATION_RETARGETED" && state === "FAILED") {
    if (
      !context.hasRevalidation ||
      !context.failureResumeState ||
      !["BUILDING", "CI_RUNNING", "VERIFYING"].includes(context.failureResumeState)
    ) {
      throw new Error(
        "REVALIDATION_RETARGETED requires active revalidation and a legal failure resume state",
      );
    }
    return "FAILED";
  }
  const next = TRANSITIONS[state]?.[event];
  if (!next) throw new Error(`Event ${event} is not allowed from state ${state}`);
  return next;
}

export function allowedEvents(
  state: WorkflowState,
  context: TransitionContext = {},
): WorkflowEventType[] {
  if (state === "FAILED") {
    const failedEvents: WorkflowEventType[] = ["RETRY_FROM_FAILED"];
    if (
      context.hasRevalidation &&
      ["BUILDING", "CI_RUNNING", "VERIFYING"].includes(context.failureResumeState ?? "")
    ) {
      failedEvents.push("REVALIDATION_RETARGETED");
    }
    return failedEvents;
  }
  if (TERMINAL_STATES.includes(state)) return [];
  const events = Object.keys(TRANSITIONS[state] ?? {}) as WorkflowEventType[];
  return [...events, "FAIL", "CANCEL"];
}

export function isTerminal(state: WorkflowState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function isApprovalGate(state: WorkflowState): boolean {
  return state === "WAITING_FOR_BRAINSTORM_APPROVAL" || state === "WAITING_FOR_DESIGN_APPROVAL";
}

export function isHumanGate(state: WorkflowState): boolean {
  return (
    isApprovalGate(state) ||
    state === "WAITING_FOR_HUMAN" ||
    state === "PR_READY" ||
    state === "PR_REVIEW" ||
    state === "MERGE_READY"
  );
}
