import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";

export const LOCK_JOURNAL_DIRECTORY = ".lock-journal-v3";
export const MAX_LOCK_TICKET = 99_999_999_999_999_999_999n;
const TICKET_WIDTH = 20;
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

export type ClaimOperation =
  | "store-write"
  | "artifact-write"
  | "data-unlock"
  | "admin-serialize"
  | "admin-unlock"
  | "admin-recovery"
  | "queued-cancel";

export interface ClaimProcessIdentity {
  startedAt: string;
  platformIdentity: string | null;
}

export interface ClaimRecordV3 {
  format: 3;
  record: "claim";
  kind: LockKind;
  ticket: string;
  owner: string;
  pid: number;
  process: ClaimProcessIdentity;
  at: string;
  operation: ClaimOperation;
  claimDigest: string;
}

export interface ReleaseRecordV3 {
  format: 3;
  record: "release";
  kind: LockKind;
  ticket: string;
  owner: string;
  claimDigest: string;
  targetMode: "claim";
  releaseDigest: string;
}

export interface CanonicalRecord<T> {
  record: T;
  bytes: string;
}

export interface JournalScan {
  claims: ClaimRecordV3[];
  releases: Map<string, ReleaseRecordV3>;
  highestTicket: bigint;
}

const LOCK_KINDS: LockKind[] = ["data", "admin", "admin-recovery"];
const CLAIM_OPERATIONS: ClaimOperation[] = [
  "store-write",
  "artifact-write",
  "data-unlock",
  "admin-serialize",
  "admin-unlock",
  "admin-recovery",
  "queued-cancel",
];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const CLAIM_BASENAME_PATTERN = /^([0-9]{20})\.json$/;
const TEMP_BASENAME_PATTERN =
  /^\.(?:claim|release|link-probe)\.[0-9a-f-]+(?:\.published)?\.tmp$/;

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digest(bytes: string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function corrupt(message: string, cause?: unknown): LockJournalError {
  return new LockJournalError(
    "LOCK_CORRUPT",
    message,
    cause === undefined ? {} : { cause },
  );
}

export function formatLockTicket(ticket: bigint): string {
  if (ticket > MAX_LOCK_TICKET) {
    throw new LockJournalError(
      "LOCK_TICKET_OVERFLOW",
      `Lock ticket exceeds the maximum ${MAX_LOCK_TICKET}`,
    );
  }
  if (ticket < 1n) throw corrupt("Published lock tickets begin at one");
  return ticket.toString(10).padStart(TICKET_WIDTH, "0");
}

function parseLockTicket(value: unknown, options: { allowZero?: boolean } = {}): bigint {
  if (typeof value !== "string" || !/^[0-9]{20}$/.test(value)) {
    throw corrupt(`Lock ticket is not a canonical ${TICKET_WIDTH}-digit decimal string`);
  }
  const ticket = BigInt(value);
  if (ticket > MAX_LOCK_TICKET) {
    throw new LockJournalError("LOCK_TICKET_OVERFLOW", `Lock ticket overflows protocol range`);
  }
  if (ticket === 0n && options.allowZero) return ticket;
  if (ticket < 1n || formatLockTicket(ticket) !== value) {
    throw corrupt("Lock ticket encoding is noncanonical or reserved");
  }
  return ticket;
}

function validateClaimInput(input: {
  kind: LockKind;
  ticket: bigint;
  owner: string;
  pid: number;
  process: ClaimProcessIdentity;
  at: string;
  operation: ClaimOperation;
}): void {
  if (!LOCK_KINDS.includes(input.kind)) throw corrupt("Claim kind is invalid");
  formatLockTicket(input.ticket);
  if (!UUID_PATTERN.test(input.owner)) throw corrupt("Claim owner is not a canonical UUID");
  if (!Number.isInteger(input.pid) || input.pid <= 0) throw corrupt("Claim PID is invalid");
  if (
    !validTimestamp(input.process.startedAt) ||
    (input.process.platformIdentity !== null &&
      (typeof input.process.platformIdentity !== "string" ||
        input.process.platformIdentity.length === 0))
  ) {
    throw corrupt("Claim process identity is invalid");
  }
  if (!validTimestamp(input.at)) throw corrupt("Claim timestamp is invalid");
  if (!CLAIM_OPERATIONS.includes(input.operation)) throw corrupt("Claim operation is invalid");
}

export function canonicalClaim(input: {
  kind: LockKind;
  ticket: bigint;
  owner: string;
  pid: number;
  process: ClaimProcessIdentity;
  at: string;
  operation: ClaimOperation;
}): CanonicalRecord<ClaimRecordV3> {
  validateClaimInput(input);
  const withoutDigest = {
    format: 3 as const,
    record: "claim" as const,
    kind: input.kind,
    ticket: formatLockTicket(input.ticket),
    owner: input.owner,
    pid: input.pid,
    process: {
      startedAt: input.process.startedAt,
      platformIdentity: input.process.platformIdentity,
    },
    at: input.at,
    operation: input.operation,
  };
  const claimDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: ClaimRecordV3 = { ...withoutDigest, claimDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

export function parseClaimBytes(
  bytes: string,
  expectedKind: LockKind,
  expectedTicket: bigint,
): ClaimRecordV3 {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw corrupt("Claim is not valid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("Claim is not a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "format",
      "record",
      "kind",
      "ticket",
      "owner",
      "pid",
      "process",
      "at",
      "operation",
      "claimDigest",
    ]) ||
    candidate.format !== 3 ||
    candidate.record !== "claim" ||
    candidate.kind !== expectedKind ||
    typeof candidate.ticket !== "string" ||
    parseLockTicket(candidate.ticket) !== expectedTicket ||
    typeof candidate.owner !== "string" ||
    typeof candidate.pid !== "number" ||
    !candidate.process ||
    typeof candidate.process !== "object" ||
    Array.isArray(candidate.process) ||
    typeof candidate.at !== "string" ||
    typeof candidate.operation !== "string" ||
    typeof candidate.claimDigest !== "string"
  ) {
    throw corrupt("Claim schema, kind, or ticket is invalid");
  }
  const processIdentity = candidate.process as Record<string, unknown>;
  if (
    !exactKeys(processIdentity, ["startedAt", "platformIdentity"]) ||
    typeof processIdentity.startedAt !== "string" ||
    (processIdentity.platformIdentity !== null &&
      typeof processIdentity.platformIdentity !== "string")
  ) {
    throw corrupt("Claim process identity schema is invalid");
  }
  const rebuilt = canonicalClaim({
    kind: expectedKind,
    ticket: expectedTicket,
    owner: candidate.owner,
    pid: candidate.pid,
    process: {
      startedAt: processIdentity.startedAt,
      platformIdentity: processIdentity.platformIdentity,
    },
    at: candidate.at,
    operation: candidate.operation as ClaimOperation,
  });
  if (
    candidate.claimDigest !== rebuilt.record.claimDigest ||
    bytes !== rebuilt.bytes
  ) {
    throw corrupt("Claim bytes are noncanonical or digest-mismatched");
  }
  return rebuilt.record;
}

export function canonicalRelease(
  claim: ClaimRecordV3,
): CanonicalRecord<ReleaseRecordV3> {
  if (!DIGEST_PATTERN.test(claim.claimDigest)) throw corrupt("Claim digest is invalid");
  const ticket = parseLockTicket(claim.ticket);
  const validatedClaim = parseClaimBytes(canonicalClaim({
    kind: claim.kind,
    ticket,
    owner: claim.owner,
    pid: claim.pid,
    process: claim.process,
    at: claim.at,
    operation: claim.operation,
  }).bytes, claim.kind, ticket);
  if (validatedClaim.claimDigest !== claim.claimDigest) {
    throw corrupt("Release target claim digest is inconsistent");
  }
  const withoutDigest = {
    format: 3 as const,
    record: "release" as const,
    kind: claim.kind,
    ticket: claim.ticket,
    owner: claim.owner,
    claimDigest: claim.claimDigest,
    targetMode: "claim" as const,
  };
  const releaseDigest = digest(`${JSON.stringify(withoutDigest)}\n`);
  const record: ReleaseRecordV3 = { ...withoutDigest, releaseDigest };
  return { record, bytes: `${JSON.stringify(record)}\n` };
}

export function releaseBasename(claim: ClaimRecordV3): string {
  if (!UUID_PATTERN.test(claim.owner) || !DIGEST_PATTERN.test(claim.claimDigest)) {
    throw corrupt("Cannot derive release pathname from an invalid claim identity");
  }
  return `${claim.kind}.${claim.ticket}.${claim.owner}.${claim.claimDigest.slice("sha256:".length)}.json`;
}

export function parseReleaseBytes(
  bytes: string,
  expectedClaim: ClaimRecordV3,
): ReleaseRecordV3 {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch (error) {
    throw corrupt("Release is not valid JSON", error);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw corrupt("Release is not a JSON object");
  }
  const candidate = value as Record<string, unknown>;
  if (
    !exactKeys(candidate, [
      "format",
      "record",
      "kind",
      "ticket",
      "owner",
      "claimDigest",
      "targetMode",
      "releaseDigest",
    ]) ||
    candidate.format !== 3 ||
    candidate.record !== "release" ||
    candidate.kind !== expectedClaim.kind ||
    candidate.ticket !== expectedClaim.ticket ||
    candidate.owner !== expectedClaim.owner ||
    candidate.claimDigest !== expectedClaim.claimDigest ||
    candidate.targetMode !== "claim" ||
    typeof candidate.releaseDigest !== "string"
  ) {
    throw corrupt("Release target or schema is invalid");
  }
  const rebuilt = canonicalRelease(expectedClaim);
  if (
    candidate.releaseDigest !== rebuilt.record.releaseDigest ||
    bytes !== rebuilt.bytes
  ) {
    throw corrupt("Release bytes are noncanonical or digest-mismatched");
  }
  return rebuilt.record;
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

async function readOrdinaryRecord(recordPath: string): Promise<string> {
  let stat;
  try {
    stat = await lstat(recordPath);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw corrupt(`Published journal record disappeared during validation: ${recordPath}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new LockJournalError(
      "LOCK_UNSAFE_PATH_TYPE",
      `Published journal entry is not an ordinary regular file: ${recordPath}`,
    );
  }
  return readFile(recordPath, "utf8");
}

async function validateTemporaryEntries(tmpDirectory: string): Promise<void> {
  const entries = await readdir(tmpDirectory);
  for (const basename of entries) {
    const temporaryPath = path.join(tmpDirectory, basename);
    const stat = await lstat(temporaryPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new LockJournalError(
        "LOCK_UNSAFE_PATH_TYPE",
        `Journal temporary entry is not an ordinary regular file: ${temporaryPath}`,
      );
    }
    if (!TEMP_BASENAME_PATTERN.test(basename)) {
      throw corrupt(`Journal temporary entry has an ambiguous name: ${basename}`);
    }
  }
}

export async function scanLockJournal(
  runDirectory: string,
  kind: LockKind,
): Promise<JournalScan> {
  await initializeLockJournal(runDirectory);
  const paths = journalPaths(runDirectory, kind);
  await validateTemporaryEntries(paths.tmp);

  const claimEntries = await readdir(paths.claims);
  const claimsByTicket = new Map<bigint, ClaimRecordV3>();
  for (const basename of claimEntries) {
    const match = CLAIM_BASENAME_PATTERN.exec(basename);
    if (!match) throw corrupt(`Published claim filename is malformed: ${basename}`);
    const ticket = parseLockTicket(match[1]);
    if (claimsByTicket.has(ticket)) {
      throw corrupt(`Published claim ticket has a duplicate interpretation: ${ticket}`);
    }
    const bytes = await readOrdinaryRecord(path.join(paths.claims, basename));
    claimsByTicket.set(ticket, parseClaimBytes(bytes, kind, ticket));
  }

  const orderedTickets = [...claimsByTicket.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0
  );
  for (let index = 0; index < orderedTickets.length; index += 1) {
    const expected = BigInt(index + 1);
    if (orderedTickets[index] !== expected) {
      throw corrupt(
        `Published claim range is not contiguous: expected ${formatLockTicket(expected)}`,
      );
    }
  }

  const releases = new Map<string, ReleaseRecordV3>();
  for (const basename of await readdir(paths.releases)) {
    const releasePath = path.join(paths.releases, basename);
    const bytes = await readOrdinaryRecord(releasePath);
    let preliminary: unknown;
    try {
      preliminary = JSON.parse(bytes);
    } catch (error) {
      throw corrupt(`Published release is not valid JSON: ${basename}`, error);
    }
    if (!preliminary || typeof preliminary !== "object" || Array.isArray(preliminary)) {
      throw corrupt(`Published release is not a JSON object: ${basename}`);
    }
    const candidate = preliminary as Record<string, unknown>;
    const ticket = parseLockTicket(candidate.ticket);
    const claim = claimsByTicket.get(ticket);
    if (!claim) {
      throw corrupt(`Published release targets a missing claim: ${basename}`);
    }
    const expectedBasename = releaseBasename(claim);
    if (basename !== expectedBasename || releases.has(claim.ticket)) {
      throw corrupt(`Published release pathname is conflicting or noncanonical: ${basename}`);
    }
    releases.set(claim.ticket, parseReleaseBytes(bytes, claim));
  }

  return {
    claims: orderedTickets.map((ticket) => claimsByTicket.get(ticket)!),
    releases,
    highestTicket: orderedTickets.at(-1) ?? 0n,
  };
}
