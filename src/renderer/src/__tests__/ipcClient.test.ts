import { beforeEach, describe, expect, it, vi } from "vitest";
import { call, cancellableCall } from "../lib/ipcClient";

const invoke = vi.fn();

beforeEach(() => {
  invoke.mockReset();
  Object.defineProperty(window, "total", {
    configurable: true,
    value: { invoke },
  });
});

describe("renderer IPC client", () => {
  it("returns successful payloads and preserves main-process errors", async () => {
    invoke.mockResolvedValueOnce({ ok: true, data: { version: "0.5.0" } });
    await expect(call("app:info")).resolves.toEqual({ version: "0.5.0" });

    invoke.mockResolvedValueOnce({ ok: false, error: "Company is locked" });
    await expect(call("company:current")).rejects.toThrow("Company is locked");
  });

  it("cancels an in-flight request with the generated request id", async () => {
    invoke.mockImplementation((channel: string) => channel === "request:cancel"
      ? Promise.resolve({ ok: true, data: null })
      : new Promise(() => undefined));
    const controller = new AbortController();
    const pending = cancellableCall("report:daybook", { from: "2026-04-01" }, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const payload = invoke.mock.calls.find(([channel]) => channel === "report:daybook")?.[1] as { __totalRequestId: string };
    expect(payload.__totalRequestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(invoke).toHaveBeenCalledWith("request:cancel", { requestId: payload.__totalRequestId });
  });
});
