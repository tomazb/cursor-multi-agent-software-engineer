import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { MAX_AUTHORITATIVE_FILE_BYTES } from "../src/durable-file.ts";
import { FileRunStore, migrateRunRecord } from "../src/store.ts";

const execFileAsync = promisify(execFile);
const TRUSTED_ARTIFACT = "trusted artifact\n";

async function runFixture(t: test.TestContext, prefix: string) {
  const cwd = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("artifact confinement", "test", DEFAULT_CONFIG);
  await store.writeArtifact(run, "note.md", TRUSTED_ARTIFACT);
  const runPath = path.join(store.root, run.id, "run.json");
  const persisted = JSON.parse(await readFile(runPath, "utf8")) as Record<string, unknown>;
  const artifactDirectory = path.join(store.root, run.id, "artifacts");
  const artifactPath = path.join(artifactDirectory, "note.attempt-1.md");
  return { cwd, store, run, runPath, persisted, artifactDirectory, artifactPath };
}

test("run migration rejects artifact references outside the enclosing run namespace", async (t) => {
  const { run, persisted } = await runFixture(t, "maswe-artifact-lexical-");
  const invalidPaths = [
    "../outside",
    `.maswe/runs/${run.id}/artifacts/../run.json`,
    ".maswe/runs/other/artifacts/x.md",
    "/absolute/x.md",
    "C:\\absolute\\x.md",
    "C:relative\\x.md",
    "\\\\server\\share\\x.md",
    "\\rooted\\x.md",
    `.maswe//runs/${run.id}/artifacts/x.md`,
    `.maswe/runs/${run.id}/artifacts/nested/x.md`,
    `.maswe/runs/${run.id}/artifacts/.`,
    `.maswe/runs/${run.id}/artifacts/..`,
  ];

  for (const persistedPath of invalidPaths) {
    const candidate = structuredClone(persisted);
    const artifacts = candidate.artifacts as Array<Record<string, unknown>>;
    artifacts[0]!.path = persistedPath;
    assert.throws(
      () => migrateRunRecord(candidate),
      /artifact.*path|artifact reference/i,
      persistedPath,
    );
  }
});

test("run migration validates the enclosing run ID before artifact references", async (t) => {
  const { persisted } = await runFixture(t, "maswe-artifact-run-id-");
  persisted.id = "../invalid";
  const artifacts = persisted.artifacts as Array<Record<string, unknown>>;
  artifacts[0]!.path = 42;

  assert.throws(() => migrateRunRecord(persisted), /invalid run id/i);
});

test("run migration accepts historical Windows separators and returns a canonical path", async (t) => {
  const { run, persisted } = await runFixture(t, "maswe-artifact-windows-");
  const artifacts = persisted.artifacts as Array<Record<string, unknown>>;
  artifacts[0]!.path = String(artifacts[0]!.path).replaceAll("/", "\\");

  const migrated = migrateRunRecord(persisted);

  assert.equal(
    migrated.artifacts[0]?.path,
    `.maswe/runs/${run.id}/artifacts/note.attempt-1.md`,
  );
});

test("load rejects an invalid artifact reference without rewriting run.json", async (t) => {
  const { store, run, runPath, persisted } = await runFixture(t, "maswe-artifact-load-");
  const artifacts = persisted.artifacts as Array<Record<string, unknown>>;
  artifacts[0]!.path = "../outside";
  const invalidSnapshot = `${JSON.stringify(persisted, null, 2)}\n`;
  await writeFile(runPath, invalidSnapshot, "utf8");

  await assert.rejects(store.load(run.id), /artifact.*path|artifact reference/i);
  assert.equal(await readFile(runPath, "utf8"), invalidSnapshot);
});

test("run-record schema closes artifact references and constrains their portable path shape", async () => {
  const schema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as {
    properties?: {
      artifacts?: {
        items?: {
          additionalProperties?: boolean;
          properties?: { path?: { pattern?: string } };
        };
      };
    };
  };
  const artifactSchema = schema.properties?.artifacts?.items;
  assert.equal(artifactSchema?.additionalProperties, false);
  assert.ok(artifactSchema.properties?.path?.pattern);
  const artifactPath = new RegExp(artifactSchema.properties.path.pattern);

  assert.match(".maswe/runs/run-1/artifacts/note.attempt-1.md", artifactPath);
  assert.match(".maswe\\runs\\run-1\\artifacts\\note.attempt-1.md", artifactPath);
  for (const invalid of [
    "../outside",
    "/absolute/x.md",
    "C:\\absolute\\x.md",
    ".maswe//runs/run-1/artifacts/x.md",
    ".maswe/runs/run-1/artifacts/../run.json",
    ".maswe/runs/run-1/artifacts/nested/x.md",
  ]) {
    assert.doesNotMatch(invalid, artifactPath, invalid);
  }
});

test("a valid direct artifact still round-trips with digest verification", async (t) => {
  const { store, run } = await runFixture(t, "maswe-artifact-roundtrip-");

  assert.equal(await store.readArtifact(run, "note.md"), TRUSTED_ARTIFACT);
});

test("readArtifact rejects a symlinked artifact directory", async (t) => {
  const { cwd, store, run, artifactDirectory } = await runFixture(
    t,
    "maswe-artifact-directory-link-",
  );
  const retained = path.join(cwd, "retained-artifacts");
  await rename(artifactDirectory, retained);
  await symlink(retained, artifactDirectory, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(store.readArtifact(run, "note.md"), /ordinary.*directory|symbolic/i);
});

test("readArtifact rejects a symlinked artifact file", async (t) => {
  const { cwd, store, run, artifactPath } = await runFixture(
    t,
    "maswe-artifact-file-link-",
  );
  const outside = path.join(cwd, "outside.md");
  await writeFile(outside, TRUSTED_ARTIFACT, "utf8");
  await rm(artifactPath);
  await symlink(outside, artifactPath, "file");

  await assert.rejects(store.readArtifact(run, "note.md"), /ordinary.*file|symbolic/i);
});

test("readArtifact rejects a directory in place of an artifact file", async (t) => {
  const { store, run, artifactPath } = await runFixture(t, "maswe-artifact-directory-");
  await rm(artifactPath);
  await mkdir(artifactPath);

  await assert.rejects(store.readArtifact(run, "note.md"), /ordinary.*file/i);
});

test(
  "readArtifact rejects a FIFO without waiting for unbounded input",
  { skip: process.platform === "win32" },
  async (t) => {
    const { store, run, artifactPath } = await runFixture(t, "maswe-artifact-fifo-");
    await rm(artifactPath);
    try {
      await execFileAsync("mkfifo", [artifactPath]);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        t.skip("mkfifo is unavailable");
        return;
      }
      throw error;
    }

    const writer = execFileAsync(
      process.execPath,
      [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], process.argv[2])",
        artifactPath,
        TRUSTED_ARTIFACT,
      ],
      { timeout: 500 },
    ).catch(() => undefined);

    await assert.rejects(store.readArtifact(run, "note.md"), /ordinary.*file/i);
    await writer;
  },
);

test("readArtifact rejects an artifact larger than the authoritative-file bound", async (t) => {
  const { store, run, artifactPath } = await runFixture(t, "maswe-artifact-oversized-");
  await writeFile(artifactPath, "x".repeat(MAX_AUTHORITATIVE_FILE_BYTES + 1), "utf8");

  await assert.rejects(store.readArtifact(run, "note.md"), /bounded|exceed/i);
});
