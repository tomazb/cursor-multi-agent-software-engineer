import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnCaptured } from "./process.ts";

interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const GIT_TIMEOUT_MS = 120_000;

/** Shared git spawn with a hard timeout so hung git cannot wedge the orchestrator. */
export async function gitRun(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<ProcessResult> {
  const result = await spawnCaptured("git", args, { cwd, timeoutMs });
  if (result.timedOut) {
    throw new Error(`git ${args.join(" ")} timed out after ${timeoutMs}ms`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

async function run(command: string, args: string[], cwd: string): Promise<ProcessResult> {
  if (command !== "git") {
    throw new Error(`Unsupported command for git-snapshot run helper: ${command}`);
  }
  return gitRun(args, cwd);
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await run("git", ["rev-parse", "--is-inside-work-tree"], cwd);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function isGitWorkspaceClean(cwd: string): Promise<boolean> {
  if (!(await isGitRepository(cwd))) return true;
  const result = await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], cwd);
  return result.exitCode === 0 && result.stdout.trim().length === 0;
}

export async function gitWorkspaceFingerprint(cwd: string): Promise<string> {
  if (!(await isGitRepository(cwd))) return "not-a-git-repository";
  const hash = createHash("sha256");
  const commands = [
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    ["diff", "--binary"],
    ["diff", "--cached", "--binary"],
  ];
  for (const args of commands) {
    const result = await run("git", args, cwd);
    hash.update(result.stdout);
    hash.update(result.stderr);
  }

  const untracked = await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd);
  for (const relative of untracked.stdout.split("\0").filter(Boolean).sort()) {
    try {
      hash.update(relative);
      hash.update(await readFile(path.join(cwd, relative)));
    } catch {
      hash.update("unreadable");
    }
  }
  return hash.digest("hex");
}

export async function gitRevParse(cwd: string, rev = "HEAD"): Promise<string> {
  const result = await run("git", ["rev-parse", rev], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git rev-parse ${rev} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function gitCurrentBranch(cwd: string): Promise<string> {
  const result = await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git branch lookup failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export async function gitRemoteUrl(cwd: string, name = "origin"): Promise<string | undefined> {
  const result = await run("git", ["remote", "get-url", name], cwd);
  if (result.exitCode !== 0) return undefined;
  const url = result.stdout.trim();
  return url.length > 0 ? url : undefined;
}

export async function gitChangedFiles(cwd: string, baseSha: string, headSha = "HEAD"): Promise<string[]> {
  const result = await run("git", ["diff", "--name-only", "-z", `${baseSha}...${headSha}`], cwd);
  if (result.exitCode !== 0) {
    throw new Error(`git diff failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.split("\0").filter(Boolean);
}
