import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";

test("stale writeArtifact must not overwrite newer on-disk state/events/counters", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cas-art-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("cas", "artifact", DEFAULT_CONFIG);

  // Advance authoritative state on disk.
  await store.applyEvent(run, "START", "user");
  assert.equal(run.state, "BRAINSTORMING");
  assert.equal(run.version >= 2, true);
  const afterStart = await store.load(run.id);
  afterStart.approvals.brainstorm = true;
  afterStart.counters.buildVerifyCycles = 2;
  afterStart.evidence = {
    quality: { headSha: "abc", passed: true, at: new Date().toISOString() },
  };
  afterStart.failure = { message: "kept", at: new Date().toISOString(), resumeState: "BUILDING" };
  await store.save(afterStart);
  const authoritative = await store.load(run.id);
  assert.equal(authoritative.state, "BRAINSTORMING");
  assert.equal(authoritative.events.length, 1);

  // Stale caller still thinks the run is CREATED with empty events.
  const stale = await store.load(run.id);
  // Rewind stale view to pre-start snapshot.
  stale.version = 1;
  stale.state = "CREATED";
  stale.events = [];
  stale.approvals = { brainstorm: false, design: false };
  stale.counters = { buildVerifyCycles: 0, commentResolutionCycles: 0 };
  delete stale.evidence;
  delete stale.failure;

  await assert.rejects(store.writeArtifact(stale, "note.md", "stale writer"), /version conflict|stale/i);

  const final = await store.load(run.id);
  assert.equal(final.state, "BRAINSTORMING");
  assert.equal(final.events.length, 1);
  assert.equal(final.events[0]?.type, "START");
  assert.equal(final.approvals.brainstorm, true);
  assert.equal(final.counters.buildVerifyCycles, 2);
  assert.equal(final.evidence?.quality?.headSha, "abc");
  assert.equal(final.failure?.message, "kept");
  assert.equal(
    final.artifacts.some((a) => a.logicalName === "note.md"),
    false,
  );
});

test("cancellation concurrent with matching-version artifact write keeps cancel event and state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-cas-cancel-"));
  const store = new FileRunStore(cwd);
  let run = await store.create("cancel", "race", DEFAULT_CONFIG);
  run = await store.applyEvent(run, "START", "user");

  const writer = structuredClone(run);
  const canceller = structuredClone(run);

  // Cancel first (authoritative).
  await store.applyEvent(canceller, "CANCEL", "user");
  const cancelled = await store.load(run.id);
  assert.equal(cancelled.state, "CANCELLED");
  assert.ok(cancelled.events.some((e) => e.type === "CANCEL"));

  // Stale writer still at pre-cancel version must fail closed.
  await assert.rejects(
    store.writeArtifact(writer, "02-brainstorm.md", "late artifact"),
    /version conflict|stale/i,
  );

  const final = await store.load(run.id);
  assert.equal(final.state, "CANCELLED");
  assert.ok(final.events.some((e) => e.type === "CANCEL"));
  assert.ok(final.events.some((e) => e.type === "START"));
  assert.equal(
    final.artifacts.some((a) => a.logicalName === "02-brainstorm.md"),
    false,
  );
});
