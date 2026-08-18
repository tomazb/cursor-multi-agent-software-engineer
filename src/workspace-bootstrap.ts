import type { MasweConfig, WorkspaceBootstrapIntent } from "./domain.ts";
import {
  captureWorkspaceSourceFingerprint,
  gitCurrentBranch,
  gitRemoteUrl,
  gitRevParse,
  isGitRepository,
} from "./git-snapshot.ts";

const NON_GIT_WORKSPACE = "not-a-git-repository";

/**
 * Capture the immutable source-plane inputs required to establish a workspace.
 *
 * This deliberately performs no workspace or Git metadata mutation. The intent
 * must be durably stored before reconciliation creates branches, worktrees, or
 * an `.git/info/exclude` entry.
 */
export async function captureWorkspaceBootstrapIntent(
  repositoryPath: string,
  config: MasweConfig,
  plannedAt = new Date().toISOString(),
): Promise<WorkspaceBootstrapIntent> {
  const sourceTreeFingerprint = await captureWorkspaceSourceFingerprint(repositoryPath);
  const mode = config.policy.useIsolatedWorktree
    ? "isolated-worktree"
    : "operator-checkout";

  if (!(await isGitRepository(repositoryPath))) {
    return {
      mode,
      sourceBaseSha: NON_GIT_WORKSPACE,
      sourceBranch: NON_GIT_WORKSPACE,
      sourceTreeFingerprint,
      plannedAt,
    };
  }

  const [sourceBaseSha, sourceBranch, remote] = await Promise.all([
    gitRevParse(repositoryPath, "HEAD"),
    gitCurrentBranch(repositoryPath),
    gitRemoteUrl(repositoryPath),
  ]);
  return {
    mode,
    sourceBaseSha,
    sourceBranch,
    sourceTreeFingerprint,
    ...(remote ? { remote } : {}),
    plannedAt,
  };
}
