import { describe, expect, it } from "vitest";
import { localeGuidance } from "./localeHelp";

describe("localeGuidance", () => {
  it("tailors help by state and registration without changing accounting data", () => {
    const guidance = localeGuidance({
      stateCode: "27",
      gstRegistrationType: "regular",
    });
    expect(guidance.stateName).toBe("Maharashtra");
    expect(guidance.gst).toContain("home state");
    expect(guidance.payroll).toContain("professional-tax");
    expect(guidance.invoice).toContain("Marathi");
  });

  it("does not recommend regular-scheme filing to composition businesses", () => {
    const guidance = localeGuidance({
      stateCode: "24",
      gstRegistrationType: "composition",
    });
    expect(guidance.registrationLabel).toBe("Composition GST registration");
    expect(guidance.gst).toContain("not suggested");
    expect(guidance.invoice).toContain("Gujarati");
  });
});
