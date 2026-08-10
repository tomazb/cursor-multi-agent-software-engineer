import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AssociationRecord } from "./types.ts";
import { withGitHubJournal } from "./journal.ts";

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

/** Serialize association index mutations with immutable journal ownership. */
export class GitHubAssociationIndex {
  private readonly githubRoot: string;
  private readonly filePath: string;

  constructor(
    githubRoot: string,
    options: { lockStaleMs?: number } = {},
  ) {
    this.githubRoot = githubRoot;
    this.filePath = path.join(githubRoot, "associations.json");
    void options.lockStaleMs;
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withGitHubJournal(
      this.githubRoot,
      "association",
      "associations",
      fn,
      { timeoutMs: 5_000 },
    );
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

  async findAllByRepositoryBranch(
    repository: string,
    branch: string,
  ): Promise<AssociationRecord[]> {
    const records = await this.readAll();
    return Object.values(records)
      .filter(
        (record) =>
          record.repository === repository && record.branch === branch && !record.suspended,
      )
      .map((record) => ({ ...record }))
      .sort(
        (left, right) =>
          left.pullRequestNumber - right.pullRequestNumber || left.runId.localeCompare(right.runId),
      );
  }

  async suspend(
    repository: string,
    pullRequestNumber: number,
  ): Promise<AssociationRecord | undefined> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const key = associationKey(repository, pullRequestNumber);
      const record = records[key];
      if (!record) return undefined;
      if (!record.suspended) {
        record.suspended = true;
        record.updatedAt = new Date().toISOString();
        await this.writeAll(records);
      }
      return { ...record };
    });
  }

  async suspendInstallation(installationId: number): Promise<AssociationRecord[]> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const affected: AssociationRecord[] = [];
      let dirty = false;
      for (const record of Object.values(records)) {
        if (record.installationId !== installationId) continue;
        if (!record.suspended) {
          record.suspended = true;
          record.updatedAt = new Date().toISOString();
          dirty = true;
        }
        affected.push({ ...record });
      }
      if (dirty) await this.writeAll(records);
      return affected;
    });
  }

  async suspendRepository(
    installationId: number,
    repository: string,
  ): Promise<AssociationRecord[]> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const affected: AssociationRecord[] = [];
      let dirty = false;
      for (const record of Object.values(records)) {
        if (record.installationId !== installationId || record.repository !== repository) {
          continue;
        }
        if (!record.suspended) {
          record.suspended = true;
          record.updatedAt = new Date().toISOString();
          dirty = true;
        }
        affected.push({ ...record });
      }
      if (dirty) await this.writeAll(records);
      return affected;
    });
  }
}
