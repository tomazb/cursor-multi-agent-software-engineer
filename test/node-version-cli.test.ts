import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../src/cli-runner.ts";
import {
  CANONICAL_NODE_VERSION,
  UNSUPPORTED_NODE_VERSION_CODE,
} from "../src/node-version.ts";
import { spawnFileCaptured } from "./helpers/child-process.ts";

const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const canonicalVersionPattern = CANONICAL_NODE_VERSION.replaceAll(".", "\\.");
const canonicalRepository = "tomazb/multi-agent-software-engineer";
const formerRepository = "tomazb/cursor-multi-agent-software-engineer";

async function assertPathAbsent(target: string): Promise<void> {
  await assert.rejects(() => access(target), { code: "ENOENT" });
}

async function assertUnsupportedWithoutMasweState(argv: string[]): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-node-guard-"));
  try {
    const command = [...argv, "--cwd", cwd];
    await assert.rejects(
      () => runCli({ argv: command, observedNodeVersion: "25.9.0" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, UNSUPPORTED_NODE_VERSION_CODE);
        assert.match(error.message, /MASWE_UNSUPPORTED_NODE_VERSION/);
        assert.match(error.message, /25\.9\.0/);
        assert.match(
          error.message,
          new RegExp(`nvm install ${canonicalVersionPattern} && nvm use ${canonicalVersionPattern}`),
        );
        return true;
      },
    );
    await assertPathAbsent(path.join(cwd, ".maswe"));
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

test("unsupported Node rejects init before starter configuration is written", async () => {
  await assertUnsupportedWithoutMasweState(["init"]);
});

test("unsupported Node rejects status before store construction or state access", async () => {
  await assertUnsupportedWithoutMasweState(["status"]);
});

test("unsupported Node rejects start before config, runtime, worktree, or run side effects", async () => {
  await assertUnsupportedWithoutMasweState([
    "start",
    "--title",
    "guarded",
    "--request",
    "must not execute",
  ]);
});

test("unsupported Node rejects persisted-run commands before run loading or runtime construction", async () => {
  await assertUnsupportedWithoutMasweState(["run", "nonexistent-run"]);
});

test("supported Node preserves help behavior without creating state", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-node-supported-"));
  const output: string[] = [];
  const originalLog = console.log;
  try {
    console.log = (...values: unknown[]) => output.push(values.map(String).join(" "));
    await runCli({ argv: ["help", "--cwd", cwd], observedNodeVersion: CANONICAL_NODE_VERSION });
    assert.match(output.join("\n"), /Multi-Agent Software Engineer/);
    await assertPathAbsent(path.join(cwd, ".maswe"));
    assert.deepEqual(await readdir(cwd), []);
  } finally {
    console.log = originalLog;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("symlinked CLI entrypoint executes instead of being mistaken for an import", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "maswe-node-symlink-"));
  try {
    const linkedCli = path.join(cwd, "maswe-linked.ts");
    await symlink(cliPath, linkedCli);

    const result = await spawnFileCaptured(
      process.execPath,
      ["--experimental-strip-types", linkedCli, "help"],
      { cwd, timeoutMs: 5_000 },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Multi-Agent Software Engineer/);
    await assertPathAbsent(path.join(cwd, ".maswe"));
    assert.deepEqual(await readdir(cwd), ["maswe-linked.ts"]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("active package, plugin, documentation, and CLI identity use the renamed repository", async () => {
  const packageJson = JSON.parse(
    await readFile(path.join(process.cwd(), "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const lock = JSON.parse(
    await readFile(path.join(process.cwd(), "package-lock.json"), "utf8"),
  ) as Record<string, unknown>;
  const plugin = JSON.parse(
    await readFile(path.join(process.cwd(), ".cursor-plugin/plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  const readme = await readFile(path.join(process.cwd(), "README.md"), "utf8");
  const operations = await readFile(path.join(process.cwd(), "docs/OPERATIONS.md"), "utf8");
  const prd = await readFile(path.join(process.cwd(), "docs/PRD.md"), "utf8");
  const cliResult = await spawnFileCaptured(
    process.execPath,
    ["--experimental-strip-types", cliPath, "help"],
    { cwd: process.cwd(), timeoutMs: 5_000 },
  );

  assert.equal(packageJson.name, "multi-agent-software-engineer");
  assert.equal(lock.name, packageJson.name);
  assert.equal(
    (lock.packages as Record<string, Record<string, unknown>>)[""]?.name,
    packageJson.name,
  );
  assert.equal(plugin.name, "multi-agent-software-engineer");
  assert.equal(plugin.homepage, `https://github.com/${canonicalRepository}`);
  assert.equal(plugin.repository, `https://github.com/${canonicalRepository}`);
  assert.equal(readme.includes(formerRepository), false);
  assert.match(readme, /https:\/\/github\.com\/tomazb\/multi-agent-software-engineer\.git/);
  assert.match(operations, /https:\/\/github\.com\/tomazb\/multi-agent-software-engineer\.git/);
  assert.equal(operations.includes(formerRepository), false);
  assert.match(prd, /\*\*Multi-Agent Software Engineer \(MASWE\)\*\*/);
  assert.equal(cliResult.code, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /^Multi-Agent Software Engineer \(maswe\)$/m);
});

test("pre-rename schema identifiers remain stable compatibility namespaces", async () => {
  const configSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/config.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const runSchema = JSON.parse(
    await readFile(path.join(process.cwd(), "schemas/run-record.schema.json"), "utf8"),
  ) as Record<string, unknown>;
  const oldSchemaBase = `https://github.com/${formerRepository}/schemas/`;

  assert.equal(configSchema.$id, `${oldSchemaBase}config.schema.json`);
  assert.equal(runSchema.$id, `${oldSchemaBase}run-record.schema.json`);
  assert.equal(
    ((runSchema.properties as Record<string, Record<string, unknown>>).config)?.$ref,
    `${oldSchemaBase}config.schema.json`,
  );
});
