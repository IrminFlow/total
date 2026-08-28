import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Button, Modal } from "../components/ui";
import { isAnyModalOpen } from "../components/modalRegistry";
import { commandPaletteShortcutAllowed } from "../App";

afterEach(cleanup);

describe("Modal", () => {
  it("renders an accessible labelled dialog and restores focus after closing", async () => {
    const close = vi.fn();
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();

    const view = render(
      <Modal title="Working period" onClose={close}>
        <Button>Apply</Button>
      </Modal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Working period" });
    expect(dialog).not.toBeNull();
    expect(isAnyModalOpen()).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);

    view.unmount();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(isAnyModalOpen()).toBe(false);
    trigger.remove();
  });

  it("turns Escape into an inline discard decision for dirty forms", () => {
    const close = vi.fn();
    render(
      <Modal title="Edit ledger" dirty onClose={close}>
        <input aria-label="Ledger name" defaultValue="Freight" />
      </Modal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText("Discard unsaved changes?")).not.toBeNull();

    fireEvent.click(screen.getByTestId("modal-discard"));
    expect(close).toHaveBeenCalledOnce();
  });

  it("suppresses the command palette shortcut while a modal is open", () => {
    expect(commandPaletteShortcutAllowed(null)).toBe(true);
    const view = render(
      <Modal title="Confirm posting" onClose={() => undefined}>
        <Button>Continue</Button>
      </Modal>,
    );

    expect(commandPaletteShortcutAllowed(null)).toBe(false);
    view.unmount();
    expect(commandPaletteShortcutAllowed(null)).toBe(true);
    expect(commandPaletteShortcutAllowed({ title: "Integrity warning" })).toBe(false);
  });
});
