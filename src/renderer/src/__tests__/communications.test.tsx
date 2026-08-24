import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommunicationsScreen } from "../screens/Communications";

const invoke = vi.fn();

const permissionMatrix = {
  owner: { view: true, create: true, edit: true, approve: true, export: true, backup: true, settings: true },
  accountant: { view: true, create: true, edit: true, approve: false, export: true, backup: false, settings: false },
  viewer: { view: true, create: false, edit: false, approve: false, export: false, backup: false, settings: false },
};

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><CommunicationsScreen /></QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  invoke.mockReset();
  invoke.mockImplementation(async (channel: string) => {
    const data: Record<string, unknown> = {
      "master:ledgers:list": [],
      "communications:messages:list": [],
      "communications:smtp:list": [],
      "permissions:get": permissionMatrix,
    };
    return channel in data ? { ok: true, data: data[channel] } : { ok: false, error: `unmocked channel ${channel}` };
  });
  window.total = { platform: "test", invoke };
});

afterEach(() => cleanup());

describe("message outbox", () => {
  it("keeps SMTP submission off by default while leaving local drafting available", async () => {
    renderScreen();
    expect(await screen.findByText("Preview foundation.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(screen.getByText("Nothing is sent from this form")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("sends an idempotent draft payload through the typed client", async () => {
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "communications:messages:createDraft") {
        return { ok: true, data: { id: "72d8e4c7-a1dc-4bb5-a033-954914c84c87" } };
      }
      const data: Record<string, unknown> = {
        "master:ledgers:list": [],
        "communications:messages:list": [],
        "communications:smtp:list": [],
        "permissions:get": permissionMatrix,
      };
      return channel in data ? { ok: true, data: data[channel] } : { ok: false, error: "unexpected" };
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "New message" }));
    fireEvent.change(screen.getByLabelText(/^To/), { target: { value: "Accounts@Example.com" } });
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "August statement" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Please find the statement attached." } });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith(
      "communications:messages:createDraft",
      expect.objectContaining({
        to: ["accounts@example.com"],
        subject: "August statement",
        bodyText: "Please find the statement attached.",
        idempotencyKey: expect.stringMatching(/^ui:/),
      }),
    ));
  });
});
