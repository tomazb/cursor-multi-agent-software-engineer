import { writeFile } from "node:fs/promises";
import { GitHubDeliveryStore } from "../../src/github/delivery-store.ts";

const [root, deliveryId, operation, leaseId, resultPath] = process.argv.slice(2);
if (!root || !deliveryId || !operation || !leaseId || !resultPath) {
  throw new Error("github delivery worker requires root, delivery, operation, lease, and result");
}

const store = new GitHubDeliveryStore(root, { staleProcessingMs: 60_000 });
const result =
  operation === "claim"
    ? await store.claim(deliveryId)
    : operation === "complete"
      ? await store.complete(deliveryId, leaseId)
      : operation === "fail"
        ? await store.fail(deliveryId, "contention fixture", leaseId)
        : undefined;
if (!result) throw new Error(`unknown delivery operation: ${operation}`);
await writeFile(resultPath, `${JSON.stringify(result)}\n`, { encoding: "utf8", flag: "wx" });
