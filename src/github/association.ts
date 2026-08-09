import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AssociationRecord } from "./types.ts";
import { withDirLock, type ReclaimHooks } from "./lock-ownership.ts";

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

/**
 * Serialize association index mutations with an exclusive directory lock.
 * Live owners never expose an absence window; dead owners are reclaimed only
 * when ESRCH is proven and owner.json is unchanged after the death check.
 */
export class GitHubAssociationIndex {
  private readonly filePath: string;
  private readonly lockDir: string;
  private readonly reclaimHooks: ReclaimHooks;

  constructor(
    githubRoot: string,
    options: { lockStaleMs?: number } & ReclaimHooks = {},
  ) {
    this.filePath = path.join(githubRoot, "associations.json");
    this.lockDir = path.join(githubRoot, "associations.lock");
    void options.lockStaleMs;
    this.reclaimHooks = {
      ...(options.afterDeadConfirmed
        ? { afterDeadConfirmed: options.afterDeadConfirmed }
        : {}),
    };
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    return withDirLock(this.lockDir, fn, {
      timeoutMs: 5_000,
      ...this.reclaimHooks,
    });
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
