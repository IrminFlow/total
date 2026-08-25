import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RegistersScreen } from "../screens/Registers";
import { useSession } from "../state/stores";

const invoke = vi.fn();
const quarterlyRows = [
  { key: "2026-27-Q1", label: "Q1 2026-27", from: "2026-04-01", to: "2026-06-30", vouchers: 2, taxable: 100_050, tax: 18_009, total: 118_059 },
  { key: "2026-27-Q4", label: "Q4 2026-27", from: "2027-01-01", to: "2027-03-31", vouchers: 1, taxable: 50_000, tax: 9_000, total: 59_000 },
];

beforeEach(() => {
  useSession.setState({ from: "2026-04-01", to: "2027-03-31" });
  invoke.mockImplementation(async (channel: string, payload?: Record<string, unknown>) => {
    if (channel === "analysis:register") return {
      ok: true,
      data: payload?.granularity === "quarter" ? quarterlyRows : [],
    };
    if (channel === "export:csv") return { ok: true, data: { path: "/exports/register.csv", metadataPath: "/exports/register.meta.json" } };
    if (channel === "report:pdf") return { ok: true, data: { path: "/exports/register.pdf" } };
    return { ok: false, error: `unmocked channel ${channel}` };
  });
  window.total = { platform: "test", invoke };
});

afterEach(() => cleanup());

function renderRegisters(): void {
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <RegistersScreen />
    </QueryClientProvider>,
  );
}

describe("quarterly register exports", () => {
  it("keeps quarter labels, integer-paise totals and period bounds in CSV and PDF payloads", async () => {
    renderRegisters();
    fireEvent.click(screen.getByRole("tab", { name: "Quarter" }));
    expect(await screen.findByText("Q1 2026-27")).toBeTruthy();

    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByRole("menuitem", { name: "CSV data" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("export:csv", expect.anything()));
    const csvPayload = invoke.mock.calls.find(([channel]) => channel === "export:csv")![1];
    expect({ filename: csvPayload.filename, csv: csvPayload.csv }).toMatchInlineSnapshot(`
      {
        "csv": "﻿Period,Vouchers,Taxable value,GST,Invoice total
      Q1 2026-27,2,"1,000.50",180.09,"1,180.59"
      Q4 2026-27,1,500.00,90.00,590.00
      Total,3,"1,500.50",270.09,"1,770.59"
      ",
        "filename": "sales-register-quarter",
      }
    `);

    fireEvent.click(screen.getByText("Export"));
    fireEvent.click(screen.getByRole("menuitem", { name: "PDF report" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("report:pdf", expect.anything()));
    const pdfPayload = invoke.mock.calls.find(([channel]) => channel === "report:pdf")![1];
    expect({
      title: pdfPayload.title,
      periodLabel: pdfPayload.periodLabel,
      columns: pdfPayload.columns,
      rows: pdfPayload.rows,
      provenancePeriod: pdfPayload.provenance.period,
    }).toMatchInlineSnapshot(`
      {
        "columns": [
          {
            "align": "l",
            "label": "Period",
          },
          {
            "align": "r",
            "label": "Vouchers",
          },
          {
            "align": "r",
            "label": "Taxable value",
          },
          {
            "align": "r",
            "label": "GST",
          },
          {
            "align": "r",
            "label": "Invoice total",
          },
        ],
        "periodLabel": "01-Apr-26 → 31-Mar-27",
        "provenancePeriod": "01-Apr-26 → 31-Mar-27",
        "rows": [
          {
            "cells": [
              "Q1 2026-27",
              "2",
              "1,000.50",
              "180.09",
              "1,180.59",
            ],
          },
          {
            "cells": [
              "Q4 2026-27",
              "1",
              "500.00",
              "90.00",
              "590.00",
            ],
          },
          {
            "bold": true,
            "cells": [
              "Total",
              "3",
              "1,500.50",
              "270.09",
              "1,770.59",
            ],
            "rule": true,
          },
        ],
        "title": "Sales register",
      }
    `);
  });
});
