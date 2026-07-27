import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { spawnCaptured } from "../src/process.ts";

test("child Node compact machine output remains available after node:test is active", () => {
  const script = `
    const result = { channel: "buffered-stdout", value: 22 };
    process.stdout.write(JSON.stringify(result));
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
    let input = "";
    process.stdin.on("data", (chunk) => input += chunk);
    process.stdin.on("end", () => {
      fs.writeSync(1, JSON.stringify({ input }));
      process.exit(input === "maswe-stdin-probe" ? 0 : 1);
    });
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
