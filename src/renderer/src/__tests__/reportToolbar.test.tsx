import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportToolbar } from "../components/ReportToolbar";

describe("ReportToolbar", () => {
  it("keeps report controls in their canonical order", () => {
    render(
      <ReportToolbar
        period={<button>Period</button>}
        granularity={<button>Quarter</button>}
        comparison={<button>Prior year</button>}
        savedView={<button>Saved view</button>}
        columns={<button>Columns</button>}
        actions={<button>Export</button>}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Report controls" });
    expect(
      [...toolbar.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["Period", "Quarter", "Prior year", "Saved view", "Columns", "Export"]);
  });
});
