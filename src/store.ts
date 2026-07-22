import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkflowEventType,
  WorkflowState,
} from "./domain.ts";
import { mergeConfig } from "./config.ts";
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

  const migratedConfig = mergeConfig(candidate.config);

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
  private readonly lockStaleMs: number;
  private readonly lockRetries: number;

  constructor(
    cwd: string,
    options: { lockStaleMs?: number; lockRetries?: number } = {},
  ) {
    this.cwd = cwd;
    this.root = path.join(cwd, ".maswe", "runs");
    this.lockStaleMs = options.lockStaleMs ?? 30_000;
    this.lockRetries = options.lockRetries ?? 50;
  }

  private runDirectory(runId: string): string {
    return path.join(this.root, runId);
  }

  private runFile(runId: string): string {
    return path.join(this.runDirectory(runId), "run.json");
  }

  private lockFile(runId: string): string {
    return path.join(this.runDirectory(runId), ".lock");
  }

  private async readRunFile(runId: string): Promise<RunRecord> {
    const raw = await readFile(this.runFile(runId), "utf8");
    return migrateRunRecord(JSON.parse(raw));
  }

  private async readLockMeta(lockPath: string): Promise<LockMeta | undefined> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const meta = JSON.parse(raw) as Partial<LockMeta>;
      if (typeof meta.pid !== "number" || typeof meta.owner !== "string" || typeof meta.at !== "string") {
        return undefined;
      }
      return { pid: meta.pid, owner: meta.owner, at: meta.at };
    } catch {
      return undefined;
    }
  }

  private async readLockPid(lockPath: string): Promise<number | undefined> {
    try {
      const raw = await readFile(lockPath, "utf8");
      const meta = JSON.parse(raw) as { pid?: unknown };
      return typeof meta.pid === "number" ? meta.pid : undefined;
    } catch {
      return undefined;
    }
  }

  private async tryReclaimStaleLock(lockPath: string): Promise<boolean> {
    const meta = await this.readLockMeta(lockPath);
    if (!meta) {
      // Incomplete/corrupt lock: never steal from a live PID; otherwise unlink once.
      const pid = await this.readLockPid(lockPath);
      if (pid !== undefined && pidAlive(pid)) return false;
      try {
        await rm(lockPath, { force: false });
        return true;
      } catch {
        return false;
      }
    }
    if (pidAlive(meta.pid)) {
      return false;
    }
    // Ownership-safe reclaim: unlink only if the owner token is unchanged.
    const again = await this.readLockMeta(lockPath);
    if (!again || again.owner !== meta.owner) return false;
    if (pidAlive(again.pid)) return false;
    try {
      await rm(lockPath, { force: false });
      return true;
    } catch {
      return false;
    }
  }

  private async acquireLock(runId: string): Promise<{ handle: FileHandle; owner: string }> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const lockPath = this.lockFile(runId);

    for (let attempt = 0; attempt < this.lockRetries; attempt += 1) {
      const owner = randomUUID();
      try {
        const handle = await open(lockPath, "wx");
        const meta: LockMeta = { pid: process.pid, owner, at: new Date().toISOString() };
        await handle.writeFile(`${JSON.stringify(meta)}\n`, "utf8");
        return { handle, owner };
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;

        const meta = await this.readLockMeta(lockPath);
        if (meta && pidAlive(meta.pid)) {
          // Never steal a live lock solely because it is old.
          await sleep(20 + attempt * 10);
          continue;
        }
        const pid = meta?.pid ?? (await this.readLockPid(lockPath));
        if (pid !== undefined && pidAlive(pid)) {
          await sleep(20 + attempt * 10);
          continue;
        }
        await this.tryReclaimStaleLock(lockPath);
        await sleep(10 + attempt * 5);
      }
    }
    throw new Error(`Run ${runId} lock contention: could not acquire exclusive lock`);
  }

  private async releaseLock(runId: string, handle: FileHandle, owner: string): Promise<void> {
    const lockPath = this.lockFile(runId);
    try {
      const meta = await this.readLockMeta(lockPath);
      await handle.close().catch(() => undefined);
      if (meta?.owner === owner) {
        await rm(lockPath, { force: true });
      }
    } catch {
      await handle.close().catch(() => undefined);
    }
  }

  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const { handle, owner } = await this.acquireLock(runId);
    try {
      return await fn();
    } finally {
      await this.releaseLock(runId, handle, owner);
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

      // Mutate only the authoritative on-disk record; never copy stale caller workflow fields.
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

      // Sync only fields owned by this write. Do not clobber unsaved in-memory
      // caller mutations (counters, approvals, evidence, failure, state, events).
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
