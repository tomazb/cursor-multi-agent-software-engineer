import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
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
const INVALID_PORTABLE_FILE_NAMES = [
  "file:stream",
  "file::$DATA",
  "NUL",
  "nul.attempt-1.md",
  "CON.txt",
  "com1.md",
  "LPT9.attempt-1.md",
  "COM¹.md",
  "lpt².txt",
  "COM³",
  "trailing.",
  "trailing ",
  "control\u0001.md",
  "nul\u0000byte.md",
  "question?.md",
  "pipe|name.md",
] as const;

async function directoryContentsOrMissing(directory: string): Promise<string[] | undefined> {
  try {
    return (await readdir(directory)).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

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

test("run migration rejects non-portable physical artifact filenames", async (t) => {
  const { run, persisted } = await runFixture(t, "maswe-artifact-leaf-migration-");

  for (const fileName of INVALID_PORTABLE_FILE_NAMES) {
    const candidate = structuredClone(persisted);
    const artifacts = candidate.artifacts as Array<Record<string, unknown>>;
    artifacts[0]!.path = `.maswe/runs/${run.id}/artifacts/${fileName}`;
    assert.throws(
      () => migrateRunRecord(candidate),
      /artifact.*path|physical.*filename/i,
      JSON.stringify(fileName),
    );
  }
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

test("load rejects a non-portable artifact filename without rewriting run.json", async (t) => {
  const { store, run, runPath, persisted } = await runFixture(
    t,
    "maswe-artifact-leaf-load-",
  );
  const artifacts = persisted.artifacts as Array<Record<string, unknown>>;
  artifacts[0]!.path = `.maswe/runs/${run.id}/artifacts/CON.txt`;
  const invalidSnapshot = `${JSON.stringify(persisted, null, 2)}\n`;
  await writeFile(runPath, invalidSnapshot, "utf8");

  await assert.rejects(store.load(run.id), /artifact.*path|physical.*filename/i);
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
    ...INVALID_PORTABLE_FILE_NAMES.map(
      (fileName) => `.maswe/runs/run-1/artifacts/${fileName}`,
    ),
  ]) {
    assert.doesNotMatch(invalid, artifactPath, invalid);
  }
});

test("readArtifact rejects tampered in-memory references with non-portable filenames", async (t) => {
  const { store, run, artifactDirectory } = await runFixture(
    t,
    "maswe-artifact-leaf-read-",
  );
  const reference = run.artifacts.find((artifact) => artifact.name === "note.md");
  assert.ok(reference);
  const readableInvalidNames = [
    "file:stream",
    "CON.txt",
    "trailing.",
    "trailing ",
    "control\u0001.md",
    "question?.md",
  ] as const;

  for (const fileName of readableInvalidNames) {
    await writeFile(path.join(artifactDirectory, fileName), TRUSTED_ARTIFACT, "utf8");
    reference.path = `.maswe/runs/${run.id}/artifacts/${fileName}`;
    await assert.rejects(
      store.readArtifact(run, "note.md"),
      /artifact.*path|physical.*filename/i,
      JSON.stringify(fileName),
    );
  }
});

test("a valid direct artifact still round-trips with digest verification", async (t) => {
  const { store, run } = await runFixture(t, "maswe-artifact-roundtrip-");

  assert.equal(await store.readArtifact(run, "note.md"), TRUSTED_ARTIFACT);
});

test("writeArtifact rejects ASCII content larger than the authoritative-file bound", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-write-oversized-ascii-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("artifact size", "test", DEFAULT_CONFIG);

  await assert.rejects(
    store.writeArtifact(
      run,
      "oversized.md",
      "x".repeat(MAX_AUTHORITATIVE_FILE_BYTES + 1),
    ),
    /artifact.*exceeds.*authoritative.*byte limit/i,
  );
});

test("writeArtifact accepts and readArtifact verifies the exact authoritative-file bound", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-write-exact-bound-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("artifact size", "test", DEFAULT_CONFIG);
  const content = "x".repeat(MAX_AUTHORITATIVE_FILE_BYTES);

  const reference = await store.writeArtifact(run, "exact-boundary.md", content);

  assert.equal(reference.attempt, 1);
  assert.equal(reference.sha256, createHash("sha256").update(content).digest("hex"));
  assert.equal(await store.readArtifact(run, "exact-boundary.md"), content);
});

