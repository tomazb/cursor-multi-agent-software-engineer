import { spawn } from "node:child_process";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FileCapturedChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export async function spawnFileCaptured(
  command: string,
  args: string[],
  options: {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  },
): Promise<FileCapturedChildResult> {
  const captureDirectory = await mkdtemp(
    path.join(os.tmpdir(), "maswe-child-capture-"),
  );
  const stdoutPath = path.join(captureDirectory, "stdout");
  const stderrPath = path.join(captureDirectory, "stderr");
  const stdoutFile = await open(stdoutPath, "w");
  const stderrFile = await open(stderrPath, "w");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      timedOut: boolean;
    }>((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: [
          options.input === undefined ? "ignore" : "pipe",
          stdoutFile.fd,
          stderrFile.fd,
        ],
      });
      let timedOut = false;
      child.on("error", reject);
      child.on("close", (code, signal) => {
        if (timer) clearTimeout(timer);
        resolve({ code, signal, timedOut });
      });
      if (options.input !== undefined) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(options.input);
      }
      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs);
      }
    });
    await stdoutFile.close();
    await stderrFile.close();
    return {
      ...result,
      stdout: await readFile(stdoutPath, "utf8"),
      stderr: await readFile(stderrPath, "utf8"),
    };
  } finally {
    if (timer) clearTimeout(timer);
    await stdoutFile.close().catch(() => undefined);
    await stderrFile.close().catch(() => undefined);
    await rm(captureDirectory, { recursive: true, force: true });
  }
}
