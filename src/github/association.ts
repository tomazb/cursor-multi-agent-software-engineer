import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AssociationRecord } from "./types.ts";
import { withGitHubJournal } from "./journal.ts";

function associationKey(repository: string, pullRequestNumber: number): string {
  return `${repository}#${pullRequestNumber}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseAssociationRecords(raw: string): Record<string, AssociationRecord> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error("Invalid GitHub association index", { cause: error });
  }
  if (!isRecord(parsed)) throw new Error("Invalid GitHub association index");
  const result: Record<string, AssociationRecord> = {};
  const activeRuns = new Set<string>();
  const requiredFields = [
    "runId",
    "installationId",
    "repository",
    "pullRequestNumber",
    "baseSha",
    "headSha",
    "branch",
    "suspended",
    "updatedAt",
  ];
  const allowedFields = new Set([...requiredFields, "suspensionReason"]);
  for (const [key, value] of Object.entries(parsed)) {
    if (!isRecord(value)) throw new Error("Invalid GitHub association index");
    if (
      Object.keys(value).some((field) => !allowedFields.has(field)) ||
      requiredFields.some((field) => !Object.hasOwn(value, field)) ||
      typeof value.runId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(value.runId) ||
      !Number.isSafeInteger(value.installationId) ||
      Number(value.installationId) <= 0 ||
      typeof value.repository !== "string" ||
      !/^[^/\s]+\/[^/\s]+$/.test(value.repository) ||
      value.repository !== value.repository.toLowerCase() ||
      !Number.isSafeInteger(value.pullRequestNumber) ||
      Number(value.pullRequestNumber) <= 0 ||
      key !== associationKey(value.repository, Number(value.pullRequestNumber)) ||
      typeof value.baseSha !== "string" ||
      !value.baseSha ||
      typeof value.headSha !== "string" ||
      !value.headSha ||
      typeof value.branch !== "string" ||
      !value.branch ||
      typeof value.suspended !== "boolean" ||
      (value.suspensionReason !== undefined &&
        (value.suspended !== true ||
          (value.suspensionReason !== "pull-request-closed" &&
            value.suspensionReason !== "authorization-revoked"))) ||
      !validTimestamp(value.updatedAt)
    ) {
      throw new Error("Invalid GitHub association index");
    }
    if (!value.suspended) {
      if (activeRuns.has(value.runId)) {
        throw new Error("Invalid GitHub association index: duplicate active run id");
      }
      activeRuns.add(value.runId);
    }
    result[key] = value as unknown as AssociationRecord;
  }
  return result;
}

function assertUniqueActiveRun(
  records: Record<string, AssociationRecord>,
  key: string,
  runId: string,
  suspended: boolean,
): void {
  if (suspended) return;
  const conflict = Object.entries(records).find(
    ([candidateKey, record]) =>
      candidateKey !== key && record.runId === runId && !record.suspended,
  );
  if (conflict) {
    throw new Error(`Run ${runId} is already associated to an active pull request`);
  }
}

type AssociationBindInput = Omit<AssociationRecord, "suspended" | "updatedAt"> & {
  suspended?: boolean;
};

export interface GitHubAssociationTransaction {
  find(repository: string, pullRequestNumber: number): AssociationRecord | undefined;
  bind(input: AssociationBindInput): AssociationRecord;
  suspend(
    repository: string,
    pullRequestNumber: number,
    reason: "pull-request-closed" | "authorization-revoked",
  ): AssociationRecord | undefined;
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
      return parseAssociationRecords(raw);
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
          const key = associationKey(input.repository, input.pullRequestNumber);
          const suspended = input.suspended ?? false;
          assertUniqueActiveRun(records, key, input.runId, suspended);
          const record: AssociationRecord = {
            runId: input.runId,
            installationId: input.installationId,
            repository: input.repository,
            pullRequestNumber: input.pullRequestNumber,
            baseSha: input.baseSha,
            headSha: input.headSha,
            branch: input.branch,
            suspended,
            ...(input.suspensionReason !== undefined
              ? { suspensionReason: input.suspensionReason }
              : {}),
            updatedAt: new Date().toISOString(),
          };
          parseAssociationRecords(`${JSON.stringify({ [key]: record })}\n`);
          records[key] = record;
          dirty = true;
          return { ...record };
        },
        suspend(repository, pullRequestNumber, reason) {
          const record = records[associationKey(repository, pullRequestNumber)];
          if (!record) return undefined;
          if (!record.suspended) {
            record.suspended = true;
            record.suspensionReason = reason;
            record.updatedAt = new Date().toISOString();
            dirty = true;
          } else if (record.suspensionReason !== reason) {
            record.suspensionReason = reason;
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
    return this.withTransaction(async (transaction) => transaction.bind(input));
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
    reason: "pull-request-closed" | "authorization-revoked" = "authorization-revoked",
  ): Promise<AssociationRecord | undefined> {
    return this.withLock(async () => {
      const records = await this.readAll();
      const key = associationKey(repository, pullRequestNumber);
      const record = records[key];
      if (!record) return undefined;
      if (!record.suspended) {
        record.suspended = true;
        record.suspensionReason = reason;
        record.updatedAt = new Date().toISOString();
        await this.writeAll(records);
      } else if (record.suspensionReason !== reason) {
        record.suspensionReason = reason;
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
          record.suspensionReason = "authorization-revoked";
          record.updatedAt = new Date().toISOString();
          dirty = true;
        } else if (record.suspensionReason !== "authorization-revoked") {
          record.suspensionReason = "authorization-revoked";
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
          record.suspensionReason = "authorization-revoked";
          record.updatedAt = new Date().toISOString();
          dirty = true;
        } else if (record.suspensionReason !== "authorization-revoked") {
          record.suspensionReason = "authorization-revoked";
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
