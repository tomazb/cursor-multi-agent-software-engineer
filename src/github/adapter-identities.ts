import type { GitHubAppConfig } from "../domain.ts";
import path from "node:path";

const MAX_PENDING_CANCELLATION_HEADS = 64;

export function githubStateRoot(cwd: string): string {
  return path.join(cwd, ".maswe", "github");
}

export function parseOwnerRepo(repository: string): { owner: string; repo: string } {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository: ${repository}`);
  return { owner, repo };
}

export function isRepoAllowed(
  config: GitHubAppConfig,
  repository: string | undefined,
): boolean {
  if (!repository) return false;
  return config.allowedRepositories.includes(repository);
}

export function pendingCancellationHeads(
  existing: readonly string[] | undefined,
  previousHeadSha: string | undefined,
  currentHeadSha: string,
): string[] {
  const pending = new Set(existing ?? []);
  if (previousHeadSha && previousHeadSha !== currentHeadSha) pending.add(previousHeadSha);
  pending.delete(currentHeadSha);
  const result = [...pending].sort();
  if (result.length > MAX_PENDING_CANCELLATION_HEADS) {
    throw new Error("GitHub pending check cancellation limit exceeded");
  }
  return result;
}

/** Match only github.com remotes (HTTPS or SSH) to owner/repo. Plain HTTP is rejected. */
export function remoteMatchesRepository(
  remote: string | undefined,
  repository: string,
): boolean {
  if (!remote) return false;
  const trimmed = remote.trim().replace(/\.git$/i, "");
  const https = trimmed.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/i);
  if (https) {
    return `${https[1]}/${https[2]}`.toLowerCase() === repository.toLowerCase();
  }
  const sshScp = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+)$/i);
  if (sshScp) {
    return `${sshScp[1]}/${sshScp[2]}`.toLowerCase() === repository.toLowerCase();
  }
  const sshUrl = trimmed.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+)$/i);
  if (sshUrl) {
    return `${sshUrl[1]}/${sshUrl[2]}`.toLowerCase() === repository.toLowerCase();
  }
  return false;
}
