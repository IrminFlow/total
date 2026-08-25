import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useBoundedRows } from "../lib/useBoundedRows";

describe("useBoundedRows", () => {
  it("bounds mounted rows, advances by a page and resets for a changed report", () => {
    const rows = Array.from({ length: 550 }, (_, index) => index);
    const { result, rerender } = renderHook(
      ({ resetKey }) => useBoundedRows(rows, resetKey, 200),
      { initialProps: { resetKey: "first" } },
    );
    expect(result.current.visibleCount).toBe(200);
    expect(result.current.remaining).toBe(350);
    act(() => result.current.showMore());
    expect(result.current.visibleCount).toBe(400);
    rerender({ resetKey: "second" });
    expect(result.current.visibleCount).toBe(200);
  });
});
