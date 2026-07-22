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

  if (candidate.version === undefined) {
    // v0.1 compatibility: synthesize optimistic version and attempt metadata.
    return {
      ...(candidate as unknown as RunRecord),
      version: 1,
      artifacts,
    };
  }

  if (typeof candidate.version !== "number" || candidate.version < 1) {
    throw new Error("Run record version is missing or invalid (fail-closed)");
  }

  return {
    ...(candidate as unknown as RunRecord),
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

  private async acquireLock(runId: string): Promise<FileHandle> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const lockPath = this.lockFile(runId);

    for (let attempt = 0; attempt < this.lockRetries; attempt += 1) {
      try {
        const handle = await open(lockPath, "wx");
        await handle.writeFile(
          `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
          "utf8",
        );
        return handle;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;

        let reclaimed = false;
        try {
          const raw = await readFile(lockPath, "utf8");
          const meta = JSON.parse(raw) as { pid?: number; at?: string };
          const age = meta.at ? Date.now() - Date.parse(meta.at) : Number.POSITIVE_INFINITY;
          if (!pidAlive(meta.pid ?? -1) || age > this.lockStaleMs) {
            await rm(lockPath, { force: true });
            reclaimed = true;
          }
        } catch {
          await rm(lockPath, { force: true });
          reclaimed = true;
        }
        if (reclaimed) continue;
        await sleep(20 + attempt * 10);
      }
    }
    throw new Error(`Run ${runId} lock contention: could not acquire exclusive lock`);
  }

  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const handle = await this.acquireLock(runId);
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await rm(this.lockFile(runId), { force: true });
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
      // Serialize writers on artifacts/version while preserving the caller's workflow mutations.
      const callerCounters = run.counters;
      const callerApprovals = run.approvals;
      const callerState = run.state;
      const callerEvents = run.events;
      const callerWorkspace = run.workspace;
      const callerEvidence = run.evidence;
      const callerFailure = run.failure;
      const callerTitle = run.title;
      const callerRequest = run.request;
      const callerConfig = run.config;

      run.version = onDisk.version;
      run.artifacts = structuredClone(onDisk.artifacts);
      run.counters = callerCounters;
      run.approvals = callerApprovals;
      run.state = callerState;
      run.events = callerEvents;
      run.title = callerTitle;
      run.request = callerRequest;
      run.config = callerConfig;
      if (callerWorkspace) run.workspace = callerWorkspace;
      else delete run.workspace;
      if (callerEvidence) run.evidence = callerEvidence;
      else delete run.evidence;
      if (callerFailure) run.failure = callerFailure;
      else delete run.failure;

      const logicalName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
      const priorAttempts = run.artifacts.filter((artifact) => artifact.logicalName === logicalName);
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
      run.artifacts = [
        ...run.artifacts.filter((artifact) => artifact.logicalName !== logicalName),
        ...historical,
        reference,
      ];
      run.version += 1;
      run.updatedAt = now();
      await writeAtomic(this.runFile(run.id), `${JSON.stringify(run, null, 2)}\n`);
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
