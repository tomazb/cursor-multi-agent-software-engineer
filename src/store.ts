import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkflowEventType,
  WorkflowState,
} from "./domain.ts";
import { assertConfig, migrateConfig } from "./config.ts";
import { assertSafeRunId } from "./git-workspace.ts";
import { redactSecrets } from "./redaction.ts";
import { transition } from "./state-machine.ts";
import {
  acquireDirectoryLock,
  classifyLockPath,
  LockProtocolError,
  recoverClassifiedLock,
  removeOwnedDirectory,
  type ClassifiedLock,
  type LockOwnershipHandle,
} from "./lock-protocol.ts";

function now(): string {
  return new Date().toISOString();
}

function makeRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

interface LockMeta {
  pid: number;
  owner: string;
  at: string;
}

export interface ReclaimLockOptions {
  /** @deprecated Automatic reclaim is removed; use FileRunStore.unlock. */
  afterInspect?: (meta: LockMeta) => Promise<void>;
}

function lockMetaFromClassified(classified: ClassifiedLock): LockMeta | undefined {
  if (
    classified.state === "valid-live" ||
    classified.state === "valid-dead" ||
    classified.state === "legacy-live" ||
    classified.state === "legacy-dead"
  ) {
    return {
      pid: classified.record.pid,
      owner: classified.record.owner,
      at: classified.record.at,
    };
  }
  return undefined;
}

export interface RunStore {
  create(title: string, request: string, config: MasweConfig): Promise<RunRecord>;
  save(run: RunRecord): Promise<void>;
  load(runId: string): Promise<RunRecord>;
  list(): Promise<RunRecord[]>;
  applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord>;
  writeArtifact(run: RunRecord, name: string, content: string): Promise<ArtifactReference>;
  readArtifact(run: RunRecord, name: string): Promise<string | undefined>;
}

export function migrateRunRecord(raw: unknown): RunRecord {
  if (!raw || typeof raw !== "object") {
    throw new Error("Run record is not a JSON object");
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.schemaVersion !== 1) {
    throw new Error(
      `Unsupported run schemaVersion ${String(candidate.schemaVersion)}; expected 1`,
    );
  }

  const artifactsRaw = Array.isArray(candidate.artifacts) ? candidate.artifacts : [];
  const artifacts: ArtifactReference[] = artifactsRaw.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error(`Run artifact[${index}] is invalid`);
    }
    const artifact = item as Record<string, unknown>;
    const name = String(artifact.name ?? "");
    if (!name) throw new Error(`Run artifact[${index}] is missing name`);
    return {
      name,
      logicalName: String(artifact.logicalName ?? name),
      attempt: typeof artifact.attempt === "number" && artifact.attempt >= 1 ? artifact.attempt : 1,
      path: String(artifact.path ?? ""),
      sha256: String(artifact.sha256 ?? ""),
      createdAt: String(artifact.createdAt ?? now()),
    };
  });

  const migratedConfig = migrateConfig(candidate.config);
  // Same type/range assertion as project config load — never apply env overrides here.
  assertConfig(migratedConfig);

  if (candidate.version === undefined) {
    return {
      ...(candidate as unknown as RunRecord),
      version: 1,
      artifacts,
      config: migratedConfig,
    };
  }

  if (typeof candidate.version !== "number" || candidate.version < 1) {
    throw new Error("Run record version is missing or invalid (fail-closed)");
  }

  return {
    ...(candidate as unknown as RunRecord),
    config: migratedConfig,
    artifacts:
      artifacts.length > 0
        ? artifacts
        : ((candidate as unknown as RunRecord).artifacts ?? []),
  };
}

export class FileRunStore implements RunStore {
  readonly root: string;
  private readonly cwd: string;
  private readonly lockRetries: number;

  constructor(
    cwd: string,
    options: { lockStaleMs?: number; lockRetries?: number } = {},
  ) {
    this.cwd = cwd;
    this.root = path.join(cwd, ".maswe", "runs");
    // lockStaleMs retained for API compatibility; reclaim is ownership/PID based, not age based.
    void options.lockStaleMs;
    this.lockRetries = options.lockRetries ?? 50;
  }

  private runDirectory(runId: string): string {
    assertSafeRunId(runId);
    return path.join(this.root, runId);
  }

