import type { CompanyInfo } from "./domain";

const STATE_NAMES: Record<string, string> = {
  "07": "Delhi",
  "09": "Uttar Pradesh",
  "19": "West Bengal",
  "24": "Gujarat",
  "27": "Maharashtra",
  "29": "Karnataka",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "36": "Telangana",
};

export interface LocaleGuidance {
  stateName: string;
  registrationLabel: string;
  gst: string;
  payroll: string;
  invoice: string;
}

/** Presentation-only guidance. It never changes tax calculations, filing data or payroll rules. */
export function localeGuidance(
  company: Pick<CompanyInfo, "stateCode" | "gstRegistrationType">,
): LocaleGuidance {
  const stateName =
    STATE_NAMES[company.stateCode] ?? `GST state ${company.stateCode}`;
  const registrationLabel =
    company.gstRegistrationType === "regular"
      ? "Regular GST registration"
      : company.gstRegistrationType === "composition"
        ? "Composition GST registration"
        : "Unregistered business";

  const gst =
    company.gstRegistrationType === "regular"
      ? `GST help uses ${stateName} as the home state for place-of-supply guidance. Filing figures still come only from posted vouchers.`
      : company.gstRegistrationType === "composition"
        ? `Composition guidance is shown for ${stateName}. Tax invoices and regular-scheme filing steps are not suggested.`
        : `GST filing prompts stay secondary because this company is unregistered. ${stateName} remains the address state.`;

  const payroll =
    company.stateCode === "27"
      ? "Payroll help highlights Maharashtra professional-tax checks when payroll is enabled."
      : company.stateCode === "29"
        ? "Payroll help highlights Karnataka professional-tax checks when payroll is enabled."
        : `Payroll help identifies ${stateName} as the establishment state and asks the user to confirm current state obligations.`;

  const invoice =
    company.stateCode === "27"
      ? "Marathi and Hindi customer-facing invoice labels are available alongside English."
      : company.stateCode === "24"
        ? "Gujarati and Hindi customer-facing invoice labels are available alongside English."
        : company.stateCode === "33"
          ? "Tamil customer-facing invoice labels are available alongside English."
          : "English and selected Indian-language invoice labels are available in Invoice print settings.";

  return { stateName, registrationLabel, gst, payroll, invoice };
}
