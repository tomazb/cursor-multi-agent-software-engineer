import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CANONICAL_NODE_VERSION,
  NODE_COMPATIBILITY_FLOOR,
  SUPPORTED_NODE_RANGE,
  UNSUPPORTED_NODE_VERSION_CODE,
  assertSupportedNodeVersion,
  isSupportedNodeVersion,
  parseNodeVersion,
} from "../src/node-version.ts";

const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const standaloneGuardPath = path.join(repositoryRoot, "scripts", "verify-node-version.mjs");

const supportedCases = [
  "22.22.2",
  "22.22.3",
  "22.23.1",
  "22.99.99",
  "24.18.0",
  "24.18.1",
  "24.99.99",
];

const unsupportedCases = [
  "0.0.0",
  "21.99.99",
  "22.0.0",
  "22.22.1",
  "23.0.0",
  "23.99.99",
  "24.0.0",
  "24.17.99",
  "25.0.0",
  "25.9.0",
  "26.0.0",
  "99.0.0",
];

const malformedCases = [
  "",
  "22",
  "22.22",
  "22.22.2.0",
  "v22.22.2",
  "22.22.2-rc.1",
  "22.22.2+build",
  "22.-1.2",
  "22.a.2",
  " 22.22.2",
  "22.22.2 ",
  "01.2.3",
];

test("Node runtime constants match the approved contract", () => {
  assert.equal(CANONICAL_NODE_VERSION, "24.18.0");
  assert.equal(NODE_COMPATIBILITY_FLOOR, "22.22.2");
  assert.equal(SUPPORTED_NODE_RANGE, ">=22.22.2 <23 || >=24.18.0 <25");
  assert.equal(UNSUPPORTED_NODE_VERSION_CODE, "MASWE_UNSUPPORTED_NODE_VERSION");
});

test("Node runtime policy accepts only the approved Node 22 and Node 24 ranges", () => {
  for (const version of supportedCases) {
    assert.equal(isSupportedNodeVersion(version), true, `expected ${version} to be supported`);
    assert.deepEqual(parseNodeVersion(version), version.split(".").map(Number));
    assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  }

  for (const version of unsupportedCases) {
    assert.equal(isSupportedNodeVersion(version), false, `expected ${version} to be unsupported`);
    assert.throws(
      () => assertSupportedNodeVersion(version),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, UNSUPPORTED_NODE_VERSION_CODE);
        assert.match(error.message, new RegExp(UNSUPPORTED_NODE_VERSION_CODE));
        assert.match(error.message, new RegExp(version.replaceAll(".", "\\.")));
        assert.match(error.message, />=22\.22\.2 <23 \|\| >=24\.18\.0 <25/);
        assert.match(error.message, /24\.18\.0/);
        assert.match(error.message, /nvm install 24\.18\.0 && nvm use 24\.18\.0/);
        assert.match(error.message, /optional/i);
        return true;
      },
    );
  }
});

test("malformed Node versions fail closed", () => {
  for (const version of malformedCases) {
    assert.throws(() => parseNodeVersion(version), /invalid Node\.js version/i, version);
    assert.equal(isSupportedNodeVersion(version), false, version);
    assert.throws(
      () => assertSupportedNodeVersion(version),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as Error & { code?: string }).code, UNSUPPORTED_NODE_VERSION_CODE);
        return true;
      },
      version,
    );
  }
});

test("repository metadata is synchronized with the approved Node policy", async () => {
  const nvmrc = await readFile(path.join(repositoryRoot, ".nvmrc"), "utf8");
  const npmrc = await readFile(path.join(repositoryRoot, ".npmrc"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(repositoryRoot, "package.json"), "utf8")) as {
    engines?: { node?: string };
  };
  const packageLock = JSON.parse(
    await readFile(path.join(repositoryRoot, "package-lock.json"), "utf8"),
  ) as { packages?: Record<string, { engines?: { node?: string } }> };

  assert.equal(nvmrc, `${CANONICAL_NODE_VERSION}\n`);
  assert.equal(npmrc, "engine-strict=true\n");
  assert.equal(packageJson.engines?.node, SUPPORTED_NODE_RANGE);
  assert.equal(packageLock.packages?.[""]?.engines?.node, SUPPORTED_NODE_RANGE);
});

test("standalone and TypeScript guards expose the same constants and decisions", () => {
  const scriptUrl = pathToFileURL(standaloneGuardPath).href;
  const probe = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import * as p from ${JSON.stringify(scriptUrl)};
       const versions = ${JSON.stringify([...supportedCases, ...unsupportedCases, ...malformedCases])};
       process.stdout.write(JSON.stringify({
         canonical: p.CANONICAL_NODE_VERSION,
         floor: p.NODE_COMPATIBILITY_FLOOR,
         range: p.SUPPORTED_NODE_RANGE,
         code: p.UNSUPPORTED_NODE_VERSION_CODE,
         decisions: versions.map((version) => [version, p.isSupportedNodeVersion(version)]),
       }));`,
    ],
    { cwd: repositoryRoot, encoding: "utf8", timeout: 5_000 },
  );

  assert.equal(probe.status, 0, probe.stderr);
  const result = JSON.parse(probe.stdout) as {
    canonical: string;
    floor: string;
    range: string;
    code: string;
    decisions: Array<[string, boolean]>;
  };
  assert.deepEqual(
    {
      canonical: result.canonical,
      floor: result.floor,
      range: result.range,
      code: result.code,
    },
    {
      canonical: CANONICAL_NODE_VERSION,
      floor: NODE_COMPATIBILITY_FLOOR,
      range: SUPPORTED_NODE_RANGE,
      code: UNSUPPORTED_NODE_VERSION_CODE,
    },
  );
  for (const [version, supported] of result.decisions) {
    assert.equal(supported, isSupportedNodeVersion(version), version);
  }
});

test("standalone guard is dependency-free and does not mutate or switch runtimes", async () => {
  const source = await readFile(standaloneGuardPath, "utf8");
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:url"]);
  assert.doesNotMatch(source, /from\s+["']node:child_process["']/);
  assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/);
  assert.doesNotMatch(source, /\b(?:writeFile|appendFile|mkdir|rmSync|unlink|rename)\s*\(/);
});
