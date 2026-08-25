import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LedgerStatementScreen } from "../screens/LedgerStatement";
import { useSession } from "../state/stores";

const invoke = vi.fn();

function page(offset: number, totalRows = 450) {
  const count = Math.min(200, totalRows - offset);
  return {
    ledgerId: 7,
    ledgerName: "Trade Debtors",
    opening: 1_000,
    rows: Array.from({ length: count }, (_, index) => ({
      voucherId: offset + index + 1,
      date: "2025-04-01",
      voucherType: "Sales",
      number: `S-${offset + index + 1}`,
      particulars: "Sales Account",
      narration: null,
      debit: 100,
      credit: 0,
      running: 1_000 + (offset + index + 1) * 100,
    })),
    closing: 46_000,
    totalDebit: 45_000,
    totalCredit: 0,
    page: {
      offset,
      limit: 200,
      totalRows,
      hasPrevious: offset > 0,
      hasMore: offset + count < totalRows,
    },
  };
}

function renderScreen(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <LedgerStatementScreen ledgerId={7} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  invoke.mockReset();
  useSession.setState({ from: "2025-04-01", to: "2026-03-31" });
  window.total = { platform: "test", invoke };
});

afterEach(() => cleanup());

describe("ledger statement pagination", () => {
  it("mounts one server page and requests the next bounded page", async () => {
    invoke.mockImplementation(async (channel: string, payload: { offset?: number }) => {
      if (channel === "report:ledgerPage") return { ok: true, data: page(payload.offset ?? 0) };
      return { ok: false, error: `unmocked channel ${channel}` };
    });
    renderScreen();

    expect(await screen.findByText("1–200 of 450 entries")).toBeTruthy();
    expect(screen.getAllByText("Sales Account")).toHaveLength(200);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    expect(await screen.findByText("201–400 of 450 entries")).toBeTruthy();
    expect(screen.getAllByText("Sales Account")).toHaveLength(200);
    await waitFor(() => {
      const pageCalls = invoke.mock.calls.filter(([channel]) => channel === "report:ledgerPage");
      expect(pageCalls.at(-1)?.[1]).toMatchObject({ offset: 200, limit: 200 });
    });
  });

  it("shows a durable error state instead of an empty ledger", async () => {
    invoke.mockResolvedValue({ ok: false, error: "Database is busy" });
    renderScreen();

    expect((await screen.findByRole("alert")).textContent).toContain("Could not load the ledger statement");
    expect(screen.getByRole("button", { name: /Retry/ })).toBeTruthy();
    expect(screen.queryByText("No entries for this ledger in the period")).toBeNull();
  });

  it("shows an empty state for a monthly period with no entries", async () => {
    invoke.mockImplementation(async (channel: string, payload: { groupBy?: string }) => {
      if (channel !== "report:ledgerPage") return { ok: false, error: `unmocked channel ${channel}` };
      if (!payload.groupBy) return { ok: true, data: page(0, 1) };
      return {
        ok: true,
        data: {
          ...page(0, 0),
          rows: [],
          months: [{ month: "2025-04", debit: 0, credit: 0, closing: 1_000 }],
        },
      };
    });
    renderScreen();
    await screen.findByText("Sales Account");
    fireEvent.click(screen.getByTestId("tab-ledger-statement-monthly"));

    expect(await screen.findByText("No entries for this ledger in the period")).toBeTruthy();
    expect(screen.queryByText("Apr 2025")).toBeNull();
  });
});
