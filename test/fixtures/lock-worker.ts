import {
  acquireDirectoryLock,
  LockProtocolError,
  removeOwnedDirectory,
  type LockIdentity,
  type LockKind,
  type LockOwnershipHandle,
  type LockTransition,
} from "../../src/lock-protocol.ts";
import { FileRunStore } from "../../src/store.ts";

interface StartAcquire {
  action: "acquire";
  actor: string;
  lockPath: string;
  kind: LockKind;
  pauseAt?: LockTransition[];
}

interface StartRelease {
  action: "release";
  actor: string;
  ownership: {
    lockPath: string;
    kind: LockKind;
    owner: string;
    directoryIdentity: { dev: string; ino: string };
  };
  pauseAt?: LockTransition[];
}

interface StartRecoverAdmin {
  action: "recover-admin";
  actor: string;
  cwd: string;
  runId: string;
  force: boolean;
  pauseOnEntry?: boolean;
  pauseOnMarkerObserve?: boolean;
}

type StartMessage = StartAcquire | StartRelease | StartRecoverAdmin;

interface ContinueMessage {
  action: "continue";
  transition: string;
}

const waiters = new Map<string, () => void>();

function send(message: Record<string, unknown>): void {
  process.send?.({ pid: process.pid, ...message });
}

function waitFor(transition: string): Promise<void> {
  return new Promise((resolve) => {
    waiters.set(transition, resolve);
  });
}

async function transitionHook(
  config: { actor: string; kind: LockKind; pauseAt?: LockTransition[] },
  transition: LockTransition,
  token: string,
): Promise<void> {
  send({
    type: "transition",
    actor: config.actor,
    kind: config.kind,
    token,
    transition,
  });
  if (config.pauseAt?.includes(transition)) await waitFor(transition);
}

function deserializeOwnership(value: StartRelease["ownership"]): LockOwnershipHandle {
  const directoryIdentity: LockIdentity = {
    dev: BigInt(value.directoryIdentity.dev),
    ino: BigInt(value.directoryIdentity.ino),
  };
  return {
    lockPath: value.lockPath,
    kind: value.kind,
    owner: value.owner,
    directoryIdentity,
  };
}

async function run(config: StartMessage): Promise<void> {
  if (config.action === "acquire") {
    const ownership = await acquireDirectoryLock(config.lockPath, config.kind, {
      transition: (transition, token) =>
        transitionHook(config, transition, token),
    });
    send({
      type: "owned",
      actor: config.actor,
      kind: config.kind,
      token: ownership.owner,
      transition: "OWNERSHIP_VALIDATED",
      ownership: {
        lockPath: ownership.lockPath,
        kind: ownership.kind,
        owner: ownership.owner,
        directoryIdentity: {
          dev: ownership.directoryIdentity.dev.toString(),
          ino: ownership.directoryIdentity.ino.toString(),
        },
      },
    });
    await waitFor("RELEASE");
    await removeOwnedDirectory(ownership);
    return;
  }

  if (config.action === "release") {
    const ownership = deserializeOwnership(config.ownership);
    await removeOwnedDirectory(ownership, {
      transition: (transition, token) =>
        transitionHook(
          {
            actor: config.actor,
            kind: config.ownership.kind,
            ...(config.pauseAt ? { pauseAt: config.pauseAt } : {}),
          },
          transition,
          token,
        ),
    });
    return;
  }

  const store = new FileRunStore(config.cwd, { lockRetries: 20 });
  await store.unlockAdmin(config.runId, {
    force: config.force,
    afterMarkerObserve: async () => {
      send({
        type: "transition",
        actor: config.actor,
        kind: "admin-recovery",
        transition: "RECOVERY_MARKER_OBSERVED",
      });
      if (config.pauseOnMarkerObserve) {
        await waitFor("RECOVERY_MARKER_OBSERVED");
      }
    },
    afterObserve: async () => {
      send({
        type: "transition",
        actor: config.actor,
        kind: "admin-recovery",
        transition: "RECOVERY_ENTERED",
      });
      if (config.pauseOnEntry) await waitFor("RECOVERY_ENTERED");
    },
  });
}

process.on("message", (message: StartMessage | ContinueMessage) => {
  if (message.action === "continue") {
    const waiter = waiters.get(message.transition);
    if (waiter) {
      waiters.delete(message.transition);
      waiter();
    }
    return;
  }
  send({ type: "prepared", actor: message.actor });
  void waitFor("START").then(() => run(message)).then(
    () => {
      send({ type: "result", actor: message.actor, result: "ok" });
      process.exit(0);
    },
    (error: unknown) => {
      send({
        type: "result",
        actor: message.actor,
        result: "error",
        code: error instanceof LockProtocolError ? error.code : undefined,
        error: error instanceof Error ? error.message : String(error),
      });
      process.exit(2);
    },
  );
});

send({ type: "ready", actor: "worker" });
