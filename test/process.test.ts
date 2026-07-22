import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnCaptured } from "../src/process.ts";

test("spawnCaptured kills processes that exceed timeoutMs", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-timeout-"));
  const script = path.join(cwd, "sleep.js");
  await writeFile(script, "setTimeout(() => {}, 10_000);\n", "utf8");
  const result = await spawnCaptured(process.execPath, [script], {
    cwd,
    timeoutMs: 200,
  });
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out/i);
});
