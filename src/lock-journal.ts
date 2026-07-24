import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const LOCK_JOURNAL_DIRECTORY = ".lock-journal-v3";
const MANIFEST_BYTES =
  '{"format":3,"protocol":"immutable-ticket-journal","ticketWidth":20}\n';

export type LockKind = "data" | "admin" | "admin-recovery";

export type LockJournalErrorCode =
  | "LOCK_LIVE_OWNER"
  | "LOCK_DEAD_OWNER"
  | "LOCK_QUEUED"
  | "LOCK_CORRUPT"
  | "LOCK_INCOMPLETE"
  | "LOCK_UNSAFE_PATH_TYPE"
  | "LOCK_OWNERSHIP_LOST"
  | "ADMIN_RECOVERY_CONCURRENT"
  | "LOCK_CLEANUP_FAILED"
  | "LOCK_UNSUPPORTED_FILESYSTEM"
  | "LOCK_TICKET_OVERFLOW";

export class LockJournalError extends Error {
  readonly code: LockJournalErrorCode;

  constructor(
    code: LockJournalErrorCode,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "LockJournalError";
    this.code = code;
  }
}

export interface LockJournalPaths {
  root: string;
  manifest: string;
  kind: string;
  claims: string;
  releases: string;
  tmp: string;
}

const LOCK_KINDS: LockKind[] = ["data", "admin", "admin-recovery"];

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function journalPaths(runDirectory: string, kind: LockKind): LockJournalPaths {
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const kindDirectory = path.join(root, kind);
  return {
    root,
    manifest: path.join(root, "format.json"),
    kind: kindDirectory,
    claims: path.join(kindDirectory, "claims"),
    releases: path.join(kindDirectory, "releases"),
    tmp: path.join(kindDirectory, "tmp"),
  };
}

async function inspectOrdinaryDirectory(
  directory: string,
  options: { allowMissing: boolean },
): Promise<"present" | "missing"> {
  try {
    const stat = await lstat(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Lock journal path is not an ordinary directory: ${directory}`,
      );
    }
    return "present";
  } catch (error) {
    if (error instanceof LockJournalError) throw error;
    if (errno(error) === "ENOENT" && options.allowMissing) return "missing";
    throw error;
  }
}

async function createOrValidateDirectory(directory: string): Promise<void> {
  const state = await inspectOrdinaryDirectory(directory, { allowMissing: true });
  if (state === "present") return;
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  await inspectOrdinaryDirectory(directory, { allowMissing: false });
}

async function readManifest(manifestPath: string): Promise<"missing" | "valid"> {
  let stat;
  try {
    stat = await lstat(manifestPath);
  } catch (error) {
    if (errno(error) === "ENOENT") return "missing";
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Lock journal manifest is not an ordinary regular file: ${manifestPath}`,
    );
  }
  const bytes = await readFile(manifestPath, "utf8");
  if (bytes !== MANIFEST_BYTES) {
    throw new LockJournalError(
      "LOCK_CORRUPT",
      `Lock journal manifest is malformed or unsupported: ${manifestPath}`,
    );
  }
  return "valid";
}

async function publishManifest(manifestPath: string): Promise<void> {
  const temporary = path.join(
    path.dirname(manifestPath),
    `.format.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(MANIFEST_BYTES, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await chmod(temporary, 0o400);
    } catch {
      // Permission modes are advisory on some supported platforms.
    }
    try {
      await link(temporary, manifestPath);
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        throw new LockJournalError(
          "LOCK_UNSUPPORTED_FILESYSTEM",
          `Lock journal manifest requires atomic no-clobber hard-link publication`,
          { cause: error },
        );
      }
    }
    await readManifest(manifestPath);
  } finally {
    if (handle) await handle.close();
    try {
      await unlink(temporary);
    } catch (error) {
      if (errno(error) !== "ENOENT") {
        throw new LockJournalError(
          "LOCK_CLEANUP_FAILED",
          `Failed to remove exact journal manifest temporary path`,
          { cause: error },
        );
      }
    }
  }
}

async function probeHardLink(tmpDirectory: string): Promise<void> {
  const id = randomUUID();
  const source = path.join(tmpDirectory, `.link-probe.${id}.tmp`);
  const published = path.join(tmpDirectory, `.link-probe.${id}.published.tmp`);
  let handle;
  try {
    handle = await open(source, "wx", 0o600);
    await handle.writeFile("maswe-lock-journal-link-probe\n", "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(source, published);
    const bytes = await readFile(published, "utf8");
    if (bytes !== "maswe-lock-journal-link-probe\n") {
      throw new LockJournalError(
        "LOCK_UNSUPPORTED_FILESYSTEM",
        `Hard-link publication produced incoherent contents in ${tmpDirectory}`,
      );
    }
  } catch (error) {
    if (error instanceof LockJournalError) throw error;
    throw new LockJournalError(
      "LOCK_UNSUPPORTED_FILESYSTEM",
      `Hard-link publication is unavailable in ${tmpDirectory}`,
      { cause: error },
    );
  } finally {
    if (handle) await handle.close();
    for (const exactPath of [published, source]) {
      try {
        await unlink(exactPath);
      } catch (error) {
        if (errno(error) !== "ENOENT") {
          throw new LockJournalError(
            "LOCK_CLEANUP_FAILED",
            `Failed to remove exact hard-link probe path`,
            { cause: error },
          );
        }
      }
    }
  }
}

function allFixedDirectories(runDirectory: string): string[] {
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const directories = [root];
  for (const kind of LOCK_KINDS) {
    const paths = journalPaths(runDirectory, kind);
    directories.push(paths.kind, paths.claims, paths.releases, paths.tmp);
  }
  return directories;
}

export async function initializeLockJournal(runDirectory: string): Promise<void> {
  const root = path.join(runDirectory, LOCK_JOURNAL_DIRECTORY);
  const manifestPath = path.join(root, "format.json");
  const rootState = await inspectOrdinaryDirectory(root, { allowMissing: true });
  if (rootState === "missing") await createOrValidateDirectory(root);

  const manifestState = await readManifest(manifestPath);
  const fixedDirectories = allFixedDirectories(runDirectory);
  if (manifestState === "valid") {
    for (const directory of fixedDirectories) {
      const state = await inspectOrdinaryDirectory(directory, { allowMissing: true });
      if (state === "missing") {
        throw new LockJournalError(
          "LOCK_CORRUPT",
          `Lock journal is missing permanent component after manifest publication: ${directory}`,
        );
      }
    }
    return;
  }

  for (const directory of fixedDirectories) {
    await createOrValidateDirectory(directory);
  }
  for (const kind of LOCK_KINDS) {
    await probeHardLink(journalPaths(runDirectory, kind).tmp);
  }
  await publishManifest(manifestPath);
}
