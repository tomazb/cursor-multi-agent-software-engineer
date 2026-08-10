import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AssociationRecord } from "./types.ts";
import { withGitHubJournal } from "./journal.ts";

function associationKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

type AssociationBindInput = Omit<AssociationRecord, "suspended" | "updatedAt"> & {
  suspended?: boolean;
};

export interface GitHubAssociationTransaction {
  find(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  bind(input: AssociationBindInput): AssociationRecord;
  suspend(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  onRollback(callback: () => Promise<void>): void;
}

type WriteRecords = (filePath: string, content: string) => Promise<void>;

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
  private readonly writeRecords: WriteRecords;

  constructor(
    githubRoot: string,
    options: { lockStaleMs?: number; writeRecords?: WriteRecords } = {},
  ) {
    this.githubRoot = githubRoot;
    this.filePath = path.join(githubRoot, "associations.json");
    this.writeRecords = options.writeRecords ?? writeAtomic;
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
    await this.writeRecords(this.filePath, `${JSON.stringify(records, null, 2)}\n`);
  }

  async withTransaction<T>(
    callback: (transaction: GitHubAssociationTransaction) => Promise<T>,
  ): Promise<T> {
    return this.withLock(async () => {
      const records = await this.readAll();
      let dirty = false;
      const rollbacks: Array<() => Promise<void>> = [];
      const transaction: GitHubAssociationTransaction = {
        find(repository, pullRequestNumber) {
          const record = records[associationKey(repository, pullRequestNumber)];
          return record ? { ...record } : undefined;
        },
        bind(input) {
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
          records[associationKey(input.repository, input.pullRequestNumber)] = record;
          dirty = true;
          return { ...record };
        },
        suspend(repository, pullRequestNumber) {
          const record = records[associationKey(repository, pullRequestNumber)];
          if (!record) return undefined;
          if (!record.suspended) {
            record.suspended = true;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          }
          return { ...record };
        },
        onRollback(callback) {
          rollbacks.push(callback);
        },
      };
      try {
        const result = await callback(transaction);
        if (dirty) await this.writeAll(records);
        return result;
      } catch (error) {
        const rollbackErrors: unknown[] = [];
        for (const rollback of rollbacks.reverse()) {
          try {
            await rollback();
          } catch (rollbackError) {
            rollbackErrors.push(rollbackError);
          }
        }
        if (rollbackErrors.length > 0) {
          throw new AggregateError(
            [error, ...rollbackErrors],
            error instanceof Error ? error.message : "Association transaction failed",
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  async bind(
    input: AssociationBindInput,
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
