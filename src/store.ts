import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ArtifactReference,
  MasweConfig,
  RunRecord,
  WorkflowEventType,
} from "./domain.ts";
import { transition } from "./state-machine.ts";

function now(): string {
  return new Date().toISOString();
}

function makeRunId(): string {
  const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${timestamp}-${randomUUID().slice(0, 8)}`;
}

export class FileRunStore {
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

  async create(title: string, request: string, config: MasweConfig): Promise<RunRecord> {
    const createdAt = now();
    const run: RunRecord = {
      schemaVersion: 1,
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
    await this.save(run);
    return run;
  }

  async save(run: RunRecord): Promise<void> {
    run.updatedAt = now();
    const directory = this.runDirectory(run.id);
    await mkdir(path.join(directory, "artifacts"), { recursive: true });
    await writeFile(this.runFile(run.id), `${JSON.stringify(run, null, 2)}\n`, "utf8");
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
    const to = transition(from, type);
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
    const safeName = name.replace(/[^a-zA-Z0-9._-]/g, "-");
    const relativePath = path.join(".maswe", "runs", run.id, "artifacts", safeName);
    const absolutePath = path.join(this.cwd, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
    const reference: ArtifactReference = {
      name: safeName,
      path: relativePath,
      sha256: createHash("sha256").update(content).digest("hex"),
      createdAt: now(),
    };
    run.artifacts = run.artifacts.filter((artifact) => artifact.name !== safeName);
    run.artifacts.push(reference);
    await this.save(run);
    return reference;
  }

  async readArtifact(run: RunRecord, name: string): Promise<string | undefined> {
    const reference = run.artifacts.find((artifact) => artifact.name === name);
    if (!reference) return undefined;
    return readFile(path.join(this.cwd, reference.path), "utf8");
  }
}
