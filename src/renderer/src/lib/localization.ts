import type { UiLanguage } from "./accessibilityPrefs";

const HINDI: Record<string, string> = {
  Gateway: "मुख्य पृष्ठ",
  "Action centre": "कार्य केंद्र",
  "Control room": "नियंत्रण कक्ष",
  Assist: "सहायता",
  "Task inbox": "कार्य सूची",
  "Voucher entry": "वाउचर प्रविष्टि",
  "Voucher drafts": "वाउचर ड्राफ्ट",
  "Entry templates": "प्रविष्टि टेम्पलेट",
  "Day book": "डे बुक",
  "Import from Tally": "टैली से आयात",
  Masters: "मास्टर्स",
  "Trial balance": "ट्रायल बैलेंस",
  "Profit & Loss": "लाभ और हानि",
  "Balance sheet": "बैलेंस शीट",
  "Cash flow": "नकदी प्रवाह",
  "Stock summary": "स्टॉक सारांश",
  "Inventory control": "इन्वेंटरी नियंत्रण",
  "Ledger statement": "लेजर विवरण",
  Banking: "बैंकिंग",
  "Banking — reconciliation, BRS & post-dated": "बैंकिंग, मिलान, BRS और पोस्ट-डेटेड",
  Reconciliation: "मिलान",
  Payroll: "पेरोल",
  "Payroll — employees & runs": "पेरोल, कर्मचारी और रन",
  "Employees & runs": "कर्मचारी और रन",
  Procurement: "खरीद प्रबंधन",
  "Sales desk": "बिक्री डेस्क",
  "Recurring vouchers": "आवर्ती वाउचर",
  Registers: "रजिस्टर",
  "Collections queue": "वसूली सूची",
  "Supplier due queue": "सप्लायर देय सूची",
  Outstandings: "बकाया",
  "Consolidated reports": "समेकित रिपोर्ट",
  "Cost centres": "लागत केंद्र",
  Budgets: "बजट",
  "Management insights": "प्रबंधन विश्लेषण",
  Exceptions: "अपवाद",
  "Company details": "कंपनी विवरण",
  "Month close": "माह बंद",
  "Year-end close": "वर्षांत बंद",
  "Compliance centre": "अनुपालन केंद्र",
  "GSTR-2B recon": "GSTR-2B मिलान",
  "e-Invoice & e-Way": "ई-इनवॉइस और ई-वे",
  Settings: "सेटिंग्स",
  Books: "बहीखाते",
  Analysis: "विश्लेषण",
  Compliance: "अनुपालन",
  Operations: "संचालन",
  System: "प्रणाली",
  Workspace: "कार्यस्थान",
  Pinned: "पिन किए गए",
  Global: "सभी स्क्रीन",
  Navigation: "नेविगेशन",
  "Voucher entry shortcuts": "वाउचर प्रविष्टि शॉर्टकट",
  Lists: "सूचियां",
  "Keyboard shortcuts": "कीबोर्ड शॉर्टकट",
  "Open the command palette": "कमांड पैलेट खोलें",
  "Close a dialog, or go back a screen":
    "डायलॉग बंद करें या पिछली स्क्रीन पर जाएं",
  "Show this shortcut reference": "शॉर्टकट सूची दिखाएं",
  "Move the selection": "चयन बदलें",
  "Open the selected row": "चुनी हुई पंक्ति खोलें",
  "Save the voucher": "वाउचर सहेजें",
  Contra: "कॉन्ट्रा",
  Payment: "भुगतान",
  Receipt: "प्राप्ति",
  Journal: "जर्नल",
  Sales: "बिक्री",
  Purchase: "खरीद",
  "Credit note": "क्रेडिट नोट",
  "Debit note": "डेबिट नोट",
  "Search books": "बहीखातों में खोजें",
  "Switch theme": "थीम बदलें",
  "Switch to dark theme": "गहरे रंग की थीम पर जाएं",
  "Switch to light theme": "हल्के रंग की थीम पर जाएं",
  "Open help centre": "सहायता केंद्र खोलें",
  "Help centre": "सहायता केंद्र",
  "App utilities": "ऐप उपयोगिताएं",
  Lock: "लॉक करें",
  "Lock {user}'s session": "{user} का सत्र लॉक करें",
  "Switch company without leaving workspace":
    "कार्यस्थान छोड़े बिना कंपनी बदलें",
  "Switch company": "कंपनी बदलें",
  "Workspace profile": "कार्यस्थान प्रोफ़ाइल",
  "Quick start": "तुरंत शुरू करें",
  "Save local snapshot": "स्थानीय स्नैपशॉट सहेजें",
  "Local recovery snapshot saved": "स्थानीय रिकवरी स्नैपशॉट सहेजा गया",
  "Switched to {company}": "{company} पर स्विच किया",
  "Each company keeps its own workspace, dates and reading position.":
    "हर कंपनी अपना कार्यस्थान, तारीखें और पढ़ने की स्थिति अलग रखती है।",
  Unregistered: "अपंजीकृत",
  Current: "वर्तमान",
  "Opening…": "खुल रही है…",
  "Open →": "खोलें →",
};

type LocalizedValues = Readonly<Record<string, string | number>>;

function interpolate(
  template: string,
  values: LocalizedValues | undefined,
): string {
  if (!values) return template;
  return template.replace(/\{([^{}]+)\}/g, (placeholder, key: string) =>
    Object.hasOwn(values, key) ? String(values[key]) : placeholder,
  );
}

/** Hindi stays bilingual so standard English accounting terms remain searchable and learnable. */
export function localizedLabel(
  english: string,
  language: UiLanguage,
  values?: LocalizedValues,
): string {
  const englishWithValues = interpolate(english, values);
  if (language !== "hi") return englishWithValues;
  const translated = HINDI[english];
  return translated
    ? `${interpolate(translated, values)} (${englishWithValues})`
    : englishWithValues;
}
