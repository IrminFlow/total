import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CommunicationsScreen } from "../screens/Communications";
import { useSession } from "../state/stores";
import type { CommunicationBatch } from "@shared/communications";
import { api } from "../lib/client";

const invoke = vi.fn();

const permissionMatrix = {
  owner: {
    view: true,
    create: true,
    edit: true,
    approve: true,
    export: true,
    backup: true,
    settings: true,
  },
  accountant: {
    view: true,
    create: true,
    edit: true,
    approve: false,
    export: true,
    backup: false,
    settings: false,
  },
  viewer: {
    view: true,
    create: false,
    edit: false,
    approve: false,
    export: false,
    backup: false,
    settings: false,
  },
};

function renderScreen(): void {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <CommunicationsScreen />
    </QueryClientProvider>,
  );
}

const message = (id: string, subject: string) => ({
  id,
  idempotencyKey: `ui:${id}`,
  ledgerId: null,
  contactId: null,
  channel: "email",
  to: [`${subject.toLowerCase().replaceAll(" ", ".")}@example.com`],
  cc: [],
  bcc: [],
  subject,
  bodyText: `Please review ${subject}.`,
  contentSha256: "a".repeat(64),
  sender: null,
  revision: 1,
  status: "draft",
  smtpProfileId: null,
  attempts: 0,
  reviewedBy: null,
  reviewedAt: null,
  queuedAt: null,
  acceptedAt: null,
  exportedAt: null,
  lastError: null,
  createdBy: "Maker",
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
});

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
    return channel in data
      ? { ok: true, data: data[channel] }
      : { ok: false, error: `unmocked channel ${channel}` };
  });
  window.total = { platform: "test", invoke };
  useSession.setState({ user: null });
});

afterEach(() => cleanup());