test("writeArtifact enforces the authoritative-file bound in UTF-8 bytes", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-write-multibyte-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("artifact size", "test", DEFAULT_CONFIG);
  const content = "é".repeat(MAX_AUTHORITATIVE_FILE_BYTES / 2 + 1);
  assert.ok(content.length <= MAX_AUTHORITATIVE_FILE_BYTES);
  assert.ok(Buffer.byteLength(content, "utf8") > MAX_AUTHORITATIVE_FILE_BYTES);

  await assert.rejects(
    store.writeArtifact(run, "multibyte.md", content),
    /artifact.*exceeds.*authoritative.*byte limit/i,
  );
});

test("writeArtifact applies the authoritative-file bound after redaction", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-write-redacted-bound-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("artifact size", "test", DEFAULT_CONFIG);
  const content = [
    "-----BEGIN PRIVATE KEY-----",
    "x".repeat(MAX_AUTHORITATIVE_FILE_BYTES),
    "-----END PRIVATE KEY-----",
  ].join("\n");
  assert.ok(Buffer.byteLength(content, "utf8") > MAX_AUTHORITATIVE_FILE_BYTES);

  const reference = await store.writeArtifact(run, "redacted-boundary.md", content);

  assert.equal(reference.attempt, 1);
  assert.equal(
    await store.readArtifact(run, "redacted-boundary.md"),
    "-----BEGIN PRIVATE KEY-----\n[REDACTED]\n-----END PRIVATE KEY-----",
  );
});

test("oversized artifact rejection is publication-atomic and preserves the next attempt", async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-artifact-write-atomic-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = new FileRunStore(cwd);
  const run = await store.create("artifact size", "test", DEFAULT_CONFIG);
  const runPath = path.join(store.root, run.id, "run.json");
  const artifactDirectory = path.join(store.root, run.id, "artifacts");
  const runSnapshot = structuredClone(run);
  const persistedSnapshot = await readFile(runPath, "utf8");
  const directorySnapshot = await directoryContentsOrMissing(artifactDirectory);
  const oversized = `DO-NOT-ECHO-ARTIFACT-CONTENT\n${"x".repeat(MAX_AUTHORITATIVE_FILE_BYTES)}`;

  await assert.rejects(
    store.writeArtifact(run, "handoff.md", oversized),
    (error: Error) => {
      assert.match(error.message, /artifact.*exceeds.*authoritative.*byte limit/i);
      assert.doesNotMatch(error.message, /DO-NOT-ECHO-ARTIFACT-CONTENT/);
      return true;
    },
  );

  assert.deepEqual(run, runSnapshot);
  assert.deepEqual(await store.load(run.id), runSnapshot);
  assert.equal(await readFile(runPath, "utf8"), persistedSnapshot);
  assert.deepEqual(await directoryContentsOrMissing(artifactDirectory), directorySnapshot);

  const reference = await store.writeArtifact(run, "handoff.md", "valid handoff");
  assert.equal(reference.attempt, 1);
  assert.equal(await store.readArtifact(run, "handoff.md"), "valid handoff");
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

test("writeArtifact rejects a symlinked artifact directory", async (t) => {
  const { cwd, store, run, artifactDirectory } = await runFixture(
    t,
    "maswe-artifact-write-directory-link-",
  );
  const retained = path.join(cwd, "retained-write-artifacts");
  await rename(artifactDirectory, retained);
  await symlink(retained, artifactDirectory, process.platform === "win32" ? "junction" : "dir");

  await assert.rejects(
    store.writeArtifact(run, "other.md", "must not follow the directory link"),
    /ordinary.*directory|symbolic/i,
  );
  await assert.rejects(readFile(path.join(retained, "other.attempt-1.md"), "utf8"), /ENOENT/);
});

test("readArtifact rejects persistent symlinks in every artifact namespace ancestor", async (t) => {
  const cases = ["MASWE state", "run store", "run record"] as const;
  for (const label of cases) {
    await t.test(label, async (t) => {
      const { cwd, store, run } = await runFixture(
        t,
        `maswe-artifact-ancestor-${label.replaceAll(" ", "-")}-`,
      );
      const target = label === "MASWE state"
        ? path.dirname(store.root)
        : label === "run store"
          ? store.root
          : path.join(store.root, run.id);
      const retained = path.join(cwd, `retained-${label.replaceAll(" ", "-")}`);
      await rename(target, retained);
      await symlink(retained, target, process.platform === "win32" ? "junction" : "dir");

      await assert.rejects(
        store.readArtifact(run, "note.md"),
        /ordinary.*directory|symbolic/i,
      );
    });
  }
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
