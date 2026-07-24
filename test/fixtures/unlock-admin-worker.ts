import {
  type JournalTransition,
  type JournalTransitionContext,
} from "../../src/lock-journal.ts";
import { FileRunStore } from "../../src/store.ts";

type ParentMessage = {
  type: "CONTINUE";
  event: JournalTransition;
};

const cwd = process.env.MASWE_STORE_CWD;
const runId = process.env.MASWE_STORE_RUN_ID;
const actor = process.env.MASWE_LOCK_ACTOR ?? "unlock-admin-worker";
const force = process.env.MASWE_UNLOCK_FORCE === "1";
const pauseEvents = new Set(
  (process.env.MASWE_LOCK_PAUSE_EVENTS ?? "")
    .split(",")
    .filter(Boolean) as JournalTransition[],
);

if (!cwd || !runId || typeof process.send !== "function") {
  throw new Error("unlock-admin worker requires cwd, run ID, and IPC");
}

const pending = new Map<JournalTransition, Array<() => void>>();
process.on("message", (message: ParentMessage) => {
  if (message?.type !== "CONTINUE") return;
  pending.get(message.event)?.shift()?.();
});

async function send(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function transition(
  event: JournalTransition,
  context: JournalTransitionContext,
): Promise<void> {
  await send({
    type: "EVENT",
    actor,
    pid: process.pid,
    event,
    kind: context.kind,
    ticket: context.ticket,
    owner: context.owner,
  });
  if (!pauseEvents.has(event)) return;
  await new Promise<void>((resolve) => {
    const resolvers = pending.get(event) ?? [];
    resolvers.push(resolve);
    pending.set(event, resolvers);
  });
}

try {
  const store = new FileRunStore(cwd, { lockRetries: 5 });
  await store.unlockAdmin(runId, { force, transition });
  await send({
    type: "RESULT",
    actor,
    pid: process.pid,
    result: "OK",
  });
} catch (error) {
  await send({
    type: "RESULT",
    actor,
    pid: process.pid,
    result: "ERROR",
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  process.disconnect?.();
}
