import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { FileRunStore } from "../src/store.ts";

const storeModule = fileURLToPath(new URL("../src/store.ts", import.meta.url));

test("exclusive lock blocks simultaneous multi-process writers", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-lock-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("lock", "race", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");

  // Hold an exclusive lock in this process, then spawn a sibling that must fail or wait.
  const { open } = await import("node:fs/promises");
  const holder = await open(lockPath, "wx");
  await holder.writeFile(
    `${JSON.stringify({
      pid: process.pid,
      owner: "holder-token",
      at: new Date().toISOString(),
    })}\n`,
    "utf8",
  );

  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "-e",
      `
      import { FileRunStore } from ${JSON.stringify(storeModule)};
      import { DEFAULT_CONFIG } from ${JSON.stringify(fileURLToPath(new URL("../src/config.ts", import.meta.url)))};
      const store = new FileRunStore(${JSON.stringify(cwd)});
      const run = await store.load(${JSON.stringify(run.id)});
      run.title = "child-writer";
      try {
        await store.save(run);
        console.log("SAVED");
        process.exit(0);
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(2);
      }
      `,
    ],
    { cwd, stdio: ["ignore", "pipe", "pipe"] },
  );

  const result = await new Promise<{ code: number | null; stderr: string; stdout: string }>(
    (resolve) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => (stdout += chunk));
      child.stderr?.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    },
  );

  await holder.close();
  await import("node:fs/promises").then((fs) => fs.rm(lockPath, { force: true }));

  assert.notEqual(result.code, 0, "child must not save while lock is held exclusively");
  assert.match(`${result.stderr}${result.stdout}`, /lock|busy|contention|EEXIST/i);
  const loaded = await store.load(run.id);
  assert.notEqual(loaded.title, "child-writer");
});

test("stale lock from dead pid is reclaimed after bounded wait", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-stale-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("stale", "lock", DEFAULT_CONFIG);
  const lockPath = path.join(cwd, ".maswe", "runs", run.id, ".lock");
  await writeFile(
    lockPath,
    `${JSON.stringify({
      pid: 1_000_000_001,
      owner: "dead-stale-owner",
      at: new Date(Date.now() - 60_000).toISOString(),
    })}\n`,
    "utf8",
  );
  run.title = "reclaimed";
  await store.save(run);
  const loaded = await store.load(run.id);
  assert.equal(loaded.title, "reclaimed");
});

test("concurrent writeArtifact under lock yields unique attempts and valid digests", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-art-"));
  const store = new FileRunStore(cwd);
  const run = await store.create("arts", "concurrent", DEFAULT_CONFIG);

  const writers = Array.from({ length: 8 }, (_, index) =>
    (async () => {
      const latest = await store.load(run.id);
      return store.writeArtifact(latest, "note.md", `content-${index}-${Date.now()}`);
    })(),
  );
  const results = await Promise.allSettled(writers);
  const fulfilled = results.filter((r) => r.status === "fulfilled");
  assert.ok(fulfilled.length >= 1);

  const final = await store.load(run.id);
  const notes = final.artifacts.filter((a) => a.logicalName === "note.md");
  const attempts = new Set(notes.map((a) => a.attempt));
  assert.equal(attempts.size, notes.length, "attempt numbers must be unique");
  for (const artifact of notes) {
    const content = await store.readArtifact(final, artifact.name === "note.md" ? "note.md" : artifact.name);
    assert.ok(content !== undefined);
    const absolute = path.join(cwd, artifact.path);
    const bytes = await readFile(absolute, "utf8");
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256);
  }
});
