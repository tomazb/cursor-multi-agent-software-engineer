import { createHash } from "node:crypto";
import path from "node:path";
import {
  ensureOrdinaryDirectory,
  readBoundedOrdinaryFile,
  requireOrdinaryDirectory,
  writeDurableAtomic,
  type DurableFileOptions,
} from "../durable-file.ts";
import { withGitHubJournal } from "./journal.ts";

export interface SideEffectRecord {
  resourceId: number;
  kind: "check-run";
}

function keyToFilename(idempotencyKey: string): string {
  return `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`;
}

export class GitHubSideEffectStore {
  private readonly githubRoot: string;
  private readonly dir: string;
  private readonly durableOptions: DurableFileOptions;

  constructor(githubRoot: string, options: DurableFileOptions = {}) {
    this.githubRoot = githubRoot;
    this.dir = path.join(githubRoot, "side-effects");
    this.durableOptions = options;
  }

  async get(idempotencyKey: string): Promise<SideEffectRecord | undefined> {
    try {
      await requireOrdinaryDirectory(this.githubRoot, "GitHub state namespace");
      await requireOrdinaryDirectory(this.dir, "GitHub side-effect namespace");
      const raw = await readBoundedOrdinaryFile(
        path.join(this.dir, keyToFilename(idempotencyKey)),
        "GitHub side-effect record",
      );
      const parsed = JSON.parse(raw) as unknown;
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        Object.keys(parsed).length !== 3 ||
        !Object.hasOwn(parsed, "idempotencyKey") ||
        !Object.hasOwn(parsed, "resourceId") ||
        !Object.hasOwn(parsed, "kind") ||
        (parsed as { idempotencyKey?: unknown }).idempotencyKey !== idempotencyKey ||
        !Number.isSafeInteger((parsed as { resourceId?: unknown }).resourceId) ||
        Number((parsed as { resourceId?: unknown }).resourceId) <= 0 ||
        (parsed as { kind?: unknown }).kind !== "check-run"
      ) {
        throw new Error("Invalid GitHub side-effect record");
      }
      return {
        resourceId: Number((parsed as { resourceId: number }).resourceId),
        kind: "check-run",
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) {
        throw new Error("Invalid GitHub side-effect record", { cause: error });
      }
      throw error;
    }
  }

  async put(idempotencyKey: string, record: SideEffectRecord): Promise<void> {
    if (
      !idempotencyKey ||
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      Object.keys(record).length !== 2 ||
      !Object.hasOwn(record, "resourceId") ||
      !Object.hasOwn(record, "kind") ||
      !Number.isSafeInteger(record.resourceId) ||
      record.resourceId <= 0 ||
      record.kind !== "check-run"
    ) {
      throw new Error("Invalid GitHub side-effect record");
    }
    await requireOrdinaryDirectory(this.githubRoot, "GitHub state namespace");
    await ensureOrdinaryDirectory(
      this.dir,
      "GitHub side-effect namespace",
      this.durableOptions,
    );
    await writeDurableAtomic(
      path.join(this.dir, keyToFilename(idempotencyKey)),
      `${JSON.stringify({
        idempotencyKey,
        resourceId: record.resourceId,
        kind: "check-run",
      }, null, 2)}\n`,
      "GitHub side-effect record",
      this.durableOptions,
    );
  }

  /**
   * Serialize create/reconcile for one idempotency key across concurrent publishers.
   * The complete key selects one immutable ownership journal.
   */
  async withCreateLock<T>(
    idempotencyKey: string,
    fn: () => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    return withGitHubJournal(
      this.githubRoot,
      "check-create",
      idempotencyKey,
      fn,
      { timeoutMs: options.timeoutMs ?? 10_000 },
    );
  }
}
