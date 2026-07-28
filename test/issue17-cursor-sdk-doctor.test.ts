import assert from "node:assert/strict";
import test from "node:test";
import { CursorSdkRuntime } from "../src/runtimes/cursor-sdk.ts";

const CURSOR_API_KEY = "CURSOR_API_KEY";

function withApiKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env[CURSOR_API_KEY];
  if (value === undefined) {
    delete process.env[CURSOR_API_KEY];
  } else {
    process.env[CURSOR_API_KEY] = value;
  }
  return fn().finally(() => {
    if (before === undefined) delete process.env[CURSOR_API_KEY];
    else process.env[CURSOR_API_KEY] = before;
  });
}

test("cursor-sdk doctor reports ok codes when key exists and sdk imports", async () => {
  await withApiKey("set", async () => {
    const runtime = new CursorSdkRuntime({
      importFn: async () => ({
        Agent: {
          prompt: async () => {
            throw new Error("execute() is not exercised by this doctor test");
          },
        },
      }),
    });
    const report = await runtime.doctor();
    const key = report.checks.find((check) => check.name === "cursor-api-key");
    const sdk = report.checks.find((check) => check.name === "cursor-sdk");

    assert.equal(key?.ok, true);
    assert.equal(key?.code, "ok");
    assert.equal(sdk?.ok, true);
    assert.equal(sdk?.code, "ok");
    assert.equal(report.ok, true);
  });
});

test("cursor-sdk doctor reports missing credential code when key is absent", async () => {
  await withApiKey(undefined, async () => {
    const runtime = new CursorSdkRuntime({
      importFn: async () => ({ Agent: { prompt: async () => ({}) } }),
    });
    const report = await runtime.doctor();
    const key = report.checks.find((check) => check.name === "cursor-api-key");
    const sdk = report.checks.find((check) => check.name === "cursor-sdk");

    assert.equal(key?.ok, false);
    assert.equal(key?.code, "cursor-sdk-credential-missing");
    assert.equal(sdk?.ok, true);
    assert.equal(sdk?.code, "ok");
    assert.equal(report.ok, false);
  });
});

test("cursor-sdk doctor reports unavailable code when sdk import fails", async () => {
  await withApiKey("set", async () => {
    const runtime = new CursorSdkRuntime({
      importFn: async () => {
        throw new Error("synthetic SDK import failure");
      },
    });
    const report = await runtime.doctor();
    const sdk = report.checks.find((check) => check.name === "cursor-sdk");
    assert.equal(sdk?.ok, false);
    assert.equal(sdk?.code, "cursor-sdk-unavailable");
  });
});
