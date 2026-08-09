import assert from "node:assert/strict";
import test from "node:test";
import { remoteMatchesRepository } from "../src/github/adapter.ts";

test("remoteMatchesRepository accepts only GitHub hosts", () => {
  assert.equal(
    remoteMatchesRepository("https://github.com/owner/repo.git", "owner/repo"),
    true,
  );
  assert.equal(
    remoteMatchesRepository("git@github.com:owner/repo.git", "owner/repo"),
    true,
  );
  assert.equal(
    remoteMatchesRepository("ssh://git@github.com/owner/repo.git", "owner/repo"),
    true,
  );
  assert.equal(
    remoteMatchesRepository("http://github.com/owner/repo.git", "owner/repo"),
    false,
  );
  assert.equal(
    remoteMatchesRepository("https://gitlab.com/owner/repo.git", "owner/repo"),
    false,
  );
  assert.equal(
    remoteMatchesRepository("https://github.example.com/owner/repo.git", "owner/repo"),
    false,
  );
});