  private runFile(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private lockFile(runId: string): string {
    return path.join(this.runDirectory(runId), ".lock");
  }

  private adminLockFile(runId: string): string {
    return path.join(this.runDirectory(runId), ".admin.lock");
  }

  private adminRecoveryMarker(runId: string): string {
    return path.join(this.runDirectory(runId), ".admin.lock.recovering");
  }

  private async readRunFile(runId: string): Promise<RunRecord> {
    const raw = await readFile(this.runFile(runId), "utf8");
    return migrateRunRecord(JSON.parse(raw));
  }

  /**
   * Short-lived administrative mutex shared by data-lock acquisition and unlock.
   *
   * Stale/corrupt/incomplete admin locks are NEVER auto-reclaimed (that raced with
   * replacement owners). Operators must run `maswe unlock-admin <run-id>`.
   */
  private async withAdminLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const adminPath = this.adminLockFile(runId);
    const recoveryMarker = this.adminRecoveryMarker(runId);
    const adminRetries = Math.max(this.lockRetries * 4, 8);
    let ownership: LockOwnershipHandle | undefined;

    for (let attempt = 0; attempt < adminRetries; attempt += 1) {
      const marker = await classifyLockPath(recoveryMarker, "admin-recovery");
      if (marker.state !== "absent") {
        if (marker.state === "valid-live") {
          ownership = undefined;
          await sleep(5 + attempt * 2);
          continue;
        }
        throw new LockProtocolError(
          marker.state === "unsafe"
            ? "LOCK_UNSAFE_PATH_TYPE"
            : marker.state === "multiple" || marker.state === "corrupt" || marker.state === "legacy-corrupt"
              ? "LOCK_CORRUPT"
              : "LOCK_INCOMPLETE",
          `Run ${runId} administrative recovery marker is not safely absent at ${recoveryMarker}. ` +
            `After confirming no recovery actor is active, run: maswe unlock-admin ${runId} --force`,
          { state: marker.state },
        );
      }

      try {
        ownership = await acquireDirectoryLock(adminPath, "admin");
      } catch (error) {
        if (
          error instanceof LockProtocolError &&
          error.code === "LOCK_LIVE_OWNER"
        ) {
          ownership = undefined;
          await sleep(5 + attempt * 2);
          continue;
        }
        throw error;
      }

      const markerAfter = await classifyLockPath(recoveryMarker, "admin-recovery");
      if (markerAfter.state === "absent") break;
      try {
        await removeOwnedDirectory(ownership);
      } finally {
        ownership = undefined;
      }
      if (markerAfter.state === "valid-live") {
        await sleep(5 + attempt * 2);
        continue;
      }
      throw new LockProtocolError(
        "LOCK_INCOMPLETE",
        `Run ${runId} administrative recovery marker appeared during admin acquisition; refusing entry`,
        { state: markerAfter.state },
      );
    }
    if (!ownership) {
      throw new Error(
        `Run ${runId} admin lock contention: could not serialize unlock/acquire. ` +
          `If a stale admin lock or recovery marker remains, run: maswe unlock-admin ${runId}`,
      );
    }

    let value: T | undefined;
    let primaryError: unknown;
    try {
      value = await fn();
    } catch (error) {
      primaryError = error;
    }
    try {
      await removeOwnedDirectory(ownership);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `Run ${runId} admin operation and owned-lock cleanup both failed`,
        );
      }
      throw cleanupError;
    }
    if (primaryError !== undefined) throw primaryError;
    return value as T;
  }

  /** Test hook exposing the admin critical section with barrier-friendly acquisition. */
  async withAdminLockForTest<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    return this.withAdminLock(runId, fn);
  }

  /**
   * Explicit administrative recovery for `.admin.lock`.
   *
   * Serialized through an exclusive recovery marker directory so two reclaimers
   * cannot both proceed, and a stale observer cannot delete a replacement owner.
   * Never deletes `.admin.lock` based only on a previously observed owner token.
   */
  async unlockAdmin(
    runId: string,
    options: {
      force?: boolean;
      /** Test hook after observing the current admin lock, before recovery proceeds. */
      afterObserve?: (meta: LockMeta | undefined) => Promise<void>;
    } = {},
  ): Promise<void> {
    assertSafeRunId(runId);
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const adminPath = this.adminLockFile(runId);
    const recoveryMarker = this.adminRecoveryMarker(runId);
    const markerRetries = Math.max(this.lockRetries, 8);
    let markerOwnership: LockOwnershipHandle | undefined;
    let joinedBootstrapRace = false;
    for (let attempt = 0; attempt < markerRetries; attempt += 1) {
      try {
        markerOwnership = await acquireDirectoryLock(
          recoveryMarker,
          "admin-recovery",
          {
            recovery: {
              mode: "admin-unlock",
              force: options.force === true,
            },
          },
        );
        break;
      } catch (error) {
        if (!(error instanceof LockProtocolError)) throw error;
        const existing = await classifyLockPath(recoveryMarker, "admin-recovery");
        if (existing.state === "valid-live") {
          throw new LockProtocolError(
            "ADMIN_RECOVERY_CONCURRENT",
            `Run ${runId} administrative recovery is owned by live pid ${existing.record.pid}; --force never revokes a live recovery marker`,
            { state: existing.state },
          );
        }
        if (
          joinedBootstrapRace &&
          existing.state !== "absent" &&
          existing.state !== "valid-dead"
        ) {
          throw new LockProtocolError(
            "ADMIN_RECOVERY_CONCURRENT",
            `Run ${runId} administrative recovery bootstrap was won by another actor`,
            { state: existing.state },
          );
        }
        if (!options.force) throw error;
        if (
          existing.state === "unsafe" ||
          existing.state === "multiple" ||
          existing.state === "legacy-live" ||
          existing.state === "legacy-dead" ||
          existing.state === "legacy-corrupt"
        ) {
          throw error;
        }
        if (existing.state !== "absent") {
          try {
            await recoverClassifiedLock(existing, { force: true });
          } catch (cleanupError) {
            if (
              !(
                cleanupError instanceof LockProtocolError &&
                cleanupError.code === "LOCK_OWNERSHIP_LOST"
              )
            ) {
              throw cleanupError;
            }
          }
        }
        joinedBootstrapRace = true;
        // Cleanup is not ownership. Every contender returns to exclusive mkdir.
        continue;
      }
    }
    if (!markerOwnership) {
      throw new LockProtocolError(
        "ADMIN_RECOVERY_CONCURRENT",
        `Run ${runId} administrative recovery contention exhausted before a marker was owned`,
      );
    }

    let primaryError: unknown;
    try {
      const current = await classifyLockPath(adminPath, "admin");
      const observed = lockMetaFromClassified(current);
      if (options.afterObserve) await options.afterObserve(observed);
      await recoverClassifiedLock(current, { force: options.force === true });
    } catch (error) {
      primaryError = error;
    }
    try {
      await removeOwnedDirectory(markerOwnership);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `Run ${runId} admin recovery and marker cleanup both failed`,
        );
      }
      throw cleanupError;
    }
    if (primaryError !== undefined) throw primaryError;
  }

  private async acquireLock(runId: string): Promise<LockOwnershipHandle> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const lockPath = this.lockFile(runId);

    for (let attempt = 0; attempt < this.lockRetries; attempt += 1) {
      const outcome = await this.withAdminLock(runId, async () => {
        try {
          return {
            kind: "acquired" as const,
            ownership: await acquireDirectoryLock(lockPath, "data"),
          };
        } catch (error) {
          if (
            error instanceof LockProtocolError &&
            error.code === "LOCK_LIVE_OWNER"
          ) {
            return { kind: "live" as const };
          }
          throw error;
        }
      });

      if (outcome.kind === "acquired") return outcome.ownership;
      // Sleep outside the admin lock so unlock can proceed.
      await sleep(20 + attempt * 10);
    }
    throw new Error(
      `Run ${runId} lock contention: could not acquire exclusive lock. If the holder is dead, run: maswe unlock ${runId}`,
    );
  }

  /**
   * Explicit unlock for abandoned locks. Refuses to remove a live holder's lock
   * unless `force` is set. Coordinates with acquisition through `.admin.lock` so
   * a concurrent unlock can never delete a replacement owner's data lock.
   */
  async unlock(
    runId: string,
    options: {
      force?: boolean;
      /** Test hook after initial validation, before the admin-protected remove. */
      afterValidate?: (meta: LockMeta | undefined) => Promise<void>;
    } = {},
  ): Promise<void> {
    const lockPath = this.lockFile(runId);
    const observed = await classifyLockPath(lockPath, "data");
    if (options.afterValidate) await options.afterValidate(lockMetaFromClassified(observed));

    await this.withAdminLock(runId, async () => {
      const current = await classifyLockPath(lockPath, "data");
      await recoverClassifiedLock(current, { force: options.force === true });
    });
  }

  private async releaseLock(runId: string, ownership: LockOwnershipHandle): Promise<void> {
    await this.withAdminLock(runId, async () => {
      await removeOwnedDirectory(ownership);
    });
  }

  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const ownership = await this.acquireLock(runId);
    let value: T | undefined;
    let primaryError: unknown;
    try {
      value = await fn();
    } catch (error) {
      primaryError = error;
    }
    try {
      await this.releaseLock(runId, ownership);
    } catch (cleanupError) {
      if (primaryError !== undefined) {
        throw new AggregateError(
          [primaryError, cleanupError],
          `Run ${runId} protected operation and data-lock cleanup both failed`,
        );
      }
      throw cleanupError;
    }
    if (primaryError !== undefined) throw primaryError;
    return value as T;
  }

  async create(title: string, request: string, config: MasweConfig): Promise<RunRecord> {
    const createdAt = now();
    const run: RunRecord = {
      schemaVersion: 1,
      version: 1,
      id: makeRunId(),
      title,
      request,
      repositoryPath: this.cwd,
      state: "CREATED",
      createdAt,
      updatedAt: createdAt,
      approvals: { brainstorm: false, design: false },
      counters: { buildVerifyCycles: 0, commentResolutionCycles: 0 },
      config: structuredClone(config),
      artifacts: [],
      events: [],
    };
    await this.withLock(run.id, async () => {
      await writeAtomic(this.runFile(run.id), `${JSON.stringify(run, null, 2)}\n`);
    });
    return run;
  }

  async save(run: RunRecord): Promise<void> {
    await this.withLock(run.id, async () => {
      const onDisk = await this.readRunFile(run.id);
      if (onDisk.version !== run.version) {
        throw new Error(
          `Run ${run.id} version conflict: expected ${run.version}, on disk ${onDisk.version}`,
        );
      }
      run.version += 1;
      run.updatedAt = now();
      await writeAtomic(this.runFile(run.id), `${JSON.stringify(run, null, 2)}\n`);
    });
  }

  async load(runId: string): Promise<RunRecord> {
    return this.readRunFile(runId);
  }

  async list(): Promise<RunRecord[]> {
    await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root, { withFileTypes: true });
    const runs: RunRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        runs.push(await this.load(entry.name));
      } catch {
        // A partially written or manually removed run should not hide healthy runs.
      }
    }
    return runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async applyEvent(
    run: RunRecord,
    type: WorkflowEventType,
    actor: string,
    details?: Record<string, unknown>,
  ): Promise<RunRecord> {
    const from = run.state;
    const to = transition(from, type, details?.resumeState as WorkflowState | undefined);
    run.state = to;
    run.events.push({
      id: randomUUID(),
      at: now(),
      type,
      actor,
      from,
      to,
      ...(details ? { details } : {}),
    });
    await this.save(run);
    return run;
  }

  async writeArtifact(run: RunRecord, name: string, content: string): Promise<ArtifactReference> {
    return this.withLock(run.id, async () => {
      const onDisk = await this.readRunFile(run.id);
      if (onDisk.version !== run.version) {
        throw new Error(
          `Run ${run.id} version conflict: stale artifact writer (caller ${run.version}, on disk ${onDisk.version})`,
        );
      }

      const next = structuredClone(onDisk);
      const logicalName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const priorAttempts = next.artifacts.filter((artifact) => artifact.logicalName === logicalName);
      const attempt = priorAttempts.reduce((max, artifact) => Math.max(max, artifact.attempt), 0) + 1;
      const fileName = `${logicalName.replace(/\.md$/i, "")}.attempt-${attempt}.md`;
      const relativePath = path.join(".maswe", "runs", run.id, "artifacts", fileName);
      const absolutePath = path.join(this.cwd, relativePath);
      const redacted = redactSecrets(content);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      const tempPath = `${absolutePath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, redacted, "utf8");
      await rename(tempPath, absolutePath);

      const reference: ArtifactReference = {
        name: logicalName,
        logicalName,
        attempt,
        path: relativePath,
        sha256: sha256(redacted),
        createdAt: now(),
      };

      const historical = priorAttempts.map((artifact) =>
        artifact.name === logicalName
          ? { ...artifact, name: `${logicalName}.attempt-${artifact.attempt}` }
          : artifact,
      );
      next.artifacts = [
        ...next.artifacts.filter((artifact) => artifact.logicalName !== logicalName),
        ...historical,
        reference,
      ];
      next.version += 1;
      next.updatedAt = now();
      await writeAtomic(this.runFile(run.id), `${JSON.stringify(next, null, 2)}\n`);

      run.version = next.version;
      run.updatedAt = next.updatedAt;
      run.artifacts = next.artifacts;
      return reference;
    });
  }

  async readArtifact(run: RunRecord, name: string): Promise<string | undefined> {
    const reference =
      run.artifacts.find((artifact) => artifact.name === name) ??
      run.artifacts.find((artifact) => artifact.logicalName === name && artifact.name === name);
    if (!reference) return undefined;
    const content = await readFile(path.join(this.cwd, reference.path), "utf8");
    const digest = sha256(content);
    if (digest !== reference.sha256) {
      throw new Error(
        `Artifact ${reference.name} digest mismatch: expected ${reference.sha256}, got ${digest}`,
      );
    }
    return content;
  }
}
