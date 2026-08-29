import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ActionMenu } from "../components/ActionMenu";

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});
afterAll(() => vi.unstubAllGlobals());
afterEach(cleanup);

const items = [
  { id: "skip", label: "Skip", onSelect: vi.fn() },
  { id: "edit", label: "Edit", onSelect: vi.fn() },
  { id: "delete", label: "Delete", danger: true, onSelect: vi.fn() },
];

function renderMenu(): HTMLButtonElement {
  render(
    <ActionMenu
      ariaLabel="Template actions"
      testId="menu-trigger"
      triggerClassName=""
      trigger="Actions"
      items={items}
    />,
  );
  return screen.getByTestId("menu-trigger") as HTMLButtonElement;
}

describe("ActionMenu", () => {
  it("moves focus through every item with Arrow, Home and End", async () => {
    const trigger = renderMenu();

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu", { name: "Template actions" });
    const menuItems = screen.getAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(menuItems[0]));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(menuItems[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(menuItems[2]);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(menuItems[0]);
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(menuItems[2]);
  });

  it("opens upward on the last item and returns focus after Escape", async () => {
    const trigger = renderMenu();

    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    const menuItems = await screen.findAllByRole("menuitem");
    await waitFor(() => expect(document.activeElement).toBe(menuItems[2]));

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Template actions" })).toBeNull(),
    );
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses after selection and runs the selected action", async () => {
    const trigger = renderMenu();
    fireEvent.click(trigger);

    const edit = await screen.findByRole("menuitem", { name: "Edit" });
    fireEvent.click(edit);
    await waitFor(() =>
      expect(screen.queryByRole("menu", { name: "Template actions" })).toBeNull(),
    );
    expect(items[1]?.onSelect).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(trigger);
  });
});
