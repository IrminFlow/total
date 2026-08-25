/**
 * Bilingual invoice labels (roadmap I-184).
 *
 * The second language is printed BESIDE the English label, never instead of it. A tax invoice is
 * read by an officer, a bank and a court before it is read by the customer, and every one of them
 * reads the English text; replacing it to be friendly would make the document harder to defend.
 * So the rule is additive: English first, translation after, one separator decided in one place.
 */

/**
 * Languages a label pack exists for.
 *
 * The set is deliberately small. A label pack is a translation somebody has to be able to check —
 * a wrong word on a statutory document is worse than an absent one, because the reader trusts it.
 * Hindi and Marathi are both Devanagari, which is what the roadmap item asks for, and both have
 * settled commercial/GST vocabulary. Further languages should arrive one at a time, each with a
 * speaker who has read a printed invoice, not as a batch out of a translation API.
 */
export type InvoiceLanguage = 'none' | 'hi' | 'mr'

/** Every label `buildInvoiceHtml` prints. Adding a printed label means adding a key here. */
export interface InvoiceLabelKeys {
  taxInvoice: string
  billOfSupply: string
  proformaInvoice: string
  deliveryChallan: string
  billedTo: string
  invoiceNo: string
  date: string
  placeOfSupply: string
  description: string
  hsn: string
  qty: string
  rate: string
  discount: string
  gst: string
  amount: string
  taxableValue: string
  valueOfSupply: string
  cgst: string
  sgst: string
  igst: string
  cess: string
  roundOff: string
  total: string
  amountInWords: string
  declaration: string
  bankDetails: string
  terms: string
  receiversSignature: string
  authorisedSignatory: string
  /** The "For <company name>" standing above the signatory line. */
  for: string
  broughtForward: string
  carriedForward: string
  subtotal: string
  scanToPay: string
  vehicle: string
  gstin: string
  unregistered: string
  verificationQr: string
  hsnSummary: string
  barcode: string
  page: string
  /** As in "Page 1 of 3". */
  of: string
  cashSale: string
}

/**
 * Devanagari label packs.
 *
 * Vocabulary is the commercial/GST register, not literary Hindi or Marathi — a shopkeeper reading
 * "कर बीजक" knows what the document is, where a more scholarly coinage would send them back to
 * the English line. Tax acronyms stay as transliterations (जीएसटी, सीजीएसटी) because that is how
 * they are spoken and how the GST portal itself renders them; "translating" them would invent a
 * term nobody uses.
 *
 * Lines marked `VERIFY:` are the plainest correct word rather than a term confirmed as the one
 * trade actually prints. They are safe to put on paper — they are not wrong — but a native
 * bookkeeper should be asked before they are treated as settled.
 */
