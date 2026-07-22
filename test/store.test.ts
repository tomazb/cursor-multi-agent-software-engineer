import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
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

  const history = run.artifacts.filter((a) => a.logicalName === "06-verification-report.md");
  assert.equal(history.length, 2);

  const content = await store.readArtifact(run, "06-verification-report.md");
  assert.match(content ?? "", /attempt two/);
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
