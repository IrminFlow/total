// Plain-language glossary (WP 8.2): accounting term → the words simple mode uses, with a
// one-sentence explanation each, for the "Why?" popovers (kit/Why.tsx, Phase 10) and the
// "what does my accountant mean by …" help. Pure data + two helpers.
//
// Sources, merged (plan 2026-10-13, "Wording"):
//   audit = ~/.claude/total-orch/ux-audit.md "Jargon → plain-language proposals"
//   gpt   = the outside review (gpt-opinion.md §3 "Language")
// Where they differ the audit's shopkeeper wording wins in simple mode ("Money in" over "Money
// received"), and GPT's precision rules win everywhere: Total "prepares" a GST file, never
// "files" it; GST credit "awaits confirmation" until GSTR-2B shows it; Dr/Cr is never rendered
// as "money in / out" (wrong for most accounts) — it is hidden in everyday entry instead.
// Statutory names stay next to the explanation where the user will meet them ("GST on
// purchases you can claim (ITC)").
//
// `plain` and `explain` never use a word from the plan §1 banned list other than the entry's
// own term and aliases (glossary.test.ts). Hindi / Hinglish only where the word is natural.

import type { Language } from '../i18n'

export type GlossarySource = 'audit' | 'gpt'

export interface GlossaryEntry {
  /** The term as an accountant (or Tally) writes it. */
  term: string
  /** Other spellings that look up the same entry (case-insensitive). */
  aliases?: readonly string[]
  /** What simple mode says instead. */
  plain: string
  plainHi?: string
  plainHinglish?: string
  /** One sentence: what it is, in everyday words. */
  explain: string
  sources: readonly GlossarySource[]
}

