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

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

interface LockMeta {
  pid: number;
  token: string;
  at: string;
}

/**
 * Serialize association index mutations with an exclusive lock file (`wx`).
 * Abandoned locks are reclaimable only when the owner pid is confirmed dead.
 * Age alone never authorizes deletion. Release is identity-bound to the lock token.
 */
export class GitHubAssociationIndex {
  private readonly filePath: string;
  private readonly lockPath: string;

  constructor(githubRoot: string, _options: { lockStaleMs?: number } = {}) {
    this.filePath = path.join(githubRoot, "associations.json");
    this.lockPath = path.join(githubRoot, "associations.lock");
    // lockStaleMs retained in options for API compatibility but ignored: age alone
    // must not authorize lock deletion (confirmed-dead owner only).
    void _options.lockStaleMs;
  }

  private async tryReclaimDeadOwnerLock(): Promise<void> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      let meta: LockMeta;
      try {
        meta = JSON.parse(raw) as LockMeta;
      } catch {
        await unlink(this.lockPath);
        return;
      }
      const pid = typeof meta.pid === "number" ? meta.pid : -1;
      if (!processAlive(pid)) {
        await unlink(this.lockPath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        try {
          await unlink(this.lockPath);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async releaseIfOwned(token: string): Promise<void> {
    try {
      const raw = await readFile(this.lockPath, "utf8");
      const meta = JSON.parse(raw) as LockMeta;
      if (meta.token === token) {
        await unlink(this.lockPath);
      }
    } catch {
      /* missing or malformed: ignore */
    }
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(path.dirname(this.lockPath), { recursive: true });
    const token = randomUUID();
    const started = Date.now();
    for (;;) {
      try {
        const meta: LockMeta = {
          pid: process.pid,
          token,
          at: new Date().toISOString(),
        };
        await writeFile(this.lockPath, `${JSON.stringify(meta)}\n`, {
          encoding: "utf8",
          flag: "wx",
        });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.tryReclaimDeadOwnerLock();
        if (Date.now() - started > 5_000) {
          throw new Error("Timed out acquiring GitHub association index lock");
        }
        await sleep(10);
      }
    }
    try {
      return await fn();
    } finally {
      await this.releaseIfOwned(token);
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

  /**
   * Suspend all associations for an installation.
   * Returns every matching record (including already suspended) so run stores can reconcile.
   */
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

  /**
   * Suspend all associations for an installation+repository.
   * Returns every matching record (including already suspended) so run stores can reconcile.
   */
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