describe("message outbox", () => {
  it("maps every batch workflow method to its strict IPC channel", async () => {
    invoke.mockResolvedValue({ ok: true, data: {} });
    const id = "00000000-0000-4000-8000-000000000099";
    const messageId = "00000000-0000-4000-8000-000000000011";
    await api.communications.batches.list({ status: "approved", limit: 20 });
    await api.communications.batches.get(id);
    await api.communications.batches.events(id);
    await api.communications.batches.create({
      name: "August",
      items: [
        {
          messageId,
          documentKind: "invoice",
          documentLabel: "INV-1",
          amountPaise: 10_000,
          exclusionReason: null,
        },
      ],
    });
    await api.communications.batches.approve(id, "Checked");
    await api.communications.batches.reject(id, "Wrong period");
    await api.communications.batches.enqueue(id, 4, [7, 8]);
    await api.communications.batches.cancel(id);
    expect(invoke.mock.calls).toEqual([
      ["communications:batches:list", { status: "approved", limit: 20 }],
      ["communications:batches:get", { id }],
      ["communications:batches:events", { id }],
      [
        "communications:batches:create",
        expect.objectContaining({ name: "August" }),
      ],
      ["communications:batches:approve", { id, note: "Checked" }],
      ["communications:batches:reject", { id, note: "Wrong period" }],
      [
        "communications:batches:enqueue",
        { id, smtpProfileId: 4, itemIds: [7, 8] },
      ],
      ["communications:batches:cancel", { id }],
    ]);
  });

  it("keeps SMTP submission off by default while leaving local drafting available", async () => {
    renderScreen();
    expect(await screen.findByText("Preview foundation.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New message" }));
    expect(screen.getByText("Nothing is sent from this form")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Save draft" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("sends an idempotent draft payload through the typed client", async () => {
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "communications:messages:createDraft") {
        return {
          ok: true,
          data: { id: "72d8e4c7-a1dc-4bb5-a033-954914c84c87" },
        };
      }
      const data: Record<string, unknown> = {
        "master:ledgers:list": [],
        "communications:messages:list": [],
        "communications:smtp:list": [],
        "permissions:get": permissionMatrix,
      };
      return channel in data
        ? { ok: true, data: data[channel] }
        : { ok: false, error: "unexpected" };
    });
    renderScreen();
    fireEvent.click(await screen.findByRole("button", { name: "New message" }));
    fireEvent.change(screen.getByLabelText(/^To/), {
      target: { value: "Accounts@Example.com" },
    });
    fireEvent.change(screen.getByLabelText("Subject"), {
      target: { value: "August statement" },
    });
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "Please find the statement attached." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        "communications:messages:createDraft",
        expect.objectContaining({
          to: ["accounts@example.com"],
          subject: "August statement",
          bodyText: "Please find the statement attached.",
          idempotencyKey: expect.stringMatching(/^ui:/),
        }),
      ),
    );
  });

  it("builds an exact approval batch from selected drafts", async () => {
    const first = message(
      "00000000-0000-4000-8000-000000000011",
      "August invoice",
    );
    const second = message(
      "00000000-0000-4000-8000-000000000012",
      "August statement",
    );
    invoke.mockImplementation(async (channel: string, payload?: unknown) => {
      if (channel === "communications:batches:create") {
        return {
          ok: true,
          data: {
            id: "00000000-0000-4000-8000-000000000099",
            status: "pending_approval",
          },
        };
      }
      const data: Record<string, unknown> = {
        "master:ledgers:list": [],
        "communications:messages:list": [first, second],
        "communications:batches:list": [],
        "communications:smtp:list": [],
        "permissions:get": permissionMatrix,
      };
      return channel in data
        ? { ok: true, data: data[channel] }
        : {
            ok: false,
            error: `unexpected ${channel} ${JSON.stringify(payload)}`,
          };
    });
    renderScreen();
    fireEvent.click(
      await screen.findByRole("button", { name: "Approval batches" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /New approval batch/ }),
    );
    fireEvent.change(screen.getByLabelText("Batch name"), {
      target: { value: "August dispatch" },
    });
    fireEvent.click(await screen.findByLabelText("Select August invoice"));
    fireEvent.change(screen.getByLabelText("Amount for August invoice"), {
      target: { value: "1250.50" },
    });
    expect(screen.getByText("₹1,250.50")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Create approval batch" }),
    );
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("communications:batches:create", {
        name: "August dispatch",
        items: [
          expect.objectContaining({
            messageId: first.id,
            documentKind: "invoice",
            documentLabel: "August invoice",
            amountPaise: 125_050,
            exclusionReason: null,
          }),
        ],
      }),
    );
  });

  it("shows maker-checker and retry evidence without claiming delivery", async () => {
    const batchId = "00000000-0000-4000-8000-000000000099";
    const source = message(
      "00000000-0000-4000-8000-000000000011",
      "August invoice",
    );
    const batch: CommunicationBatch = {
      id: batchId,
      name: "August dispatch",
      status: "pending_approval",
      makerUserId: 7,
      makerName: "Maker",
      checkerUserId: null,
      checkerName: null,
      decisionNote: null,
      selectedCount: 1,
      includedCount: 1,
      excludedCount: 0,
      recipientCount: 1,
      totalAmountPaise: 125_050,
      createdAt: source.createdAt,
      reviewedAt: null,
      updatedAt: source.updatedAt,
      items: [
        {
          id: 1,
          batchId,
          messageId: source.id,
          position: 0,
          status: "ready",
          documentKind: "invoice",
          documentLabel: "August invoice",
          amountPaise: 125_050,
          messageRevision: 1,
          contentSha256: source.contentSha256,
          ledgerId: null,
          contactId: null,
          to: source.to,
          cc: [],
          bcc: [],
          subject: source.subject,
          bodyText: source.bodyText,
          exclusionReason: null,
          attempts: 0,
          lastError: null,
          queuedAt: null,
          messageStatus: "reviewed",
        },
      ],
    };
    let currentBatch = batch;
    useSession.setState({ user: { id: 7, name: "Maker", role: "owner" } });
    invoke.mockImplementation(async (channel: string) => {
      const data: Record<string, unknown> = {
        "master:ledgers:list": [],
        "communications:messages:list": [source],
        "communications:batches:list": [currentBatch],
        "communications:batches:events": [
          {
            id: 1,
            batchId,
            eventType: "item_failed",
            detail: {},
            actor: "Checker",
            createdAt: source.createdAt,
          },
        ],
        "communications:smtp:list": [],
        "permissions:get": permissionMatrix,
      };
      return channel in data
        ? { ok: true, data: data[channel] }
        : { ok: false, error: `unexpected ${channel}` };
    });
    renderScreen();
    fireEvent.click(
      await screen.findByRole("button", { name: "Approval batches" }),
    );
    expect(
      await screen.findByText("Different-user check required"),
    ).toBeTruthy();
    expect(
      screen.getByText(/The maker, Maker, cannot approve their own batch/),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Approve exact preview",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    currentBatch = {
      ...batch,
      status: "partially_queued",
      checkerUserId: 8,
      checkerName: "Checker",
      items: batch.items.map((item) => ({
        ...item,
        status: "failed",
        attempts: 2,
        lastError: "Local queue profile was unavailable",
      })),
    };
    useSession.setState({ user: { id: 8, name: "Checker", role: "owner" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh batches" }));
    expect(
      await screen.findByText(/Local queue profile was unavailable/),
    ).toBeTruthy();
    expect(await screen.findByText(/item failed/i)).toBeTruthy();
    expect(
      screen.getByText(/Queueing assigns a device-owned SMTP profile/),
    ).toBeTruthy();
    expect(screen.queryByText(/recipient delivery confirmed/i)).toBeNull();
  });
});
