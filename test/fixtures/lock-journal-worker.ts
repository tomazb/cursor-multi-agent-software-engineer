import {
  publishClaimRelease,
  publishLockClaim,
  recoverCurrentLock,
  validateClaimOwnership,
  type JournalTransition,
  type PublishedClaimHandle,
} from "../../src/lock-journal.ts";

type ParentMessage =
  | {
      type: "CONTINUE";
      event: JournalTransition;
    }
  | {
      type: "COMMAND";
      command: "VALIDATE" | "RELEASE" | "RECOVER" | "EXIT";
      requestId: string;
      force?: boolean;
    };

const runDirectory = process.env.MASWE_LOCK_RUN_DIRECTORY;
const actor = process.env.MASWE_LOCK_ACTOR ?? "worker";
const kind = process.env.MASWE_LOCK_KIND as "data" | "admin" | "admin-recovery" | undefined;
const operation = process.env.MASWE_LOCK_OPERATION as
  | "store-write"
  | "admin-serialize"
  | "admin-recovery"
  | undefined;
const mode = process.env.MASWE_LOCK_MODE ?? "publish";
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

async function send(message: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function finish(message: Record<string, unknown>): Promise<void> {
  await send(message);
  process.disconnect?.();
}

const transition = async (
  event: JournalTransition,
  context: { ticket: string; owner: string },
): Promise<void> => {
  await send({
    type: "EVENT",
    actor,
    pid: process.pid,
    event,
    kind,
    ticket: context.ticket,
    owner: context.owner,
  });
  await pause(event);
};

async function respond(
  requestId: string,
  command: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
    await send({
      type: "RESULT",
      actor,
      pid: process.pid,
      requestId,
      command,
      result: "OK",
      kind,
    });
  } catch (error) {
    await send({
      type: "RESULT",
      actor,
      pid: process.pid,
      requestId,
      command,
      result: "ERROR",
      kind,
      code: error && typeof error === "object" && "code" in error ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

try {
  let handle: PublishedClaimHandle | undefined;
  if (mode !== "recovery") {
    handle = await publishLockClaim(runDirectory, kind, operation, { transition });
  }
  if (mode === "publish") {
    await finish({
      type: "RESULT",
      actor,
      pid: process.pid,
      result: "PUBLISHED",
      kind,
      ticket: handle!.claim.ticket,
      owner: handle!.owner,
      claimDigest: handle!.claimDigest,
    });
  } else {
    await send({
      type: "EVENT",
      actor,
      pid: process.pid,
      event: "WORKER_READY",
      kind,
      ticket: handle?.claim.ticket,
      owner: handle?.owner,
      claimDigest: handle?.claimDigest,
    });
    let commands = Promise.resolve();
    process.on("message", (message: ParentMessage) => {
      if (message?.type !== "COMMAND") return;
      commands = commands.then(async () => {
        if (message.command === "EXIT") {
          await finish({
            type: "RESULT",
            actor,
            pid: process.pid,
            requestId: message.requestId,
            command: message.command,
            result: "OK",
            kind,
          });
          return;
        }
        await respond(message.requestId, message.command, async () => {
          if (message.command === "VALIDATE") {
            if (!handle) throw new Error("worker has no published claim");
            await validateClaimOwnership(handle, { transition });
          } else if (message.command === "RELEASE") {
            if (!handle) throw new Error("worker has no published claim");
            await publishClaimRelease(handle, { transition });
          } else {
            await recoverCurrentLock(runDirectory, kind, {
              force: message.force ?? false,
              transition,
            });
          }
        });
      });
    });
  }
} catch (error) {
  await finish({
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