export const GLOSSARY = {
  // ----- entries and screens -----
  voucher: {
    term: 'Voucher',
    aliases: ['Voucher entry', 'Vouchers'],
    plain: 'Entry',
    plainHi: 'एंट्री',
    plainHinglish: 'Entry',
    explain: 'One record of something that happened — a sale, a purchase, money in or money out.',
    sources: ['audit', 'gpt']
  },
  gateway: {
    term: 'Gateway',
    aliases: ['Dashboard', 'Gateway of Tally'],
    plain: 'Home',
    plainHi: 'होम',
    explain: 'The first screen: today’s money, who owes you, and what needs doing.',
    sources: ['audit', 'gpt']
  },
  masters: {
    term: 'Masters',
    plain: 'Customers, suppliers, products and accounts',
    explain: 'The lists you set up once and pick from every day.',
    sources: ['audit', 'gpt']
  },
  dayBook: {
    term: 'Day book',
    aliases: ['Daybook'],
    plain: 'All entries',
    explain: 'Everything recorded, day by day.',
    sources: ['audit']
  },
  sales: {
    term: 'Sales voucher',
    aliases: ['Sales invoice', 'Sale'],
    plain: 'Sale bill',
    plainHi: 'बिक्री',
    plainHinglish: 'Sale bill',
    explain: 'The bill you give a customer for what they bought.',
    sources: ['audit']
  },
  purchase: {
    term: 'Purchase voucher',
    aliases: ['Purchase invoice', 'Purchase'],
    plain: 'Purchase bill',
    plainHi: 'खरीद',
    plainHinglish: 'Kharid',
    explain: 'The bill a supplier gave you for what you bought.',
    sources: ['audit']
  },
  receipt: {
    term: 'Receipt',
    aliases: ['Receipt voucher'],
    plain: 'Money in',
    plainHi: 'पैसे आए',
    plainHinglish: 'Paise aaye',
    explain: 'Money that came to you — a customer paying, a loan, or the owner putting money in.',
    sources: ['audit']
  },
  payment: {
    term: 'Payment',
    aliases: ['Payment voucher'],
    plain: 'Money out',
    plainHi: 'पैसे गए',
    plainHinglish: 'Paise gaye',
    explain: 'Money you paid — to a supplier, for an expense, or taken out by the owner.',
    sources: ['audit']
  },
  contra: {
    term: 'Contra',
    aliases: ['Contra voucher'],
    plain: 'Move money',
    explain: 'Money moved between your own cash and bank accounts, like depositing cash in the bank.',
    sources: ['audit', 'gpt']
  },
  journal: {
    term: 'Journal',
    aliases: ['Journal voucher', 'Journal entry'],
    plain: 'Accounting adjustment',
    explain: 'A correction or transfer your accountant makes between accounts; everyday work never needs one.',
    sources: ['audit', 'gpt']
  },
  creditNote: {
    term: 'Credit note',
    plain: 'Sales return',
    explain: 'Reduces an earlier customer bill — goods came back or you gave a discount after billing.',
    sources: ['audit', 'gpt']
  },
  debitNote: {
    term: 'Debit note',
    plain: 'Purchase return',
    explain: 'Goods you sent back to a supplier, or an extra charge on an earlier bill — named by what it is for.',
    sources: ['audit', 'gpt']
  },
  optionalVoucher: {
    term: 'Optional voucher',
    aliases: ['Memorandum voucher'],
    plain: 'Draft — not counted',
    explain: 'An entry kept aside that does not count in your accounts until you make it real.',
    sources: ['audit', 'gpt']
  },
  stockJournal: {
    term: 'Stock journal',
    plain: 'Move or correct stock',
    explain: 'Moves products between places or corrects quantities without a sale or purchase.',
    sources: ['audit']
  },
  physicalStock: {
    term: 'Physical stock',
    aliases: ['Physical stock voucher'],
    plain: 'Stock count',
    explain: 'What you actually counted on the shelf, so Total can correct its quantity.',
    sources: ['audit']
  },

  // ----- accounts and parties -----
  ledger: {
    term: 'Ledger',
    aliases: ['Ledgers', 'Ledger account', 'Party ledger'],
    plain: 'Account',
    plainHi: 'खाता',
    plainHinglish: 'Khata',
    explain: 'The running list of everything for one customer, supplier, bank or kind of income or expense.',
    sources: ['audit', 'gpt']
  },
  party: {
    term: 'Party',
    plain: 'Customer or supplier',
    explain: 'Someone you sell to or buy from.',
    sources: ['gpt']
  },
  group: {
    term: 'Group',
    aliases: ['Under group', 'Account group', 'Groups'],
    plain: 'Kind of account',
    explain: 'Decides where an account shows in your statements; Total picks it from what the account is for.',
    sources: ['audit']
  },
  sundryDebtors: {
    term: 'Sundry Debtors',
    aliases: ['Debtors', 'Receivables'],
    plain: 'Customers who owe you',
    plainHi: 'लेना बाकी',
    plainHinglish: 'Lena baaki',
    explain: 'Customers who bought on credit and haven’t paid yet.',
    sources: ['audit', 'gpt']
  },
  sundryCreditors: {
    term: 'Sundry Creditors',
    aliases: ['Creditors', 'Payables'],
    plain: 'Suppliers you owe',
    plainHi: 'देना बाकी',
    plainHinglish: 'Dena baaki',
    explain: 'Suppliers whose bills you haven’t paid yet.',
    sources: ['audit', 'gpt']
  },
  directIndirect: {
    term: 'Direct / Indirect Expenses',
    aliases: ['Direct Expenses', 'Indirect Expenses'],
    plain: 'Cost of making or buying goods / Running costs',
    explain: 'Costs tied to the goods you sell, versus day-to-day costs like rent and electricity; Total decides from the expense type.',
    sources: ['audit']
  },
  salesLedger: {
    term: 'Sales ledger / Purchase ledger',
    aliases: ['Sales ledger', 'Purchase ledger', 'Sales account', 'Purchase account'],
    plain: 'Sales / Purchases',
    explain: 'The account your sales or purchases add up in; Total sets one up for you.',
    sources: ['audit']
  },
  capitalAccount: {
    term: 'Capital Account',
    plain: 'Owner’s money',
    explain: 'What the owner has put into the business, plus profits kept in it.',
    sources: ['audit']
  },
  drawings: {
    term: 'Drawings',
    plain: 'Owner took money out',
    explain: 'Money or goods the owner took from the business for personal use.',
    sources: ['audit']
  },
  openingBalance: {
    term: 'Opening balance',
    plain: 'What you had on your start date',
    explain: 'The amount already in an account, or already owed, on the day you start recording in Total.',
    sources: ['gpt']
  },
  drCr: {
    term: 'Dr / Cr',
    aliases: ['Dr', 'Cr', 'Debit / Credit', 'Debit', 'Credit'],
    plain: 'Side of the entry (set for you)',
    explain: 'Every entry touches two accounts on opposite sides; in everyday entry Total sets the sides, so you never pick them.',
    sources: ['audit', 'gpt']
  },
  particulars: {
    term: 'Particulars',
    plain: 'Account',
    explain: 'The account an entry line goes to.',
    sources: ['audit']
  },
  narration: {
    term: 'Narration',
    plain: 'Note',
    plainHi: 'टिप्पणी',
    explain: 'A short note to remember what the entry was for.',
    sources: ['audit', 'gpt']
  },

  // ----- bills and dues -----
  billWise: {
    term: 'Bill-wise allocation',
    aliases: ['Bill allocation', 'Agst Ref', 'Against reference'],
    plain: 'Which bills does this pay?',
    explain: 'Links a payment to the bills it settles, so you know exactly which ones are still unpaid.',
    sources: ['audit', 'gpt']
  },
  outstandings: {
    term: 'Outstandings',
    aliases: ['Outstanding', 'Receivables ageing'],
    plain: 'Unpaid bills / Who owes me',
    explain: 'Bills not yet paid, by you or to you, as on today.',
    sources: ['audit', 'gpt']
  },
  ageing: {
    term: 'Ageing',
    aliases: ['Aging', 'Ageing analysis'],
    plain: 'How long overdue',
    explain: 'How many days each unpaid bill has been waiting past its due date.',
    sources: ['audit', 'gpt']
  },
  soa: {
    term: 'SOA',
    aliases: ['Statement of account'],
    plain: 'Statement',
    explain: 'A list of a customer’s bills and payments with what they still owe.',
    sources: ['audit']
  },
  creditControl: {
    term: 'Credit control',
    plain: 'Payment reminders',
    explain: 'Following up customers who are late to pay, and stopping credit to those who are far behind.',
    sources: ['audit']
  },
  advanceReceipt: {
    term: 'Advance receipt',
    plain: 'Advance (no bill yet)',
    explain: 'Money a customer paid before you made their bill.',
    sources: ['audit']
  },
  taxableValue: {
    term: 'Taxable value',
    plain: 'Price before GST',
    explain: 'The amount GST is worked out on.',
    sources: ['audit']
  },
  roundOff: {
    term: 'Round off',
    plain: 'Rounding',
    explain: 'The few paise added or removed so the bill total is a whole rupee.',
    sources: ['audit']
  },

  // ----- stock -----
  stockItem: {
    term: 'Stock item',
    plain: 'Product',
    explain: 'Something you buy, make or sell and keep count of.',
    sources: ['audit']
  },
  godown: {
    term: 'Godown',
    aliases: ['Godowns'],
    plain: 'Location / Warehouse',
    plainHi: 'गोदाम',
    plainHinglish: 'Godaam',
    explain: 'A place where you keep stock — the shop, a store room or a warehouse.',
    sources: ['audit', 'gpt']
  },
  bom: {
    term: 'BOM',
    aliases: ['Bill of materials'],
    plain: 'Recipe / Materials needed',
    explain: 'What goes into making one unit of a product.',
    sources: ['gpt']
  },
  grn: {
    term: 'GRN',
    aliases: ['Goods receipt note', 'Receipt note'],
    plain: 'Goods received',
    explain: 'A note that goods arrived from a supplier, before or without their bill.',
    sources: ['gpt']
  },
  deliveryChallan: {
    term: 'Delivery challan',
    aliases: ['Delivery note', 'Challan'],
    plain: 'Goods sent',
    explain: 'A note that goods went to a customer, before or without a bill.',
    sources: ['audit']
  },
  closingStock: {
    term: 'Closing stock',
    plain: 'Stock left at the end',
    explain: 'The value of products still on hand at the end of the period; it is why profit is not simply sales minus purchases.',
    sources: ['audit']
  },
  grossProfit: {
    term: 'Gross profit',
    aliases: ['Gross profit c/o', 'Gross profit b/f'],
    plain: 'Profit on goods sold',
    explain: 'Sales minus what the goods you sold cost you, before running costs.',
    sources: ['audit']
  },

  // ----- statements -----
  profitAndLoss: {
    term: 'Profit & Loss',
    aliases: ['P&L', 'Profit and Loss'],
    plain: 'How is my business doing',
    explain: 'Sales minus the cost of goods sold minus expenses, for the period you pick.',
    sources: ['audit']
  },
  trialBalance: {
    term: 'Trial balance',
    plain: 'Trial balance (for your CA)',
    explain: 'Every account’s balance on one page — your CA uses it to check the books.',
    sources: ['audit']
  },
  balanceSheet: {
    term: 'Balance sheet',
    plain: 'Balance sheet (for your CA)',
    explain: 'What the business owns and owes on a date.',
    sources: ['audit']
  },
  cashFlow: {
    term: 'Cash flow',
    plain: 'Where the cash came from and went',
    explain: 'How cash and bank changed over a period, and why.',
    sources: ['audit']
  },
  brs: {
    term: 'BRS',
    aliases: ['Bank reconciliation', 'Bank reconciliation statement', 'Reconciliation'],
    plain: 'Match with bank statement',
    explain: 'Checks your entries against the bank’s statement so both show the same money.',
    sources: ['audit']
  },
  yearEndClose: {
    term: 'Year-end close',
    plain: 'Start the new financial year',
    explain: 'Carries balances into the new year; income and expenses start again from zero.',
    sources: ['audit']
  },
  costCentre: {
    term: 'Cost centre',
    aliases: ['Cost centres'],
    plain: 'Cost tracking (branch, project or person)',
    explain: 'A tag on costs and income so you can see them per branch, project or person.',
    sources: ['audit']
  },

  // ----- GST and other taxes -----
  gstin: {
    term: 'GSTIN',
    plain: 'GST number',
    explain: 'Your 15-character GST Identification Number; it starts with your state code.',
    sources: ['audit']
  },
  hsn: {
    term: 'HSN',
    aliases: ['HSN code', 'SAC'],
    plain: 'Product tax code (HSN)',
    explain: 'A code that tells GST what kind of product or service it is; Total helps you find it by name.',
    sources: ['audit']
  },
  itc: {
    term: 'ITC',
    aliases: ['Input tax credit', 'Input tax'],
    plain: 'GST on purchases you can claim',
    explain: 'GST you paid on business purchases that can reduce the GST you owe, once the supplier’s filing confirms it (GSTR-2B).',
    sources: ['audit', 'gpt']
  },
  outputTax: {
    term: 'Output tax',
    aliases: ['Output GST'],
    plain: 'GST you collected',
    explain: 'The GST you charged customers on your bills, which you pay to the government.',
    sources: ['audit']
  },
  setOff: {
    term: 'Set-off',
    aliases: ['Set off', 'ITC set-off'],
    plain: 'GST to pay after your purchase credit',
    explain: 'GST you collected, reduced by the purchase GST you can claim; what remains is paid in cash.',
    sources: ['audit']
  },
  rcm: {
    term: 'RCM',
    aliases: ['Reverse charge', 'Reverse charge mechanism'],
    plain: 'GST you must pay for this purchase',
    explain: 'For some purchases the buyer, not the supplier, pays the GST to the government.',
    sources: ['gpt']
  },
  gstr1: {
    term: 'GSTR-1',
    plain: 'Your sales for GST',
    explain: 'The GST return listing your sales; Total prepares the file and you upload it on gst.gov.in.',
    sources: ['audit', 'gpt']
  },
  gstr3b: {
    term: 'GSTR-3B',
    plain: 'GST summary and payment',
    explain: 'The monthly or quarterly GST summary where you pay what you owe; Total prepares it, you file it.',
    sources: ['audit', 'gpt']
  },
  gstr2b: {
    term: 'GSTR-2B',
    aliases: ['GSTR-2B recon', '2B'],
    plain: 'Check supplier bills against the GST portal',
    explain: 'The portal’s list of bills your suppliers reported; purchase GST not in it awaits confirmation.',
    sources: ['audit', 'gpt']
  },
  composition: {
    term: 'Composition scheme',
    aliases: ['Composition'],
    plain: 'Composition scheme (simpler GST)',
    explain: 'A simpler GST option for small businesses: you pay a fixed rate on turnover and issue a bill of supply, not a tax invoice.',
    sources: ['gpt']
  },
  eInvoice: {
    term: 'e-Invoice',
    aliases: ['IRN', 'E-invoice'],
    plain: 'e-Invoice (registered with the GST system)',
    explain: 'A bill registered on the government portal; needed only once your turnover crosses the GST limit.',
    sources: ['audit']
  },
  eWayBill: {
    term: 'e-Way bill',
    aliases: ['E-way bill', 'EWB'],
    plain: 'e-Way bill (for moving goods)',
    explain: 'A permit from the GST portal for moving goods above a value limit.',
    sources: ['audit']
  },
  tds: {
    term: 'TDS',
    aliases: ['Tax deducted at source'],
    plain: 'Tax you deduct when paying (TDS)',
    explain: 'Income tax you cut from certain payments, like rent or contractor bills above the limits, and deposit for the payee.',
    sources: ['audit']
  },
  tcs: {
    term: 'TCS',
    aliases: ['Tax collected at source'],
    plain: 'Tax you collect when selling (TCS)',
    explain: 'Tax you add to certain sales and deposit for the buyer.',
    sources: ['audit']
  }
} as const satisfies Record<string, GlossaryEntry>

