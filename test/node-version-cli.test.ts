import assert from "node:assert/strict";
import { access, mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCli } from "../src/cli.ts";
import { UNSUPPORTED_NODE_VERSION_CODE } from "../src/node-version.ts";

async function assertPathAbsent(target: string): Promise<void> {
  await assert.rejects(() => access(target), { code: "ENOENT" });
}

async function assertUnsupportedWithoutMasweState(argv: string[]): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-node-guard-"));
  const command = [...argv, "--cwd", cwd];
  await assert.rejects(
    () => runCli({ argv: command, observedNodeVersion: "25.9.0" }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as Error & { code?: string }).code, UNSUPPORTED_NODE_VERSION_CODE);
      assert.match(error.message, /MASWE_UNSUPPORTED_NODE_VERSION/);
      assert.match(error.message, /25\.9\.0/);
      assert.match(error.message, /nvm install && nvm use/);
      return true;
    },
  );
  await assertPathAbsent(path.join(cwd, ".maswe"));
  assert.deepEqual(await readdir(cwd), []);
}

test("unsupported Node rejects init before starter configuration is written", async () => {
  await assertUnsupportedWithoutMasweState(["init"]);
});

test("unsupported Node rejects status before store construction or state access", async () => {
  await assertUnsupportedWithoutMasweState(["status"]);
});

test("unsupported Node rejects start before config, runtime, worktree, or run side effects", async () => {
  await assertUnsupportedWithoutMasweState([
    "start",
    "--title",
    "guarded",
    "--request",
    "must not execute",
  ]);
});

test("unsupported Node rejects persisted-run commands before run loading or runtime construction", async () => {
  await assertUnsupportedWithoutMasweState(["run", "nonexistent-run"]);
});

test("supported Node preserves help behavior without creating state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-node-supported-"));
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
  try {
    await runCli({ argv: ["help", "--cwd", cwd], observedNodeVersion: "24.18.0" });
  } finally {
    console.log = originalLog;
  }

  assert.match(output.join("\n"), /Cursor Multi-Agent Software Engineer/);
  await assertPathAbsent(path.join(cwd, ".maswe"));
  assert.deepEqual(await readdir(cwd), []);
});
