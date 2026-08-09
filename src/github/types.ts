export const MASWE_CHECK_NAMES = [
  "MASWE / specification compliance",
  "MASWE / deterministic quality",
  "MASWE / independent verification",
  "MASWE / review comments resolved",
] as const;

export type MasweCheckName = (typeof MASWE_CHECK_NAMES)[number];

export type GitHubInternalEventType =
  | "pull_request.opened"
  | "pull_request.synchronize"
  | "pull_request.reopened"
  | "pull_request.ready_for_review"
  | "pull_request.closed"
  | "push"
  | "installation.created"
  | "installation.deleted"
  | "installation_repositories.added"
  | "installation_repositories.removed"
  | "workflow_run.completed"
  | "check_run.completed"
  | "check_suite.completed";

export interface GitHubInternalEvent {
  eventId: string;
  type: GitHubInternalEventType;
  repository?: string;
  /** All repositories affected by installation_repositories events. */
  repositories?: string[];
  installationId?: number;
  pullRequestNumber?: number;
  headSha?: string;
  baseSha?: string;
  branch?: string;
  observeOnly?: boolean;
  receivedAt: string;
  rawAction?: string;
}

export interface AssociationRecord {
  runId: string;
  installationId: number;
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  branch: string;
  suspended: boolean;
  updatedAt: string;
}
