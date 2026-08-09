import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { withDirLock, type ReclaimHooks } from "./lock-ownership.ts";

export interface SideEffectRecord {
  resourceId: number;
  kind: string;
}

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const directory = path.dirname(filePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, "utf8");
  await rename(tempPath, filePath);
}

function keyToFilename(idempotencyKey: string): string {
  return `${createHash("sha256").update(idempotencyKey).digest("hex")}.json`;
}

export class GitHubSideEffectStore {
  private readonly dir: string;
  private readonly createLocksDir: string;
  private readonly reclaimHooks: ReclaimHooks;

  constructor(githubRoot: string, options: ReclaimHooks = {}) {
    this.dir = path.join(githubRoot, "side-effects");
    this.createLocksDir = path.join(githubRoot, "side-effect-create-locks");
    this.reclaimHooks = options;
  }

  async get(idempotencyKey: string): Promise<SideEffectRecord | undefined> {
    try {
      const raw = await readFile(path.join(this.dir, keyToFilename(idempotencyKey)), "utf8");
      const parsed = JSON.parse(raw) as SideEffectRecord & { idempotencyKey: string };
      if (typeof parsed.resourceId !== "number" || typeof parsed.kind !== "string") {
        return undefined;
      }
      return { resourceId: parsed.resourceId, kind: parsed.kind };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async put(idempotencyKey: string, record: SideEffectRecord): Promise<void> {
    await writeAtomic(
      path.join(this.dir, keyToFilename(idempotencyKey)),
      `${JSON.stringify({ idempotencyKey, ...record }, null, 2)}\n`,
    );
  }

  /**
   * Serialize create/reconcile for one idempotency key across concurrent publishers.
   * Uses mkdir locks so live owners never expose an absence window.
   */
  async withCreateLock<T>(
    idempotencyKey: string,
    fn: () => Promise<T>,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    await mkdir(this.createLocksDir, { recursive: true });
    const lockDir = path.join(this.createLocksDir, `${keyToFilename(idempotencyKey)}.lock`);
    try {
      return await withDirLock(lockDir, fn, {
        timeoutMs: options.timeoutMs ?? 10_000,
        ...this.reclaimHooks,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        /Timed out acquiring directory lock/.test(error.message)
      ) {
        throw new Error(`Timed out acquiring check-create lock for ${idempotencyKey}`);
      }
      throw error;
    }
  }
}
