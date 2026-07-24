import { FileRunStore } from "../../src/store.ts";

const cwd = process.env.MASWE_STORE_CWD;
const runId = process.env.MASWE_STORE_RUN_ID;
if (!cwd || !runId || typeof process.send !== "function") {
  throw new Error("store writer worker requires cwd, run ID, and IPC");
}

process.send({ type: "READY", pid: process.pid });
await new Promise<void>((resolve) => {
  process.once("message", (message: { type?: string }) => {
    if (message?.type === "CONTINUE") resolve();
  });
});

try {
  const store = new FileRunStore(cwd);
  const run = await store.load(runId);
  run.title = "child-writer";
  await store.save(run);
  await new Promise<void>((resolve, reject) => {
    process.send?.({ type: "RESULT", result: "SAVED" }, (error) =>
      error ? reject(error) : resolve()
    );
  });
} catch (error) {
  await new Promise<void>((resolve, reject) => {
    process.send?.(
      {
        type: "RESULT",
        result: "ERROR",
        code: error && typeof error === "object" && "code" in error ? error.code : undefined,
        message: error instanceof Error ? error.message : String(error),
      },
      (sendError) => (sendError ? reject(sendError) : resolve()),
    );
  });
}
process.disconnect?.();
