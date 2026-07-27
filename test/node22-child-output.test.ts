import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { spawnCaptured } from "../src/process.ts";
import { spawnFileCaptured } from "./helpers/child-process.ts";

test("child Node compact machine output remains available after node:test is active", () => {
  const script = `
    import { writeSync } from "node:fs";
    const result = { channel: "buffered-stdout", value: 22 };
    writeSync(1, JSON.stringify(result));
  `;
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", script],
    { encoding: "utf8", timeout: 5_000 },
  );

  assert.equal(child.status, 0, child.stderr);
  assert.notEqual(
    child.stdout,
    "",
    "child exited successfully without its compact machine result",
  );
  assert.deepEqual(JSON.parse(child.stdout), {
    channel: "buffered-stdout",
    value: 22,
  });
});

test("child Node stdin probe receives the complete payload after node:test is active", async () => {
  const script = `
    const fs = require("node:fs");
    const input = fs.readFileSync(0, "utf8");
    fs.writeSync(1, JSON.stringify({ input }));
    process.exit(input === "maswe-stdin-probe" ? 0 : 1);
  `;
  const child = await spawnCaptured(
    process.execPath,
    ["--eval", script],
    {
      cwd: process.cwd(),
      input: "maswe-stdin-probe",
      timeoutMs: 5_000,
    },
  );

  assert.equal(child.exitCode, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    input: "maswe-stdin-probe",
  });
});

test("file-backed child capture handles early stdin closure deterministically", async () => {
  const child = await spawnFileCaptured(
    process.execPath,
    ["--eval", "process.exit(0)"],
    {
      cwd: process.cwd(),
      input: "x".repeat(16 * 1024 * 1024),
      timeoutMs: 5_000,
    },
  );

  assert.equal(child.code, 0, child.stderr);
  assert.equal(child.timedOut, false);
});
