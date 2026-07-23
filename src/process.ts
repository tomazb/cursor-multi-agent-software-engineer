import { spawn } from "node:child_process";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

export function spawnCaptured(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    shell?: boolean;
    input?: string;
    timeoutMs?: number;
  },
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stdinError: Error | undefined;
    const timeout =
      options.timeoutMs && options.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs)
        : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.on("error", (error) => {
      if (timeout) clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const stdinFailure = stdinError
        ? `stdin write failed: ${stdinError.message}`
        : "";
      resolve({
        exitCode: timedOut ? 124 : stdinError ? 1 : (code ?? 1),
        stdout,
        stderr: timedOut
          ? `${stderr}\nProcess timed out after ${options.timeoutMs}ms`.trim()
          : `${stderr}${stderr && stdinFailure ? "\n" : ""}${stdinFailure}`,
        durationMs: Date.now() - startedAt,
        timedOut,
      });
    });
    try {
      if (options.input !== undefined) child.stdin.end(options.input);
      else child.stdin.end();
    } catch (error) {
      stdinError = error instanceof Error ? error : new Error(String(error));
      child.stdin.destroy();
    }
  });
}
