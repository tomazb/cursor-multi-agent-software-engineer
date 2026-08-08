import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export class GitHubAssociationIndex {
  private readonly filePath: string;

  constructor(githubRoot: string) {
    this.filePath = path.join(githubRoot, "associations.json");
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
  }

  async find(
    repository: string,
    pullRequestNumber: number,
  ): Promise<AssociationRecord | undefined> {
    const records = await this.readAll();
    return records[associationKey(repository, pullRequestNumber)];
  }

  async suspendInstallation(installationId: number): Promise<number> {
    const records = await this.readAll();
    let changed = 0;
    for (const record of Object.values(records)) {
      if (record.installationId === installationId && !record.suspended) {
        record.suspended = true;
        record.updatedAt = new Date().toISOString();
        changed += 1;
      }
    }
    if (changed > 0) await this.writeAll(records);
    return changed;
  }
}
