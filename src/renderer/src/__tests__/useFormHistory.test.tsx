import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { useFormHistory } from "../lib/useFormHistory";

function useHarness() {
  const [value, setValue] = useState({ narration: "", amount: 0 });
  const history = useFormHistory(value, setValue);
  return { value, setValue, history };
}

describe("useFormHistory", () => {
  it("undoes and redoes form state while coalescing consecutive typing", () => {
    vi.useFakeTimers();
    const { result } = renderHook(useHarness);
    act(() => result.current.setValue({ narration: "P", amount: 0 }));
    act(() => result.current.setValue({ narration: "Paid", amount: 0 }));
    expect(result.current.history.canUndo).toBe(true);
    act(() => result.current.history.undo());
    expect(result.current.value).toEqual({ narration: "", amount: 0 });
    expect(result.current.history.canRedo).toBe(true);
    act(() => result.current.history.redo());
    expect(result.current.value).toEqual({ narration: "Paid", amount: 0 });
    vi.useRealTimers();
  });

  it("handles Cmd/Ctrl+Z and ignores history while disabled", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => {
        const [value, setValue] = useState({ amount: 0 });
        return { value, setValue, history: useFormHistory(value, setValue, enabled) };
      },
      { initialProps: { enabled: true } },
    );
    act(() => result.current.setValue({ amount: 12500 }));
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true, cancelable: true })));
    expect(result.current.value.amount).toBe(0);
    rerender({ enabled: false });
    act(() => result.current.setValue({ amount: 500 }));
    expect(result.current.history.canUndo).toBe(false);
  });
});
