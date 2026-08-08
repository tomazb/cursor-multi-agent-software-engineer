import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export interface DeliveryClaimResult {
  claimed: boolean;
  duplicate: boolean;
}

function assertSafeDeliveryId(deliveryId: string): void {
  if (!deliveryId || typeof deliveryId !== "string") {
    throw new Error("GitHub delivery id is required");
  }
  if (!/^[A-Za-z0-9._-]+$/.test(deliveryId)) {
    throw new Error("GitHub delivery id contains invalid characters");
  }
}

/**
 * File-backed unique claim store for `X-GitHub-Delivery` ids.
 * Root is typically `<cwd>/.maswe/github`.
 */
export class GitHubDeliveryStore {
  private readonly deliveriesDir: string;

  constructor(githubRoot: string) {
    this.deliveriesDir = path.join(githubRoot, "deliveries");
  }

  async claim(deliveryId: string): Promise<DeliveryClaimResult> {
    assertSafeDeliveryId(deliveryId);
    await mkdir(this.deliveriesDir, { recursive: true });
    const filePath = path.join(this.deliveriesDir, `${deliveryId}.json`);
    const payload = `${JSON.stringify({
      deliveryId,
      claimedAt: new Date().toISOString(),
    })}\n`;
    try {
      await writeFile(filePath, payload, { encoding: "utf8", flag: "wx" });
      return { claimed: true, duplicate: false };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        return { claimed: false, duplicate: true };
      }
      throw error;
    }
  }
}
