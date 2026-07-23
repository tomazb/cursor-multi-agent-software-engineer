import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnCaptured } from "../src/process.ts";
import { runQualityChecks } from "../src/quality.ts";

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

test("spawnCaptured shell timeout kills descendant process tree and settles", async () => {
  // Quality commands use shell:true; killing only the shell can leave a
  // descendant holding stdout/stderr open so `close` never fires.
  if (process.platform === "win32") {
    // Windows tree termination is covered by the taskkill branch in process.ts;
    // this POSIX hang reproduction is not meaningful under cmd.exe job semantics.
    return;
  }

  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-shell-tree-"));
  const pidFile = path.join(cwd, "descendant.pid");
  const childScript = path.join(cwd, "descendant.js");
  await writeFile(
    childScript,
    [
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1e9);",
      "",
    ].join("\n"),
    "utf8",
  );

  const command = `node ${JSON.stringify(childScript)} & wait`;
  const started = Date.now();
  const resultPromise = spawnCaptured(command, [], {
    cwd,
    shell: true,
    timeoutMs: 400,
  });
  const bounded = await Promise.race([
    resultPromise.then((result) => ({ kind: "settled" as const, result })),
    new Promise<{ kind: "hang" }>((resolve) =>
      setTimeout(() => resolve({ kind: "hang" }), 3_000),
    ),
  ]);

  assert.equal(bounded.kind, "settled", "spawnCaptured must settle after shell timeout");
  if (bounded.kind !== "settled") return;

  const { result } = bounded;
  assert.ok(Date.now() - started < 3_000);
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, 124);
  assert.match(result.stderr, /timed out/i);

  const descendantPid = Number(await readFile(pidFile, "utf8"));
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  // Allow a brief cleanup window after settlement.
  const deadline = Date.now() + 1_000;
  while (processAlive(descendantPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processAlive(descendantPid), false, `descendant ${descendantPid} must be dead`);
});

test("runQualityChecks shell timeout terminates descendant and reports failure", async () => {
  if (process.platform === "win32") return;

  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-quality-tree-"));
  const pidFile = path.join(cwd, "quality-descendant.pid");
  const childScript = path.join(cwd, "quality-descendant.js");
  await writeFile(
    childScript,
    [
      `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      "setInterval(() => {}, 1e9);",
      "",
    ].join("\n"),
    "utf8",
  );

  const command = `node ${JSON.stringify(childScript)} & wait`;
  const started = Date.now();
  const reportPromise = runQualityChecks(cwd, [command], { timeoutMs: 400 });
  const bounded = await Promise.race([
    reportPromise.then((report) => ({ kind: "settled" as const, report })),
    new Promise<{ kind: "hang" }>((resolve) =>
      setTimeout(() => resolve({ kind: "hang" }), 3_000),
    ),
  ]);

  assert.equal(bounded.kind, "settled", "runQualityChecks must settle after shell timeout");
  if (bounded.kind !== "settled") return;

  const { report } = bounded;
  assert.ok(Date.now() - started < 3_000);
  assert.equal(report.passed, false);
  assert.equal(report.commands.length, 1);
  assert.equal(report.commands[0]?.exitCode, 124);
  assert.match(report.commands[0]?.stderr ?? "", /timed out/i);

  const descendantPid = Number(await readFile(pidFile, "utf8"));
  const deadline = Date.now() + 1_000;
  while (processAlive(descendantPid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(processAlive(descendantPid), false);
});
