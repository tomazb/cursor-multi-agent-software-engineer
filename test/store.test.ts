import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";

async function tempStore(): Promise<FileRunStore> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-store-"));
  return new FileRunStore(cwd);
}

test("writeArtifact keeps attempt history and logical latest pointer", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);
  await store.writeArtifact(run, "06-verification-report.md", "attempt one VERDICT: FAIL");
  await store.writeArtifact(run, "06-verification-report.md", "attempt two VERDICT: PASS");

  const latest = run.artifacts.find((a) => a.name === "06-verification-report.md");
  assert.ok(latest);
  assert.equal(latest.attempt, 2);
  assert.equal(latest.logicalName, "06-verification-report.md");
  assert.match(latest.path, /attempt-2/);
  assert.equal(
    latest.path,
    `.maswe/runs/${run.id}/artifacts/06-verification-report.attempt-2.md`,
  );

  const history = run.artifacts.filter((a) => a.logicalName === "06-verification-report.md");
  assert.equal(history.length, 2);

  const content = await store.readArtifact(run, "06-verification-report.md");
  assert.match(content ?? "", /attempt two/);

  const firstAttempt = history.find((artifact) => artifact.attempt === 1);
  assert.ok(firstAttempt);
  assert.match(await store.readArtifact(run, firstAttempt.name) ?? "", /attempt one/);
});

test("writeArtifact preserves pending caller mutations for the following run save", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);
  run.counters.buildVerifyCycles = 1;

  await store.writeArtifact(run, "04-builder-report.md", "BUILD_COMPLETE");

  assert.equal(run.counters.buildVerifyCycles, 1);
  await store.save(run);
  assert.equal((await store.load(run.id)).counters.buildVerifyCycles, 1);
});

test("writeArtifact keeps reserved and underscore-prefixed logical artifacts distinct", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);

  const nulAttemptOne = await store.writeArtifact(run, "NUL.md", "nul attempt one");
  const underscoreAttemptOne = await store.writeArtifact(run, "_NUL.md", "underscore attempt one");
  const nulAttemptTwo = await store.writeArtifact(run, "NUL.md", "nul attempt two");

  assert.notEqual(nulAttemptOne.path, underscoreAttemptOne.path);
  assert.notEqual(nulAttemptOne.path, nulAttemptTwo.path);
  assert.notEqual(underscoreAttemptOne.path, nulAttemptTwo.path);
  assert.equal(nulAttemptOne.sha256, createHash("sha256").update("nul attempt one").digest("hex"));
  assert.equal(
    underscoreAttemptOne.sha256,
    createHash("sha256").update("underscore attempt one").digest("hex"),
  );
  assert.equal(nulAttemptTwo.sha256, createHash("sha256").update("nul attempt two").digest("hex"));

  assert.equal(await store.readArtifact(run, "NUL.md"), "nul attempt two");
  assert.equal(await store.readArtifact(run, "_NUL.md"), "underscore attempt one");
  assert.equal(await store.readArtifact(run, "NUL.md.attempt-1"), "nul attempt one");

  const reloaded = await store.load(run.id);
  assert.equal(await store.readArtifact(reloaded, "NUL.md"), "nul attempt two");
  assert.equal(await store.readArtifact(reloaded, "_NUL.md"), "underscore attempt one");
  assert.equal(await store.readArtifact(reloaded, "NUL.md.attempt-1"), "nul attempt one");
});

test("writeArtifact rejects a physical path already owned by another logical artifact", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);
  const original = await store.writeArtifact(run, "note.md", "original owner");
  const runPath = path.join(store.root, run.id, "run.json");
  const persisted = JSON.parse(await readFile(runPath, "utf8")) as {
    artifacts: Array<{ name: string; logicalName: string }>;
  };
  persisted.artifacts[0]!.name = "other.md";
  persisted.artifacts[0]!.logicalName = "other.md";
  await writeFile(runPath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
  const owned = await store.load(run.id);

  await assert.rejects(
    store.writeArtifact(owned, "note.md", "must not overwrite"),
    /artifact.*physical.*owned|artifact.*path.*owned/i,
  );

  assert.equal(await store.readArtifact(owned, "other.md"), "original owner");
  assert.equal(
    await readFile(path.join(store["cwd"], original.path), "utf8"),
    "original owner",
  );
});

test("readArtifact fails closed when digest does not match file bytes", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);
  const ref = await store.writeArtifact(run, "note.md", "trusted");
  const absolute = path.join(store["cwd"], ref.path);
  await import("node:fs/promises").then((fs) => fs.writeFile(absolute, "tampered", "utf8"));

  await assert.rejects(store.readArtifact(run, "note.md"), /digest|sha256|mismatch/i);
});

test("save rejects stale optimistic versions", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);
  assert.equal(run.version, 1);

  const stale = structuredClone(run);
  run.title = "updated";
  await store.save(run);
  assert.equal(run.version, 2);

  stale.title = "stale writer";
  await assert.rejects(store.save(stale), /version|conflict/i);
});

test("run.json is written atomically and remains valid JSON", async () => {
  const store = await tempStore();
  const run = await store.create("t", "r", DEFAULT_CONFIG);
  const raw = await readFile(path.join(store.root, run.id, "run.json"), "utf8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.id, run.id);
  assert.equal(parsed.version, run.version);
});
