import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ReportConfigButton } from "../components/ReportConfigButton";

beforeAll(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  });
});
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

describe("ReportConfigButton", () => {
  it("opens an accessible keyboard-dismissable column popover", async () => {
    const toggle = vi.fn();
    render(
      <ReportConfigButton
        columns={[
          { key: "debit", label: "Debit", defaultOn: true },
          { key: "narration", label: "Narration", defaultOn: false },
        ]}
        visible={{ debit: true, narration: false }}
        toggle={toggle}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Configure columns" });
    fireEvent.click(trigger);
    const popover = screen.getByLabelText("Visible report columns");
    expect(popover).not.toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: "Narration" }));
    expect(toggle).toHaveBeenCalledWith("narration");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByLabelText("Visible report columns")).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});
