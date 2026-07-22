import type { WorkflowEventType, WorkflowState } from "./domain.ts";

const TRANSITIONS: Partial<Record<WorkflowState, Partial<Record<WorkflowEventType, WorkflowState>>>> = {
  CREATED: { START: "BRAINSTORMING" },
  BRAINSTORMING: { BRAINSTORM_COMPLETED: "WAITING_FOR_BRAINSTORM_APPROVAL" },
  WAITING_FOR_BRAINSTORM_APPROVAL: { APPROVE_BRAINSTORM: "DESIGNING" },
  DESIGNING: { DESIGN_COMPLETED: "WAITING_FOR_DESIGN_APPROVAL" },
  WAITING_FOR_DESIGN_APPROVAL: { APPROVE_DESIGN: "BUILDING" },
  BUILDING: { BUILD_COMPLETED: "CI_RUNNING" },
  CI_RUNNING: { CI_PASSED: "VERIFYING", CI_FAILED: "BUILDING" },
  VERIFYING: {
    VERIFY_PASSED: "PR_READY",
    VERIFY_PASSED_AFTER_REVIEW: "PR_REVIEW",
    VERIFY_FAILED: "BUILDING",
  },
  PR_READY: { PR_OPENED: "PR_REVIEW", MARK_MERGE_READY: "MERGE_READY" },
  PR_REVIEW: {
    REVIEW_COMMENT_RECEIVED: "CLASSIFYING_COMMENT",
    MARK_MERGE_READY: "MERGE_READY",
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

export function transition(state: WorkflowState, event: WorkflowEventType): WorkflowState {
  if (event === "CANCEL" && !TERMINAL_STATES.includes(state)) return "CANCELLED";
  if (event === "FAIL" && !TERMINAL_STATES.includes(state)) return "FAILED";
  const next = TRANSITIONS[state]?.[event];
  if (!next) throw new Error(`Event ${event} is not allowed from state ${state}`);
  return next;
}

export function allowedEvents(state: WorkflowState): WorkflowEventType[] {
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
