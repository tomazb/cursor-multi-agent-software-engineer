import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AssociationRecord } from "./types.ts";

function associationKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Serialize association index mutations with an exclusive lock file (`wx`).
 */
export class GitHubAssociationIndex {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(githubRoot: string) {
    this.filePath = path.join(githubRoot, "associations.json");
    this.lockPath = path.join(githubRoot, "associations.lock");
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const started = Date.now();
    for (;;) {
      try {
        await writeFile(
          this.lockPath,
          `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`,
          { encoding: "utf8", flag: "wx" },
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() - started > 5_000) {
          throw new Error("Timed out acquiring GitHub association index lock");
        }
        await sleep(10);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await unlink(this.lockPath);
      } catch {
        /* ignore missing lock */
      }
    }
  }

  private async readAll(): Promise<Record<string, AssociationRecord>> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Record<string, AssociationRecord>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeAll(records: Record<string, AssociationRecord>): Promise<void> {
    await writeAtomic(this.filePath, `${JSON.stringify(records, null, 2)}\n`);
  }

  async bind(
    input: Omit<AssociationRecord, "suspended" | "updatedAt"> & { suspended?: boolean },
  ): Promise<AssociationRecord> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const key = associationKey(input.repository, input.pullRequestNumber);
      const record: AssociationRecord = {
        runId: input.runId,
        installationId: input.installationId,
        repository: input.repository,
        pullRequestNumber: input.pullRequestNumber,
        baseSha: input.baseSha,
        headSha: input.headSha,
        branch: input.branch,
        suspended: input.suspended ?? false,
        updatedAt: new Date().toISOString(),
      };
      records[key] = record;
      await this.writeAll(records);
      return record;
    });
  }

  async find(
    repository: string,
    pullRequestNumber: number,
  ): Promise<AssociationRecord | undefined> {
    const records = await this.readAll();
    return records[associationKey(repository, pullRequestNumber)];
  }

  async findByRepositoryBranch(
    repository: string,
    branch: string,
  ): Promise<AssociationRecord | undefined> {
    const records = await this.readAll();
    return Object.values(records).find(
      (record) =>
        record.repository === repository && record.branch === branch && !record.suspended,
    );
  }

  async suspendInstallation(installationId: number): Promise<AssociationRecord[]> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const suspended: AssociationRecord[] = [];
      for (const record of Object.values(records)) {
        if (record.installationId === installationId && !record.suspended) {
          record.suspended = true;
          record.updatedAt = new Date().toISOString();
          suspended.push({ ...record });
        }
      }
      if (suspended.length > 0) await this.writeAll(records);
      return suspended;
    });
  }

  async suspendRepository(
    installationId: number,
    repository: string,
  ): Promise<AssociationRecord[]> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const suspended: AssociationRecord[] = [];
      for (const record of Object.values(records)) {
        if (
          record.installationId === installationId &&
          record.repository === repository &&
          !record.suspended
        ) {
          record.suspended = true;
          record.updatedAt = new Date().toISOString();
          suspended.push({ ...record });
        }
      }
      if (suspended.length > 0) await this.writeAll(records);
      return suspended;
    });
  }
}