export const INVOICE_LABELS: Record<Exclude<InvoiceLanguage, 'none'>, InvoiceLabelKeys> = {
  hi: {
    taxInvoice: 'कर बीजक',
    billOfSupply: 'आपूर्ति बिल',
    proformaInvoice: 'प्रोफ़ॉर्मा बीजक',
    deliveryChallan: 'डिलीवरी चालान', // VERIFY: spoken loanword; some printers use "प्रदाय चालान".
    billedTo: 'बिल प्राप्तकर्ता',
    invoiceNo: 'बीजक संख्या',
    date: 'दिनांक',
    placeOfSupply: 'आपूर्ति का स्थान',
    description: 'विवरण',
    hsn: 'एचएसएन',
    qty: 'मात्रा',
    rate: 'दर',
    discount: 'छूट',
    gst: 'जीएसटी',
    amount: 'राशि',
    taxableValue: 'कर योग्य मूल्य',
    valueOfSupply: 'आपूर्ति का मूल्य',
    cgst: 'सीजीएसटी',
    sgst: 'एसजीएसटी',
    igst: 'आईजीएसटी',
    cess: 'उपकर',
    roundOff: 'पूर्णांकन', // VERIFY: mathematically correct; most trade invoices print "राउंड ऑफ".
    total: 'कुल',
    amountInWords: 'शब्दों में राशि',
    declaration: 'घोषणा',
    bankDetails: 'बैंक विवरण',
    terms: 'शर्तें',
    receiversSignature: 'प्राप्तकर्ता के हस्ताक्षर',
    authorisedSignatory: 'अधिकृत हस्ताक्षरकर्ता',
    for: 'कृते', // VERIFY: letterhead convention; the plainer alternative is "के लिए".
    broughtForward: 'आगे लाया गया', // VERIFY: the Hindi b/f–c/f pair is not standardised in ledgers.
    carriedForward: 'आगे ले जाया गया', // VERIFY: see broughtForward.
    subtotal: 'उप-योग',
    scanToPay: 'भुगतान हेतु स्कैन करें',
    vehicle: 'वाहन',
    gstin: 'जीएसटीआईएन',
    unregistered: 'अपंजीकृत',
    verificationQr: 'सत्यापन क्यूआर',
    hsnSummary: 'एचएसएन सारांश',
    barcode: 'बारकोड',
    page: 'पृष्ठ',
    of: 'में से', // VERIFY: reads naturally as "पृष्ठ 1 में से 3"; many prints just use "/".
    cashSale: 'नकद बिक्री'
  },
  mr: {
    taxInvoice: 'कर बीजक',
    billOfSupply: 'पुरवठा बिल',
    proformaInvoice: 'प्रोफॉर्मा बीजक',
    deliveryChallan: 'वितरण चलन', // VERIFY: "डिलिव्हरी चलन" is the spoken form.
    billedTo: 'बिल प्राप्तकर्ता',
    invoiceNo: 'बीजक क्रमांक',
    date: 'दिनांक',
    placeOfSupply: 'पुरवठ्याचे ठिकाण',
    description: 'तपशील',
    hsn: 'एचएसएन',
    qty: 'प्रमाण', // VERIFY: "नग" is used for countable pieces; "प्रमाण" is the neutral word.
    rate: 'दर',
    discount: 'सवलत',
    gst: 'जीएसटी',
    amount: 'रक्कम',
    taxableValue: 'करपात्र मूल्य',
    valueOfSupply: 'पुरवठ्याचे मूल्य',
    cgst: 'सीजीएसटी',
    sgst: 'एसजीएसटी',
    igst: 'आयजीएसटी',
    cess: 'उपकर',
    roundOff: 'पूर्णांकन', // VERIFY: see the Hindi note.
    total: 'एकूण',
    amountInWords: 'अक्षरी रक्कम',
    declaration: 'घोषणापत्र',
    bankDetails: 'बँक तपशील',
    terms: 'अटी',
    receiversSignature: 'प्राप्तकर्त्याची सही',
    authorisedSignatory: 'अधिकृत स्वाक्षरीकर्ता',
    for: 'करिता',
    broughtForward: 'मागील पानावरून आणलेले', // VERIFY: descriptive, not a fixed ledger term.
    carriedForward: 'पुढील पानावर नेलेले', // VERIFY: see broughtForward.
    subtotal: 'उप-एकूण',
    scanToPay: 'देयकासाठी स्कॅन करा',
    vehicle: 'वाहन',
    gstin: 'जीएसटीआयएन',
    unregistered: 'अनोंदणीकृत',
    verificationQr: 'पडताळणी क्यूआर',
    hsnSummary: 'एचएसएन सारांश',
    barcode: 'बारकोड',
    page: 'पान',
    of: 'पैकी',
    cashSale: 'रोख विक्री'
  }
}

/** The one separator. Changing it here changes every bilingual label on every printed document. */
const SEPARATOR = ' / '

/**
 * The English label, plus its translation when a second language is configured.
 *
 * `english` is passed in rather than looked up: the English strings live where they are printed,
 * and several are user-configurable (the invoice title, the signatory line). This function decides
 * only whether and how a translation is appended, so the print never mixes separator styles.
 */
export function bilingualLabel(
  key: keyof InvoiceLabelKeys,
  lang: InvoiceLanguage,
  english: string
): string {
  if (lang === 'none') return english
  const translated = INVOICE_LABELS[lang]?.[key]
  // A missing or empty translation falls back to English alone: an invoice short one word is
  // readable, an invoice ending in a dangling slash looks broken.
  if (!translated) return english
  return english + SEPARATOR + translated
}

/** Options for the settings dropdown, in the order they should be offered. */
export const INVOICE_LANGUAGES: { id: InvoiceLanguage; label: string }[] = [
  { id: 'none', label: 'English only' },
  { id: 'hi', label: 'Hindi (हिन्दी)' },
  { id: 'mr', label: 'Marathi (मराठी)' }
]
