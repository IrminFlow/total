import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../lib/client";
import { useVoucherDraftAutosave } from "../lib/useVoucherDraftAutosave";

vi.mock("../lib/client", () => ({ api: { voucherDrafts: { save: vi.fn() } } }));

const draft = (title: string) => ({
  voucherTypeId: 1,
  mode: "accounting" as const,
  title,
  payloadVersion: 1,
  payload: { narration: title },
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("voucher draft autosave", () => {
  it("debounces meaningful edits and updates the same draft", async () => {
    vi.useFakeTimers();
    vi.mocked(api.voucherDrafts.save)
      .mockResolvedValueOnce({ id: 41 } as never)
      .mockResolvedValueOnce({ id: 41 } as never);
    const { result, rerender } = renderHook(
      ({ value }) => useVoucherDraftAutosave({ enabled: true, meaningful: true, draft: draft(value), delayMs: 100 }),
      { initialProps: { value: "First" } },
    );
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(result.current.draftId).toBe(41);
    rerender({ value: "Second" });
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(api.voucherDrafts.save).toHaveBeenLastCalledWith(draft("Second"), 41);
  });

  it("does not persist an empty entry", async () => {
    vi.useFakeTimers();
    renderHook(() => useVoucherDraftAutosave({ enabled: true, meaningful: false, draft: draft("Empty"), delayMs: 10 }));
    await act(async () => vi.advanceTimersByTimeAsync(20));
    expect(api.voucherDrafts.save).not.toHaveBeenCalled();
  });
});
