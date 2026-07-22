import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
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

export class FileRunStore implements RunStore {
  readonly root: string;
  private readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
    this.root = path.join(cwd, ".maswe", "runs");
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

  private async withLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const directory = this.runDirectory(runId);
    await mkdir(directory, { recursive: true });
    const handle = await open(this.lockFile(runId), "w");
    try {
      return await fn();
    } finally {
      await handle.close();
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
      let onDisk: RunRecord | undefined;
      try {
        onDisk = JSON.parse(await readFile(this.runFile(run.id), "utf8")) as RunRecord;
      } catch {
        onDisk = undefined;
      }
      if (onDisk && onDisk.version !== run.version) {
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
    const raw = await readFile(this.runFile(runId), "utf8");
    return JSON.parse(raw) as RunRecord;
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

    await this.save(run);
    return reference;
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
