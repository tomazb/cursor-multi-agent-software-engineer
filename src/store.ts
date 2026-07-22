import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkflowEventType,
  WorkflowState,
} from "./domain.ts";
import { migrateConfig } from "./config.ts";
import { assertSafeRunId } from "./git-workspace.ts";
import { redactSecrets } from "./redaction.ts";
import { transition } from "./state-machine.ts";

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

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

async function readLockMeta(lockPath: string): Promise<LockMeta | undefined> {
  try {
    const raw = await readFile(lockPath, "utf8");
    if (!raw.trim()) return undefined;
    const meta = JSON.parse(raw) as Partial<LockMeta>;
    if (typeof meta.pid !== "number" || typeof meta.owner !== "string" || typeof meta.at !== "string") {
      return undefined;
    }
    return { pid: meta.pid, owner: meta.owner, at: meta.at };
  } catch {
    return undefined;
  }
}

async function releaseOwnedLock(lockPath: string, owner: string): Promise<void> {
  const meta = await readLockMeta(lockPath);
  if (!meta || meta.owner !== owner) return;
  // Owner-verified release: delete only if the token still matches (no rename-aside window).
  const again = await readLockMeta(lockPath);
  if (!again || again.owner !== owner) return;
  await rm(lockPath, { force: true });
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

  private async readRunFile(runId: string): Promise<RunRecord> {
    const raw = await readFile(this.runFile(runId), "utf8");
    return migrateRunRecord(JSON.parse(raw));
  }

  /**
   * Short-lived administrative mutex shared by data-lock acquisition and unlock.
   * Dead admin holders are reclaimed (unlike the data lock) so a crashed unlock
   * cannot permanently wedge the run.
   */
  private async withAdminLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const adminPath = this.adminLockFile(runId);
    const adminRetries = Math.max(this.lockRetries * 4, 100);
    let owner: string | undefined;

    for (let attempt = 0; attempt < adminRetries; attempt += 1) {
      owner = randomUUID();
      const meta: LockMeta = { pid: process.pid, owner, at: new Date().toISOString() };
      const tmpPath = `${adminPath}.${owner}.tmp`;
      await writeFile(tmpPath, `${JSON.stringify(meta)}\n`, "utf8");
      try {
        await link(tmpPath, adminPath);
        await rm(tmpPath, { force: true });
        break;
      } catch (error) {
        await rm(tmpPath, { force: true });
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        const existing = await readLockMeta(adminPath);
        if (existing && pidAlive(existing.pid)) {
          owner = undefined;
          await sleep(5 + attempt * 2);
          continue;
        }
        // Dead or incomplete admin lock: safe to reclaim.
        await rm(adminPath, { force: true });
        owner = undefined;
      }
    }
    if (!owner) {
      throw new Error(`Run ${runId} admin lock contention: could not serialize unlock/acquire`);
    }

    try {
      return await fn();
    } finally {
      await releaseOwnedLock(adminPath, owner);
    }
  }

  private async acquireLock(runId: string): Promise<{ owner: string }> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const lockPath = this.lockFile(runId);

    for (let attempt = 0; attempt < this.lockRetries; attempt += 1) {
      const outcome = await this.withAdminLock(runId, async () => {
        const owner = randomUUID();
        const meta: LockMeta = { pid: process.pid, owner, at: new Date().toISOString() };
        const tmpPath = `${lockPath}.${owner}.tmp`;
        await writeFile(tmpPath, `${JSON.stringify(meta)}\n`, "utf8");
        try {
          // Atomic exclusive create of a complete lock record (no empty/partial window).
          await link(tmpPath, lockPath);
          await rm(tmpPath, { force: true });
          return { kind: "acquired" as const, owner };
        } catch (error) {
          await rm(tmpPath, { force: true });
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== "EEXIST") throw error;
          const existing = await readLockMeta(lockPath);
          if (existing && pidAlive(existing.pid)) {
            return { kind: "live" as const };
          }
          // Never auto-reclaim stale/incomplete data locks — that races with new owners.
          return { kind: "stale" as const };
        }
      });

      if (outcome.kind === "acquired") return { owner: outcome.owner };
      if (outcome.kind === "stale" && attempt === this.lockRetries - 1) {
        throw new Error(
          `Run ${runId} lock contention: stale or incomplete lock at ${lockPath}. If the holder is dead, run: maswe unlock ${runId}`,
        );
      }
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
    const meta = await readLockMeta(lockPath);
    if (!meta) {
      // Incomplete/corrupt: only removable with force.
      if (!options.force) {
        throw new Error(
          `Run ${runId} lock is incomplete or missing owner metadata. Re-run with --force only after confirming no writer is active.`,
        );
      }
    } else if (pidAlive(meta.pid) && !options.force) {
      throw new Error(
        `Run ${runId} lock is held by live pid ${meta.pid}. Refusing unlock without --force.`,
      );
    }

    if (options.afterValidate) {
      await options.afterValidate(meta);
    }

    await this.withAdminLock(runId, async () => {
      const again = await readLockMeta(lockPath);
      if (!meta) {
        // Forced incomplete cleanup: remove whatever is present only if still incomplete
        // or gone; never delete a complete replacement owner without matching the observe.
        if (!again) {
          await rm(lockPath, { force: true });
          return;
        }
        throw new Error(`Run ${runId} lock changed during unlock; refusing to delete.`);
      }
      if (!again || again.owner !== meta.owner) {
        throw new Error(`Run ${runId} lock changed during unlock; refusing to delete.`);
      }
      if (pidAlive(again.pid) && !options.force) {
        throw new Error(
          `Run ${runId} lock is held by live pid ${again.pid}. Refusing unlock without --force.`,
        );
      }
      await rm(lockPath, { force: true });
      const leftover = await readLockMeta(lockPath);
      if (leftover) {
        throw new Error(`Run ${runId} unlock failed: lock still present`);
      }
    });
  }

  private async releaseLock(runId: string, owner: string): Promise<void> {
    await releaseOwnedLock(this.lockFile(runId), owner);
  }

  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const { owner } = await this.acquireLock(runId);
    try {
      return await fn();
    } finally {
      await this.releaseLock(runId, owner);
    }
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
