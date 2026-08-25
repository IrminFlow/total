export type WorkloadKind = "report" | "export" | "document" | "maintenance";

interface PendingJob<T> {
  id: string;
  task: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  enqueuedAt: number;
}

export interface WorkloadSnapshot {
  active: Record<WorkloadKind, number>;
  queued: Record<WorkloadKind, number>;
  completed: number;
  cancelled: number;
  peakQueued: number;
  recent: Array<{
    kind: WorkloadKind;
    queuedMs: number;
    durationMs: number;
    outcome: "completed" | "failed" | "cancelled";
    at: string;
  }>;
}

const KINDS: WorkloadKind[] = ["report", "export", "document", "maintenance"];

/** Bounded, cancellation-aware queue for non-interactive work in the Electron main process. */
export class WorkloadGovernor {
  private readonly limits: Record<WorkloadKind, number>;
  private readonly active = new Map<WorkloadKind, number>();
  private readonly queues = new Map<WorkloadKind, PendingJob<unknown>[]>();
  private readonly cancelledIds = new Set<string>();
  private completed = 0;
  private cancelled = 0;
  private peakQueued = 0;
  private readonly recent: WorkloadSnapshot["recent"] = [];

  constructor(limits: Partial<Record<WorkloadKind, number>> = {}) {
    this.limits = {
      report: 1,
      export: 1,
      document: 1,
      maintenance: 1,
      ...limits,
    };
    for (const kind of KINDS) {
      if (!Number.isInteger(this.limits[kind]) || this.limits[kind] < 1)
        throw new Error(`Invalid ${kind} workload limit`);
      this.active.set(kind, 0);
      this.queues.set(kind, []);
    }
  }

  run<T>(
    kind: WorkloadKind,
    id: string,
    task: () => Promise<T> | T,
  ): Promise<T> {
    if (!id || id.length > 100)
      return Promise.reject(new Error("Invalid workload request id"));
    return new Promise<T>((resolve, reject) => {
      const queue = this.queues.get(kind)!;
      queue.push({
        id,
        task,
        resolve,
        reject,
        enqueuedAt: Date.now(),
      } as PendingJob<unknown>);
      this.peakQueued = Math.max(this.peakQueued, queue.length);
      this.drain(kind);
    });
  }

  cancel(id: string): boolean {
    if (!id || id.length > 100) return false;
    this.cancelledIds.add(id);
    let found = false;
    for (const kind of KINDS) {
      const queue = this.queues.get(kind)!;
      const index = queue.findIndex((job) => job.id === id);
      if (index >= 0) {
        const [job] = queue.splice(index, 1);
        job?.reject(new Error("Request cancelled"));
        this.cancelled += 1;
        found = true;
      }
    }
    // Active synchronous jobs cannot be interrupted safely on the shared writer connection, but
    // their result is discarded when they finish. Bound the tombstone lifetime.
    setTimeout(() => this.cancelledIds.delete(id), 60_000).unref?.();
    return found;
  }

  snapshot(): WorkloadSnapshot {
    return {
      active: Object.fromEntries(
        KINDS.map((kind) => [kind, this.active.get(kind)!]),
      ) as Record<WorkloadKind, number>,
      queued: Object.fromEntries(
        KINDS.map((kind) => [kind, this.queues.get(kind)!.length]),
      ) as Record<WorkloadKind, number>,
      completed: this.completed,
      cancelled: this.cancelled,
      peakQueued: this.peakQueued,
      recent: [...this.recent],
    };
  }

  private drain(kind: WorkloadKind): void {
    const queue = this.queues.get(kind)!;
    while (this.active.get(kind)! < this.limits[kind] && queue.length > 0) {
      const job = queue.shift()!;
      if (this.cancelledIds.delete(job.id)) {
        job.reject(new Error("Request cancelled"));
        this.cancelled += 1;
        continue;
      }
      this.active.set(kind, this.active.get(kind)! + 1);
      const startedAt = Date.now();
      // Yield once before background work so input, navigation and cancellation IPC are serviced.
      setImmediate(() => {
        Promise.resolve()
          .then(job.task)
          .then((value) => {
            if (this.cancelledIds.delete(job.id)) {
              this.cancelled += 1;
              this.record(kind, job.enqueuedAt, startedAt, "cancelled");
              job.reject(new Error("Request cancelled"));
            } else {
              this.completed += 1;
              this.record(kind, job.enqueuedAt, startedAt, "completed");
              job.resolve(value);
            }
          })
          .catch((error: unknown) => {
            this.record(kind, job.enqueuedAt, startedAt, "failed");
            job.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          })
          .finally(() => {
            this.active.set(kind, this.active.get(kind)! - 1);
            this.drain(kind);
          });
      });
    }
  }

  private record(
    kind: WorkloadKind,
    enqueuedAt: number,
    startedAt: number,
    outcome: "completed" | "failed" | "cancelled",
  ): void {
    this.recent.unshift({
      kind,
      queuedMs: Math.max(0, startedAt - enqueuedAt),
      durationMs: Math.max(0, Date.now() - startedAt),
      outcome,
      at: new Date().toISOString(),
    });
    if (this.recent.length > 100) this.recent.length = 100;
  }
}

export const backgroundWork = new WorkloadGovernor();
