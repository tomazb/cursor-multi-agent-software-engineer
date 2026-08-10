import type { GitHubDeliveryInbox } from "./delivery-inbox.ts";
import type { GitHubInternalEvent } from "./types.ts";
import { GitHubWebhookDiagnosticError } from "./webhook-diagnostic.ts";

const QUEUE_SCAN_PAGE = 128;
const IDLE_SCAN_MS = 30_000;
const CURSOR_YIELD_MS = 1;
const WORKER_FAILURE_BACKOFF_MS = 250;

/** One due-aware durable-delivery worker owned by a listener adapter. */
export class GitHubWebhookWorker {
  private readonly inbox: GitHubDeliveryInbox;
  private readonly dispatch: (event: GitHubInternalEvent) => Promise<void>;
  private readonly onDiagnostic: ((error: unknown) => void) | undefined;
  private readonly onSchedule: ((delayMs: number) => void) | undefined;
  private enabled: boolean;
  private worker: Promise<void> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private active = false;
  private queueCursor: string | undefined;
  private queueNextAttemptAt: number | undefined;
  private nextDelayMs = 0;

  constructor(options: {
    inbox: GitHubDeliveryInbox;
    dispatch: (event: GitHubInternalEvent) => Promise<void>;
    enabled?: boolean;
    onDiagnostic?: (error: unknown) => void;
    onSchedule?: (delayMs: number) => void;
  }) {
    this.inbox = options.inbox;
    this.dispatch = options.dispatch;
    this.enabled = options.enabled ?? false;
    this.onDiagnostic = options.onDiagnostic;
    this.onSchedule = options.onSchedule;
  }

  start(): void {
    this.enabled = true;
    this.wake();
  }

  wake(delayMs = 0): void {
    if (!this.enabled || this.worker) return;
    if (this.timer) {
      if (delayMs > 0) return;
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (delayMs > 0) {
      try {
        this.onSchedule?.(delayMs);
      } catch {
        // Test/observability hooks never alter worker scheduling.
      }
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.wake();
      }, delayMs);
      this.timer.unref();
      return;
    }
    this.worker = this.run()
      .catch((error) => {
        this.nextDelayMs = Math.max(this.nextDelayMs, WORKER_FAILURE_BACKOFF_MS);
        this.emitDiagnostic(error);
      })
      .finally(() => {
        this.worker = undefined;
        if (this.enabled) this.wake(this.nextDelayMs);
      });
  }

  private emitDiagnostic(error: unknown): void {
    try {
      this.onDiagnostic?.(error);
    } catch {
      // Diagnostics never alter durable queue state.
    }
  }

  private async run(): Promise<void> {
    for (;;) {
      if (!this.enabled) return;
      const page = await this.inbox.claimNextPage(Date.now(), {
        ...(this.queueCursor !== undefined ? { cursor: this.queueCursor } : {}),
        limit: QUEUE_SCAN_PAGE,
      });
      const claimed = page.claimed;
      if (!claimed) {
        if (page.nextAttemptAt !== undefined) {
          this.queueNextAttemptAt = this.queueNextAttemptAt === undefined
            ? page.nextAttemptAt
            : Math.min(this.queueNextAttemptAt, page.nextAttemptAt);
        }
        if (page.nextCursor !== undefined) {
          this.queueCursor = page.nextCursor;
          this.nextDelayMs = CURSOR_YIELD_MS;
          return;
        }
        this.queueCursor = undefined;
        const earliest = this.queueNextAttemptAt;
        this.queueNextAttemptAt = undefined;
        this.nextDelayMs = earliest === undefined
          ? IDLE_SCAN_MS
          : Math.max(1, earliest - Date.now());
        return;
      }
      this.queueCursor = undefined;
      this.queueNextAttemptAt = undefined;
      this.nextDelayMs = 0;
      this.active = true;
      const { deliveryId } = claimed.record;
      const leaseId = claimed.record.leaseId;
      const context = {
        deliveryId,
        eventName: claimed.record.eventName!,
        attempt: claimed.record.attempt,
      };
      const heartbeat = setInterval(() => {
        void this.inbox
          .heartbeat(deliveryId, leaseId)
          .catch((error) => this.emitDiagnostic(new GitHubWebhookDiagnosticError(
            "GITHUB_WEBHOOK_HEARTBEAT_FAILED",
            context,
            error,
          )));
      }, 5_000);
      heartbeat.unref();
      try {
        let dispatchCompleted = false;
        try {
          await this.dispatch(claimed.record.event);
          dispatchCompleted = true;
          await this.inbox.complete(deliveryId, leaseId);
        } catch (error) {
          this.emitDiagnostic(new GitHubWebhookDiagnosticError(
            dispatchCompleted
              ? "GITHUB_WEBHOOK_COMPLETION_FAILED"
              : "GITHUB_WEBHOOK_DISPATCH_FAILED",
            context,
            error,
          ));
          try {
            await this.inbox.retry(deliveryId, leaseId);
          } catch (retryError) {
            throw new GitHubWebhookDiagnosticError(
              "GITHUB_WEBHOOK_RETRY_FAILED",
              context,
              retryError,
            );
          }
        }
      } finally {
        clearInterval(heartbeat);
        this.active = false;
      }
    }
  }

  async waitForIdle(timeoutMs = 10_000): Promise<void> {
    const started = Date.now();
    for (;;) {
      if (!this.active && (await this.inbox.pendingCount()) === 0) return;
      if (Date.now() - started >= timeoutMs) {
        throw new Error("Timed out waiting for GitHub webhook worker to drain");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  async stop(options: { drainMs?: number } = {}): Promise<void> {
    const drainMs = options.drainMs ?? 5_000;
    this.enabled = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const worker = this.worker;
    if (!worker) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        worker,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, drainMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