export type GlossaryTerm = keyof typeof GLOSSARY

const ENTRIES = GLOSSARY as Record<GlossaryTerm, GlossaryEntry>
const byName = new Map<string, GlossaryTerm>()
for (const [id, entry] of Object.entries(ENTRIES) as [GlossaryTerm, GlossaryEntry][]) {
  for (const name of [id, entry.term, ...(entry.aliases ?? [])]) byName.set(name.trim().toLowerCase(), id)
}

/** The entry for an id, a term or an alias (case-insensitive), or null. */
export function glossaryEntry(term: GlossaryTerm | string): GlossaryEntry | null {
  const id = byName.get(term.trim().toLowerCase())
  return id ? ENTRIES[id] : null
}

/** The plain word for a term in `lang` (falls back to English; an unknown term is returned
 *  unchanged so a caller never shows an empty label). */
export function plain(term: GlossaryTerm | string, lang: Language = 'en'): string {
  const e = glossaryEntry(term)
  if (!e) return term
  if (lang === 'hi' && e.plainHi) return e.plainHi
  if (lang === 'hinglish' && e.plainHinglish) return e.plainHinglish
  return e.plain
}

/** The one-sentence explanation (English until Phase 10), or null for an unknown term. */
export function explain(term: GlossaryTerm | string): string | null {
  return glossaryEntry(term)?.explain ?? null
}
