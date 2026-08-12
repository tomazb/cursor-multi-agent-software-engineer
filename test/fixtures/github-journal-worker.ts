import { appendFile } from "node:fs/promises";
import {
  withGitHubJournal,
  type GitHubJournalKind,
} from "../../src/github/journal.ts";

type ParentMessage = {
  type: "RELEASE";
};

const githubRoot = process.env.MASWE_GITHUB_ROOT;
const eventsPath = process.env.MASWE_GITHUB_EVENTS_PATH;
const actor = process.env.MASWE_GITHUB_ACTOR ?? "worker";
const kind = process.env.MASWE_GITHUB_JOURNAL_KIND as
  | GitHubJournalKind
  | undefined;
const logicalKey = process.env.MASWE_GITHUB_LOGICAL_KEY;
const timeoutMs = Number(process.env.MASWE_GITHUB_TIMEOUT_MS ?? "3000");

if (
  !githubRoot ||
  !eventsPath ||
  !kind ||
  !logicalKey ||
  !Number.isFinite(timeoutMs) ||
  typeof process.send !== "function"
) {
  throw new Error("GitHub journal worker requires root, event path, kind, key, and IPC");
}

async function send(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

let release: (() => void) | undefined;
process.on("message", (message: ParentMessage) => {
  if (message?.type === "RELEASE") release?.();
});

try {
  await withGitHubJournal(
    githubRoot,
    kind,
    logicalKey,
    async () => {
      await appendFile(eventsPath, `${actor}:enter\n`, "utf8");
      await send({ type: "ENTER", actor, pid: process.pid });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await appendFile(eventsPath, `${actor}:exit\n`, "utf8");
    },
    {
      timeoutMs,
      transition: async (event, context) => {
        await send({
          type: "TRANSITION",
          actor,
          pid: process.pid,
          event,
          ticket: context.ticket,
          owner: context.owner,
        });
      },
    },
  );
  await send({ type: "COMPLETE", actor, pid: process.pid });
  process.disconnect?.();
} catch (error) {
  await send({
    type: "ERROR",
    actor,
    pid: process.pid,
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
  process.disconnect?.();
  process.exitCode = 1;
}
