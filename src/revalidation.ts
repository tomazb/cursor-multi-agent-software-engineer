import { isDeepStrictEqual } from "node:util";
import type {
  RevalidationSource,
  RunRecord,
  RunRevalidation,
  RunWorkspace,
  WorkflowState,
} from "./domain.ts";
import { invalidateStaleEvidence } from "./git-workspace.ts";
import type { RunStore } from "./store.ts";

export interface RevalidationTargetInput {
  source: RevalidationSource;
  previousHeadSha: string;
  requestedHeadSha: string;
  actor: string;
  observedWorkspace?: RunWorkspace;
  at?: string;
}

export interface RevalidationFence {
  runVersion: number;
  generation: number;
  requestedHeadSha: string;
}

const ACTIVE_REVALIDATION_STATES: WorkflowState[] = [
  "BUILDING",
  "CI_RUNNING",
  "VERIFYING",
];

function requireTargetInput(input: RevalidationTargetInput): void {
  if (!input.previousHeadSha.trim()) {
    throw new Error("Revalidation previous head SHA is required");
  }
  if (!input.requestedHeadSha.trim()) {
    throw new Error("Revalidation requested head SHA is required");
  }
  if (!input.actor.trim()) {
    throw new Error("Revalidation actor is required");
  }
}

function candidateWithObservedWorkspace(
  run: RunRecord,
  observedWorkspace: RunWorkspace | undefined,
): RunRecord {
  const candidate = structuredClone(run);
  if (observedWorkspace !== undefined) {
    candidate.workspace = structuredClone(observedWorkspace);
  }
  return candidate;
}

export class RevalidationService {
  private readonly store: RunStore;
  private readonly now: () => string;

  constructor(store: RunStore, now: () => string = () => new Date().toISOString()) {
    this.store = store;
    this.now = now;
  }

  async route(runId: string, input: RevalidationTargetInput): Promise<RunRecord> {
    requireTargetInput(input);
    const run = await this.store.load(runId);

    const revalidation = run.revalidation;
    if (revalidation === undefined) {
      return this.requestInitial(run, input);
    }
    return this.routeActive(run, revalidation, input);
  }

  private async requestInitial(
    run: RunRecord,
    input: RevalidationTargetInput,
  ): Promise<RunRecord> {
    if (run.state !== "PR_READY" && run.state !== "PR_REVIEW") {
      throw new Error(
        `Illegal revalidation request without active revalidation from state ${run.state}`,
      );
    }

    const at = input.at ?? this.now();
    const candidate = candidateWithObservedWorkspace(run, input.observedWorkspace);
    candidate.revalidation = {
      returnState: run.state,
      source: input.source,
      originHeadSha: input.previousHeadSha,
      requestedHeadSha: input.requestedHeadSha,
      generation: 1,
      requestedAt: at,
      updatedAt: at,
    };
    invalidateStaleEvidence(candidate, input.requestedHeadSha);

    return this.store.applyEvent(candidate, "REVALIDATE_REQUESTED", input.actor, {
      previousHeadSha: input.previousHeadSha,
      requestedHeadSha: input.requestedHeadSha,
      generation: 1,
      returnState: run.state,
      source: input.source,
    });
  }

  private async routeActive(
    run: RunRecord,
    revalidation: RunRevalidation,
    input: RevalidationTargetInput,
  ): Promise<RunRecord> {
    const failureResumeState = run.failure?.resumeState;
    const activeState = ACTIVE_REVALIDATION_STATES.includes(run.state);
    const failedState =
      run.state === "FAILED" &&
      failureResumeState !== undefined &&
      ACTIVE_REVALIDATION_STATES.includes(failureResumeState);

    if (!activeState && !failedState) {
      throw new Error(
        `Illegal active revalidation context from state ${run.state}; a legal revalidation resume state is required`,
      );
    }

    if (revalidation.requestedHeadSha === input.requestedHeadSha) {
      if (
        input.observedWorkspace !== undefined &&
        input.observedWorkspace.headSha !== input.requestedHeadSha
      ) {
        throw new Error(
          `Revalidation target ${input.requestedHeadSha} does not match observed workspace HEAD ${input.observedWorkspace.headSha}`,
        );
      }
      if (
        input.observedWorkspace === undefined ||
        isDeepStrictEqual(run.workspace, input.observedWorkspace)
      ) {
        return run;
      }
      const aligned = candidateWithObservedWorkspace(run, input.observedWorkspace);
      await this.store.save(aligned);
      return aligned;
    }

    const previousRequestedHeadSha = revalidation.requestedHeadSha;
    const generation = revalidation.generation + 1;
    const at = input.at ?? this.now();
    const candidate = candidateWithObservedWorkspace(run, input.observedWorkspace);
    candidate.revalidation = {
      ...revalidation,
      source: input.source,
      requestedHeadSha: input.requestedHeadSha,
      generation,
      updatedAt: at,
    };
    invalidateStaleEvidence(candidate, input.requestedHeadSha);

    const details: Record<string, unknown> = {
      previousRequestedHeadSha,
      requestedHeadSha: input.requestedHeadSha,
      generation,
      returnState: revalidation.returnState,
      source: input.source,
    };
    if (failedState) {
      details.previousResumeState = failureResumeState;
      candidate.failure = {
        ...candidate.failure!,
        resumeState: "CI_RUNNING",
      };
    }

    return this.store.applyEvent(
      candidate,
      "REVALIDATION_RETARGETED",
      input.actor,
      details,
    );
  }
}

export function captureRevalidationFence(run: RunRecord): RevalidationFence {
  if (run.revalidation === undefined) {
    throw new Error(`Run ${run.id} has no active revalidation to fence`);
  }
  return {
    runVersion: run.version,
    generation: run.revalidation.generation,
    requestedHeadSha: run.revalidation.requestedHeadSha,
  };
}

export async function assertRevalidationFence(
  store: RunStore,
  runId: string,
  fence: RevalidationFence,
): Promise<RunRecord> {
  const authoritative = await store.load(runId);
  if (
    authoritative.revalidation === undefined ||
    authoritative.version !== fence.runVersion ||
    authoritative.revalidation.generation !== fence.generation ||
    authoritative.revalidation.requestedHeadSha !== fence.requestedHeadSha
  ) {
    throw new Error(`Run ${runId} has a stale revalidation fence`);
  }
  return authoritative;
}
