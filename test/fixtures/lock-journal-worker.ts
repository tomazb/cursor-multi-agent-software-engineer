import { publishLockClaim, type JournalTransition } from "../../src/lock-journal.ts";

interface ParentMessage {
  type: "CONTINUE";
  event: JournalTransition;
}

const runDirectory = process.env.MASWE_LOCK_RUN_DIRECTORY;
const actor = process.env.MASWE_LOCK_ACTOR ?? "worker";
const kind = process.env.MASWE_LOCK_KIND as "data" | "admin" | "admin-recovery" | undefined;
const operation = process.env.MASWE_LOCK_OPERATION as
  | "store-write"
  | "admin-serialize"
  | "admin-recovery"
  | undefined;
const pauseEvents = new Set(
  (process.env.MASWE_LOCK_PAUSE_EVENTS ?? "")
    .split(",")
    .filter(Boolean) as JournalTransition[],
);

if (!runDirectory || !kind || !operation || typeof process.send !== "function") {
  throw new Error("lock-journal worker requires run directory, kind, operation, and IPC");
}

const pending = new Map<JournalTransition, Array<() => void>>();
process.on("message", (message: ParentMessage) => {
  if (message?.type !== "CONTINUE") return;
  pending.get(message.event)?.shift()?.();
});

async function pause(event: JournalTransition): Promise<void> {
  if (!pauseEvents.has(event)) return;
  await new Promise<void>((resolve) => {
    const resolvers = pending.get(event) ?? [];
    resolvers.push(resolve);
    pending.set(event, resolvers);
  });
}

async function sendResult(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  process.disconnect?.();
}

try {
  const handle = await publishLockClaim(runDirectory, kind, operation, {
    transition: async (event, context) => {
      process.send?.({
        type: "EVENT",
        actor,
        pid: process.pid,
        event,
        kind,
        ticket: context.ticket,
        owner: context.owner,
      });
      await pause(event);
    },
  });
  await sendResult({
    type: "RESULT",
    actor,
    pid: process.pid,
    result: "PUBLISHED",
    kind,
    ticket: handle.claim.ticket,
    owner: handle.owner,
    claimDigest: handle.claimDigest,
  });
} catch (error) {
  await sendResult({
    type: "RESULT",
    actor,
    pid: process.pid,
    result: "ERROR",
    kind,
    code: error && typeof error === "object" && "code" in error ? error.code : undefined,
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
