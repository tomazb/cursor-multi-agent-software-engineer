import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJsonPath = path.join(repositoryRoot, "package.json");
const guardPath = path.join(repositoryRoot, "scripts", "verify-node-version.mjs");

interface PackageJson {
  scripts?: Record<string, string>;
}

async function loadScripts(): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as PackageJson;
  return packageJson.scripts ?? {};
}

test("all public repository scripts fail through the Node guard before substantive work", async () => {
  const scripts = await loadScripts();
  assert.equal(scripts["verify:node"], "node scripts/verify-node-version.mjs");
  assert.equal(scripts.preinstall, "node scripts/verify-node-version.mjs");

  for (const name of ["typecheck", "test", "build", "check", "pack:dry", "dev", "start"]) {
    const command = scripts[name];
    assert.ok(command, `missing script ${name}`);
    assert.match(command, /^npm run verify:node && /, `${name} must guard first`);
    assert.equal((command.match(/npm run verify:node/g) ?? []).length, 1, `${name} repeats the guard`);
    assert.doesNotMatch(command, /\bnvm\b|\.nvm\/versions\/node|\$HOME\/\.nvm/);
  }

  assert.equal(scripts.check, "npm run verify:node && npm run _typecheck && npm run _test && npm run _build");
  assert.equal(scripts.typecheck, "npm run verify:node && npm run _typecheck");
  assert.equal(scripts.test, "npm run verify:node && npm run _test");
  assert.equal(scripts.build, "npm run verify:node && npm run _build");
  assert.equal(scripts["pack:dry"], "npm run verify:node && npm pack --dry-run");
  assert.equal(scripts.dev, "npm run verify:node && node --experimental-strip-types src/cli.ts");
  assert.equal(scripts.start, "npm run verify:node && node dist/cli.js");
  assert.equal(scripts._typecheck, "tsc -p tsconfig.json --noEmit");
  assert.equal(scripts._test, "node --experimental-strip-types --test test/*.test.ts");
  assert.equal(scripts._build, "tsc -p tsconfig.build.json");
});

test("current supported runtime passes the public standalone guard", () => {
  const result = spawnSync(process.execPath, [guardPath], {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 5_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("standalone assertion seam rejects unsupported Node with stable diagnostics", () => {
  const guardUrl = pathToFileURL(guardPath).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { assertSupportedNodeVersion } from ${JSON.stringify(guardUrl)};
       try {
         assertSupportedNodeVersion("25.9.0");
         process.exitCode = 9;
       } catch (error) {
         process.stderr.write(String(error.code) + "\\n" + String(error.message));
         process.exitCode = 1;
       }`,
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 5_000 },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /^MASWE_UNSUPPORTED_NODE_VERSION\n/);
  assert.match(result.stderr, /25\.9\.0/);
  assert.match(result.stderr, />=22\.22\.2 <23 \|\| >=24\.18\.0 <25/);
  assert.match(result.stderr, /24\.18\.0/);
  assert.match(result.stderr, /nvm install && nvm use/);
});

test("project npm policy enables strict engine rejection", async () => {
  assert.equal(await readFile(path.join(repositoryRoot, ".npmrc"), "utf8"), "engine-strict=true\n");
});
