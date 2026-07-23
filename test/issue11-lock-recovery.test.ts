import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classifyLockPath,
  type LockRecordV2,
} from "../src/lock-protocol.ts";

const DEAD_PID = 1_000_000_111;

function record(
  owner: string,
  overrides: Partial<LockRecordV2> = {},
): LockRecordV2 {
  return {
    format: 2,
    pid: DEAD_PID,
    owner,
    at: new Date().toISOString(),
    kind: "data",
    recovery: null,
    ...overrides,
  };
}

async function fixture(): Promise<{ root: string; lockPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "maswe-issue11-state-"));
  return { root, lockPath: path.join(root, ".lock") };
}

test("classifies absent and empty claimed lock directories", async () => {
  const { lockPath } = await fixture();
  assert.equal((await classifyLockPath(lockPath, "data")).state, "absent");
  await mkdir(lockPath, { mode: 0o700 });
  assert.equal((await classifyLockPath(lockPath, "data")).state, "incomplete-empty");
});

test("classifies temporary publication records as incomplete", async () => {
  const { lockPath } = await fixture();
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, `.record-${randomUUID()}`), '{"format":2', "utf8");
  assert.equal((await classifyLockPath(lockPath, "data")).state, "incomplete-temporary");
});

test("validates the sole UUID entry, owner, kind, pid, and timestamp", async () => {
  const { lockPath } = await fixture();
  const owner = randomUUID();
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, owner), `${JSON.stringify(record(owner))}\n`, "utf8");
  const classified = await classifyLockPath(lockPath, "data");
  assert.equal(classified.state, "valid-dead");
  if (classified.state === "valid-dead") {
    assert.equal(classified.record.owner, owner);
    assert.equal(classified.record.kind, "data");
  }
});

test("rejects filename-owner mismatch and wrong lock kind as corrupt", async () => {
  for (const value of [
    record(randomUUID()),
    record(randomUUID(), { kind: "admin" }),
  ]) {
    const { lockPath } = await fixture();
    const filename = randomUUID();
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, filename), JSON.stringify(value), "utf8");
    assert.equal((await classifyLockPath(lockPath, "data")).state, "corrupt");
  }
});

test("rejects malformed schema and multiple entries as corrupt", async () => {
  const malformedCases: unknown[] = [
    {},
    { ...record(randomUUID()), format: 3 },
    { ...record(randomUUID()), pid: 0 },
    { ...record(randomUUID()), owner: "not-a-uuid" },
    { ...record(randomUUID()), at: "not-a-date" },
  ];
  for (const value of malformedCases) {
    const { lockPath } = await fixture();
    const filename = randomUUID();
    await mkdir(lockPath);
    await writeFile(path.join(lockPath, filename), JSON.stringify(value), "utf8");
    assert.equal((await classifyLockPath(lockPath, "data")).state, "corrupt");
  }

  const { lockPath } = await fixture();
  await mkdir(lockPath);
  await writeFile(path.join(lockPath, randomUUID()), "{}", "utf8");
  await writeFile(path.join(lockPath, randomUUID()), "{}", "utf8");
  assert.equal((await classifyLockPath(lockPath, "data")).state, "multiple");
});

test("does not follow canonical or token symlinks", async () => {
  const canonical = await fixture();
  const canonicalTarget = path.join(canonical.root, "sentinel");
  await writeFile(canonicalTarget, "keep-canonical", "utf8");
  await symlink(canonicalTarget, canonical.lockPath);
  assert.equal((await classifyLockPath(canonical.lockPath, "data")).state, "unsafe");
  assert.equal(await readFile(canonicalTarget, "utf8"), "keep-canonical");

  const child = await fixture();
  const owner = randomUUID();
  const childTarget = path.join(child.root, "token-target");
  const targetContent = JSON.stringify(record(owner));
  await writeFile(childTarget, targetContent, "utf8");
  await mkdir(child.lockPath);
  await symlink(childTarget, path.join(child.lockPath, owner));
  assert.equal((await classifyLockPath(child.lockPath, "data")).state, "unsafe");
  assert.equal(await readFile(childTarget, "utf8"), targetContent);
  assert.equal((await lstat(path.join(child.lockPath, owner))).isSymbolicLink(), true);
});

test("reads PR #10 legacy regular-file locks without writing legacy format", async () => {
  const { lockPath } = await fixture();
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: DEAD_PID,
      owner: "legacy-dead-owner",
      at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  const classified = await classifyLockPath(lockPath, "data");
  assert.equal(classified.state, "legacy-dead");
});
