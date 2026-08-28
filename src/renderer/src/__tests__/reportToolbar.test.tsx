import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ReportToolbar } from "../components/ReportToolbar";

describe("ReportToolbar", () => {
  it("keeps report controls in their canonical order", () => {
    render(
      <ReportToolbar
        view={<button>Register</button>}
        period={<button>Period</button>}
        granularity={<button>Quarter</button>}
        filters={<button>Open only</button>}
        comparison={<button>Prior year</button>}
        savedView={<button>Saved view</button>}
        columns={<button>Columns</button>}
        actions={<button>Export</button>}
      />,
    );
    const toolbar = screen.getByRole("toolbar", { name: "Report controls" });
    expect(
      [...toolbar.querySelectorAll("button")].map((button) => button.textContent),
    ).toEqual(["Register", "Period", "Quarter", "Open only", "Prior year", "Saved view", "Columns", "Export"]);
    expect(screen.getByRole("group", { name: "Report view" }).textContent).toBe("Register");
    expect(screen.getByRole("group", { name: "Period" }).textContent).toBe("Period");
    expect(screen.getByRole("group", { name: "Grouping" }).textContent).toBe("Quarter");
    expect(screen.getByRole("group", { name: "Filters" }).textContent).toBe("Open only");
    expect(screen.getByRole("group", { name: "Comparison" }).textContent).toBe("Prior year");
    expect(screen.getByRole("group", { name: "Saved views" }).textContent).toBe("Saved view");
    expect(screen.getByRole("group", { name: "Columns" }).textContent).toBe("Columns");
    expect(screen.getByRole("group", { name: "Report actions" }).textContent).toBe("Export");
  });

  it("supports a report-specific accessible name", () => {
    render(<ReportToolbar ariaLabel="Cash flow controls" actions={<button>Export</button>} />);
    expect(screen.getByRole("toolbar", { name: "Cash flow controls" })).toBeTruthy();
  });
});
