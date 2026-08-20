import assert from "node:assert/strict";
import test from "node:test";
import { pathAllowed } from "../src/git-workspace.ts";

const cases: Array<[pattern: string, candidate: string, expected: boolean]> = [
  ["**/*.ts", "index.ts", true],
  ["**/*.ts", "src/index.ts", true],
  ["**/*.ts", "src/index.tsx", false],
  ["src/*.ts", "src/.ts", true],
  ["src/*.ts", "src/nested/x.ts", false],
  ["src/?.ts", "src/a.ts", true],
  ["src/?.ts", "src/ab.ts", false],
  ["src/?.ts", "src//.ts", false],
  ["src/**.ts", "src/.ts", true],
  ["src/**.ts", "src/nested/x.ts", true],
  ["**/README.md", "README.md", true],
  ["**/README.md", "docs/README.md", true],
  ["**/*", "README.md", true],
  ["**/*", ".env.example", true],
  ["**/*", "config/.env", true],
  ["src\\**\\*.ts", "src\\nested\\x.ts", true],
  ["src/a+b[1].ts", "src/a+b[1].ts", true],
  ["src/*.ts", "src/a.ts.bak", false],
];

test("allowed-path globs use the documented portable token semantics", () => {
  for (const [pattern, candidate, expected] of cases) {
    assert.equal(pathAllowed(candidate, [pattern]), expected, `${pattern} vs ${candidate}`);
  }
});
