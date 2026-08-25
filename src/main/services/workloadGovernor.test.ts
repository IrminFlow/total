import { describe, expect, it } from "vitest";
import { WorkloadGovernor } from "./workloadGovernor";

describe("WorkloadGovernor", () => {
  it("limits a lane, cancels queued work and retains observable counts", async () => {
    const governor = new WorkloadGovernor({ report: 1 });
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => (release = resolve));
    const first = governor.run("report", "first", () => blocker);
    const second = governor.run("report", "second", () => "stale");
    expect(governor.snapshot().queued.report).toBe(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.snapshot().active.report).toBe(1);
    expect(governor.cancel("second")).toBe(true);
    await expect(second).rejects.toThrow("cancelled");
    release();
    await first;
    expect(governor.snapshot()).toMatchObject({
      completed: 1,
      cancelled: 1,
      peakQueued: 1,
    });
  });
});
