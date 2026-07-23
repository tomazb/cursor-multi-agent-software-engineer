import { spawn } from "node:child_process";

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut?: boolean;
}

const SETTLEMENT_GRACE_MS = 1_000;

function killProcessTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } catch {
      // Best-effort; settlement grace still bounds the Promise.
    }
    return;
  }
  try {
    // Negative PID signals the process group. Spawn uses detached+timeout so the
    // child is a group leader distinct from MASWE's own process group.
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Process already exited.
    }
  }
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
    const timeoutMs = options.timeoutMs;
    const useTimeout = timeoutMs !== undefined && timeoutMs > 0;
    // Isolate a process group only when timeouts must terminate descendants
    // (quality commands use shell:true). Avoid unconditional detach otherwise.
    const isolateProcessGroup = useTimeout && process.platform !== "win32";
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: options.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      detached: isolateProcessGroup,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let stdinError: Error | undefined;
    let settlementGrace: ReturnType<typeof setTimeout> | undefined;

    const cleanupTimers = () => {
      if (timeout) clearTimeout(timeout);
      if (settlementGrace) clearTimeout(settlementGrace);
    };

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolve(result);
    };

    const settleTimeout = () => {
      settle({
        exitCode: 124,
        stdout,
        stderr: `${stderr}\nProcess timed out after ${timeoutMs}ms`.trim(),
        durationMs: Date.now() - startedAt,
        timedOut: true,
      });
    };

    const onTimeout = () => {
      timedOut = true;
      killProcessTree(child.pid);
      try {
        child.stdin.destroy();
      } catch {
        // ignore
      }
      try {
        child.stdout.destroy();
      } catch {
        // ignore
      }
      try {
        child.stderr.destroy();
      } catch {
        // ignore
      }
      // Descendants holding pipes can prevent `close`; bound settlement.
      settlementGrace = setTimeout(settleTimeout, SETTLEMENT_GRACE_MS);
    };

    const timeout = useTimeout ? setTimeout(onTimeout, timeoutMs) : undefined;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.stdin.on("error", (error) => {
      stdinError = error;
    });
    child.on("error", (error) => {
      cleanupTimers();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (settled) return;
      if (timedOut) {
        settleTimeout();
        return;
      }
      cleanupTimers();
      settled = true;
      const stdinFailure = stdinError
        ? `stdin write failed: ${stdinError.message}`
        : "";
      resolve({
        exitCode: stdinError ? 1 : (code ?? 1),
        stdout,
        stderr: `${stderr}${stderr && stdinFailure ? "\n" : ""}${stdinFailure}`,
        durationMs: Date.now() - startedAt,
        timedOut: false,
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
