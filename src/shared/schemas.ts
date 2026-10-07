import { z } from 'zod'
import { GST_STATES } from './gst/states'
import { validateGstin } from './gst/validate'
import { isUqc } from './gst/uqc'
import { PT_STATES } from './payroll'
import { TRADE_DOC_KINDS, TRADE_PURPOSES, VOUCHER_KINDS } from './domain'
import { MSME_CATEGORIES, normalizeUdyam, UDYAM_RE } from './payables/msme'

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const stateCodeSchema = z.string().refine((s) => s in GST_STATES, 'Unknown GST state code')

export const gstinSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => validateGstin(s).valid, 'Invalid GSTIN')

const paise = z.number().int().safe()
const positivePaise = paise.positive()
const id = z.number().int().positive()

/** Optional identifier field: uppercases, treats an empty/blank string as absent (null), and
 *  regex-validates whatever's left. Used for PAN/TAN, which are optional on a company. */
const optionalIdSchema = (regex: RegExp, message: string) =>
  z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .nullable()
    .optional()
    .default(null)
    .transform((s) => (s === '' ? null : s))
    .refine((s) => s === null || regex.test(s), message)

export const panSchema = optionalIdSchema(/^[A-Z]{5}\d{4}[A-Z]$/, 'Invalid PAN')
export const tanSchema = optionalIdSchema(/^[A-Z]{4}\d{5}[A-Z]$/, 'Invalid TAN')

export const companyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  stateCode: stateCodeSchema,
  gstin: gstinSchema.nullable(),
  gstRegistrationType: z.enum(['regular', 'composition', 'unregistered']),
  address: z.string().trim().max(500).default(''),
  booksFrom: z.number().int().min(1990).max(2100),
  email: z.string().trim().email().nullable(),
  phone: z.string().trim().max(20).nullable(),
  pan: panSchema,
  tan: tanSchema
})
export type CompanyCreateInput = z.infer<typeof companyCreateSchema>

export const groupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: id
})
export type GroupInput = z.infer<typeof groupInputSchema>

/** WP 4.3: Udyam Registration Number (see src/shared/payables/msme.ts for the format's source). */
export const udyamSchema = z
  .string()
  .transform((s) => normalizeUdyam(s))
  .refine((s) => s === '' || UDYAM_RE.test(s), 'Udyam number is UDYAM-XX-00-0000000 (state, district, 7 digits)')
  .transform((s) => (s === '' ? null : s))

/** WP 4.3 (migration 034): a supplier's MSME facts and payment terms on its ledger. */
export const supplierTermsFields = {
  msmeRegistered: z.boolean().optional(),
  udyamNo: udyamSchema.nullable().optional(),
  msmeCategory: z.enum(MSME_CATEGORIES).nullable().optional(),
  /** Credit period agreed in writing (MSMED Act s.15); null = no written agreement. */
  agreedCreditDays: z.number().int().min(0).max(365).nullable().optional(),
  earlyPaymentDiscountBp: z.number().int().min(0).max(10000).nullable().optional(),
  earlyPaymentDiscountDays: z.number().int().min(0).max(365).nullable().optional()
}

export const ledgerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  groupId: id,
  openingBalance: paise.default(0),
  gstin: gstinSchema.nullable().default(null),
  stateCode: stateCodeSchema.nullable().default(null),
  address: z.string().trim().max(500).nullable().default(null),
  taxType: z.enum(['cgst', 'sgst', 'igst', 'cess']).nullable().default(null),
  gstRate: z.number().min(0).max(100).nullable().default(null),
  hsn: z.string().trim().nullable().default(null),
  tdsSectionId: id.nullable().default(null),
  pan: panSchema,
  /** TDS deductee class; absent = keep the stored value (older callers never send it). */
  deducteeType: z.enum(['individual_huf', 'company', 'firm', 'other']).nullable().optional(),
  /** Tags the ledger as a section's TDS payable ledger; absent = keep the stored value. */
  tdsPayableSectionId: id.nullable().optional(),
  /** Expense ledgers: default TDS section for debits to this ledger; absent = keep. */
  tdsDefaultSectionId: id.nullable().optional(),
  /** TCS (WP 3.3) — absent = keep the stored value: the buyer's collection section, the TCS
   *  payable tag, and a sales ledger's default section. */
  tcsSectionId: id.nullable().optional(),
  tcsPayableSectionId: id.nullable().optional(),
  tcsDefaultSectionId: id.nullable().optional(),
  creditDays: z.number().int().min(0).max(365).nullable().default(null),
  exportType: z.enum(['sez_wp', 'sez_wop', 'exp_wp', 'exp_wop']).nullable().default(null),
  /** Reverse charge applies to this party's supplies (GSTR-1 rchrg / GSTR-3B 3.1(d)). */
  rcm: z.boolean().default(false),
  /** ITC eligibility class for purchases from this party — 'blocked' lands in 3B 4(D). */
  itcEligibility: z.enum(['eligible', 'blocked', 'capital_goods', 'input_services']).default('eligible'),
  /** Price level whose rates prefill this party's invoice lines; absent/null = item base rate. */
  priceLevelId: id.nullable().optional(),
  /** Credit limit in paise; absent/null = no limit. */
  creditLimit: paise.min(0).nullable().optional(),
  // WP 4.3 (migration 034): supplier MSME facts and payment terms — absent = keep the stored value.
  ...supplierTermsFields
})
/** Unparsed shape (defaults optional) — createLedger/updateLedger parse internally, so direct
 *  service callers (tests, importers) don't have to spell out every defaulted field. */
export type LedgerInput = z.input<typeof ledgerInputSchema>
export type LedgerInputParsed = z.infer<typeof ledgerInputSchema>

export const unitInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  symbol: z.string().trim().min(1).max(12),
  decimals: z.number().int().min(0).max(3),
  // Must be a real portal UQC — anything else is rejected by the GSTR-1/EWB upload tools
  // (full CBIC enum + alias mapper in src/shared/gst/uqc.ts).
  uqc: z
    .string()
    .trim()
    .min(2)
    .max(8)
    .transform((s) => s.toUpperCase())
    .refine((s) => isUqc(s), 'Not a valid GST portal UQC code')
})
export type UnitInput = z.infer<typeof unitInputSchema>

export const stockGroupInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: id.nullable().default(null)
})
export type StockGroupInput = z.infer<typeof stockGroupInputSchema>

export const stockItemInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  groupId: id.nullable().default(null),
  unitId: id,
  hsn: z.string().trim().nullable().default(null),
  gstRate: z.number().min(0).max(100).nullable().default(null),
  cessRate: z.number().min(0).max(300).nullable().default(null),
  openingQtyMilli: z.number().int().min(0).default(0),
  openingValue: paise.min(0).default(0),
  barcode: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .default(null)
    .transform((s) => (s === '' ? null : s)),
  /** Reorder level in integer thousandths; null = no reorder alert (v0.3 #58). */
  reorderLevelMilli: z.number().int().min(0).nullable().default(null),
  /** Absent = keep existing (update) / 'weighted_avg' (create). Applies from the next
   *  valuation — every report re-walks the movements with the item's current method. */
  valuationMethod: z.enum(['weighted_avg', 'fifo']).optional(),
  /** Serial-number tracking (WP 2.3). Absent = keep existing (update) / off (create). */
  trackSerials: z.boolean().optional(),
  /** TCS goods category (WP 3.3). Absent = keep existing (update) / none (create). */
  tcsSectionId: id.nullable().optional(),
  /** WP 2.6: printed MRP (GST-inclusive) and standard cost, paise per unit. Absent = keep
   *  existing (update) / none (create). */
  mrpPaise: paise.min(0).nullable().optional(),
  standardCostPaise: paise.min(0).nullable().optional()
})
export type StockItemInput = z.infer<typeof stockItemInputSchema>

export const godownInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).nullable().optional(),
  /** WP 2.4: 'job_worker' = a third party's premises holding our material (needs a party
   *  ledger). Absent = keep existing (update) / 'own' (create). */
  kind: z.enum(['own', 'job_worker']).optional(),
  partyLedgerId: id.nullable().optional()
})
export type GodownInput = z.infer<typeof godownInputSchema>

export const costAllocationSchema = z.object({
  costCentreId: id,
  amount: positivePaise
})

export const voucherLineSchema = z.object({
  ledgerId: id,
  drCr: z.enum(['dr', 'cr']),
  amount: positivePaise,
  costAllocations: z.array(costAllocationSchema).max(20).default([])
})

export const billRefSchema = z.object({
  kind: z.enum(['new', 'against']),
  name: z.string().trim().min(1).max(80),
  amount: positivePaise,
  dueDate: isoDate.nullable().default(null)
})

export const tdsSchema = z.object({
  sectionId: id,
  baseAmount: positivePaise,
  tdsAmount: positivePaise,
  /** The deduction was typed rather than computed from the rate table (saveVoucher then skips
   *  the amount = rate x base check, but still requires a TDS payable credit). */
  isManual: z.boolean().default(false),
  /** The voucher's lines do NOT include the TDS payable credit: saveVoucher finds (or creates,
   *  inside the save transaction) the ledger tagged for the section and appends a Cr line of
   *  tdsAmount. Lets entry screens apply TDS before the payable ledger exists. */
  autoPayable: z.boolean().default(false)
})

/** TCS collected on a sale / receipt (WP 3.3) — the TCS twin of tdsSchema. */
export const tcsSchema = z.object({
  sectionId: id,
  baseAmount: positivePaise,
  tcsAmount: positivePaise,
  /** Typed rather than the rate table's figure (saveVoucher skips the rate x base check). */
  isManual: z.boolean().default(false),
  /** The lines do NOT include the TCS payable credit: saveVoucher finds (or creates, inside the
   *  save transaction) the section's tagged TCS payable ledger and appends a Cr of tcsAmount. */
  autoPayable: z.boolean().default(false)
})

/** A stable line uid: 32 lowercase hex chars (migration 024 backfill / crypto.randomUUID sans hyphens). */
export const lineUidSchema = z.string().regex(/^[0-9a-f]{32}$/, 'Expected a 32-hex line uid')
export const lineSourceSchema = z.object({ lineUid: lineUidSchema, linkType: z.enum(['fulfil', 'return']) })

export const inventoryLineSchema = z
  .object({
    stockItemId: id,
    godownId: id.nullable().default(null),
    /** Batch this quantity moves in/out of (F11 `batches`); null = untracked. */
    batchId: id.nullable().optional(),
    qtyMilli: z.number().int().min(0),
    ratePaise: paise.min(0),
    /** Per-line trade discount (lane Q #97): display + gross math only — `amount` is already the
     *  post-discount taxable value, so GST is unaffected by construction. Optional (treated as 0)
     *  so existing callers that never heard of discounts keep compiling and working. */
    discountPaise: paise.min(0).optional(),
    amount: paise.min(0),
    direction: z.enum(['in', 'out']),
    /** Physical Stock line: qtyMilli is the counted closing quantity, not a movement. */
    isAbsolute: z.boolean().optional(),
    /** Serial numbers moved by this line (WP 2.3) — one per unit for serial-tracked items
     *  (src/shared/serials.ts); dropped for items that don't track serials. */
    serials: z.array(z.string().trim().min(1).max(60)).max(5000).optional(),
    /** Stable line identity (WP 2.5): kept only when it belonged to this voucher's saved lines —
     *  saveVoucher assigns a fresh one otherwise. Absent = a new line. */
    lineUid: lineUidSchema.optional(),
    /** The line this one fulfils / returns (WP 2.5 line_links); null/absent = none. */
    source: lineSourceSchema.nullable().optional()
  })
  .refine((l) => l.isAbsolute || l.qtyMilli > 0, {
    message: 'Inventory quantity must be positive',
    path: ['qtyMilli']
  })

export const voucherInputSchema = z.object({
  voucherTypeId: id,
  date: isoDate,
  number: z.string().trim().max(40).optional(),
  partyLedgerId: id.nullable().default(null),
  narration: z.string().trim().max(1000).nullable().default(null),
  reference: z.string().trim().max(120).nullable().default(null),
  instrumentNo: z.string().trim().max(60).nullable().default(null),
  instrumentDate: isoDate.nullable().default(null),
  transporterId: z.string().trim().max(20).nullable().default(null),
  vehicleNo: z.string().trim().max(20).nullable().default(null),
  transportDistanceKm: z.number().int().min(0).max(10000).nullable().default(null),
  /** Place-of-supply override (two-digit state code) for GST returns; null = party/company state. */
  posOverride: stateCodeSchema.nullable().default(null),
  currencyCode: z.string().trim().length(3).transform((s) => s.toUpperCase()).nullable().default(null),
  exchangeRate: z.number().positive().max(100000).nullable().default(null),
  /** Post-dated: kept out of the books until the date arrives (auto-matures on company open). */
  postDated: z.boolean().optional(),
  /** Optional (memorandum) voucher: never counts toward the books. */
  isOptional: z.boolean().optional(),
  lines: z.array(voucherLineSchema).max(200),
  inventory: z.array(inventoryLineSchema).max(200).default([]),
  billRefs: z.array(billRefSchema).max(50).default([]),
  tds: tdsSchema.nullable().default(null),
  /** TCS collected (WP 3.3). Absent = none (never "keep": every editor posts it back). */
  tcs: tcsSchema.nullable().optional(),
  /** Delivery challan / GRN facts (WP 2.5); only stored for those kinds. */
  trade: z.object({ purpose: z.enum(TRADE_PURPOSES) }).nullable().optional()
})
export type VoucherInputParsed = z.infer<typeof voucherInputSchema>
/** Unparsed shape (defaults optional) — saveVoucher parses internally. */
export type VoucherInput = z.input<typeof voucherInputSchema>

export const voucherTypeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(VOUCHER_KINDS),
  numbering: z.enum(['auto', 'manual']).default('auto'),
  prefix: z.string().trim().max(20).default(''),
  suffix: z.string().trim().max(20).default(''),
  padWidth: z.number().int().min(0).max(8).default(0),
  restartFy: z.boolean().default(true)
})
export type VoucherTypeInput = z.infer<typeof voucherTypeInputSchema>

// ---------- trade cycle (WP 2.5a: links, kinds, numbering series) ----------

export const tradeDocKindSchema = z.enum(TRADE_DOC_KINDS)

/** A quotation / order numbering series (trade_doc_types) — the voucher-type knobs. */
export const tradeDocTypeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: tradeDocKindSchema,
  numbering: z.enum(['auto', 'manual']).default('auto'),
  prefix: z.string().trim().max(20).default(''),
  suffix: z.string().trim().max(20).default(''),
  padWidth: z.number().int().min(0).max(8).default(0),
  restartFy: z.boolean().default(true)
})
export type TradeDocTypeInput = z.infer<typeof tradeDocTypeInputSchema>

export const tradeDocTypeSaveSchema = z.object({ id: id.optional(), data: tradeDocTypeInputSchema })

export const tradeDocNextNumberSchema = z.object({ docTypeId: id, date: isoDate })

export const linksForVoucherSchema = z.object({ voucherId: id })

/** Open source lines a party could draw on for a target kind (the 2.5b "Add from…" drawer). */
export const openSourceLinesSchema = z.object({
  partyLedgerId: id,
  targetKind: z.union([z.enum(VOUCHER_KINDS), tradeDocKindSchema]),
  linkType: z.enum(['fulfil', 'return']).default('fulfil'),
  /** The voucher being altered: its own links don't count against capacity. */
  excludeVoucherId: id.optional(),
  /** The order being altered (WP 2.5c): its own links don't count against capacity. */
  excludeTradeDocId: id.optional()
})
export type OpenSourceLinesQuery = z.infer<typeof openSourceLinesSchema>

/** trade:pending (WP 2.5b) — challans not invoiced / GRNs not billed, as on a date. */
export const tradePendingSchema = z.object({
  stage: z.enum(['delivery_note', 'receipt_note']),
  asOn: isoDate
})
export type TradePendingQuery = z.infer<typeof tradePendingSchema>

// ---------- reports, returns, closure (WP 2.5d) ----------

/** trade:chain — the linked documents around one voucher or one trade doc (exactly one id). */
export const tradeChainSchema = z
  .object({ voucherId: id.optional(), tradeDocId: id.optional() })
  .refine((q) => (q.voucherId == null) !== (q.tradeDocId == null), 'Give a voucherId or a tradeDocId')
export type TradeChainQuery = z.infer<typeof tradeChainSchema>

const bp = z.number().int().min(0).max(10_000)
const orderKindSchema = z.enum(['sales_order', 'purchase_order'])
const returnSideSchema = z.enum(['sales', 'purchase'])

/** trade:threeWayMatch — tolerances: rate as basis points of the expected amount AND a flat
 *  amount (both must be exceeded), quantity as basis points of the received quantity. */
export const threeWayMatchSchema = z.object({
  from: isoDate,
  to: isoDate,
  rateTolBp: bp.default(0),
  amountTolPaise: z.number().int().min(0).max(100_000_000).default(100),
  qtyTolBp: bp.default(0),
  flagGrnWithoutPo: z.boolean().default(true),
  flagUnmatchedBills: z.boolean().default(false)
})
export type ThreeWayMatchQuery = z.input<typeof threeWayMatchSchema>

export const itemDemandSchema = z.object({ asOn: isoDate, onlyOpen: z.boolean().default(true) })
export const orderBookSchema = z.object({ kind: orderKindSchema, from: isoDate, to: isoDate })
export const leadTimeSchema = z.object({ kind: orderKindSchema, from: isoDate, to: isoDate, asOn: isoDate })
export const returnsRegisterSchema = z.object({ side: returnSideSchema, from: isoDate, to: isoDate })
export const returnsRateSchema = z.object({ side: returnSideSchema, from: isoDate, to: isoDate, by: z.enum(['item', 'party']) })
export const asOnSchema = z.object({ asOn: isoDate })
export const staleDocumentsSchema = z.object({
  asOn: isoDate,
  orderAgeDays: z.number().int().min(0).max(3650).default(30),
  noteAgeDays: z.number().int().min(0).max(3650).default(30)
})
/** trade:closeVoucher / trade:reopenVoucher — a challan / GRN's doc-level close. */
export const noteActionSchema = z.object({ voucherId: id, reason: z.string().trim().max(300).nullable().default(null) })
export const noteClosureSchema = z.object({ voucherId: id })
/** trade:closeStaleQuotations — all stale quotations as on a date, or only `ids` among them. */
export const closeStaleQuotationsSchema = z.object({
  asOn: isoDate,
  ids: z.array(id).max(1000).optional(),
  reason: z.string().trim().max(300).nullable().default(null)
})

// ---------- quotations / sales orders / purchase orders (WP 2.5c, design §6.2) ----------

/** One quotation / order line. `amount` is the taxable value after discount: the server checks
 *  amount = round(qty × rate) − discount (the invoice rule). GST rates are snapshotted server-side. */
export const tradeDocLineSchema = z.object({
  lineUid: lineUidSchema.optional(),
  stockItemId: id,
  description: z.string().trim().max(500).nullable().default(null),
  godownId: id.nullable().default(null),
  qtyMilli: z.number().int().positive(),
  ratePaise: paise.min(0),
  discountPaise: paise.min(0).default(0),
  amount: paise.min(0),
  dueDate: isoDate.nullable().default(null),
  /** The quotation line this order line converts (doc → doc link, rules.ts). */
  source: lineSourceSchema.nullable().default(null)
})
export type TradeDocLineInput = z.input<typeof tradeDocLineSchema>

export const tradeDocInputSchema = z.object({
  docTypeId: id,
  date: isoDate,
  /** Absent / blank = next auto number of the series. */
  number: z.string().trim().max(40).optional(),
  partyLedgerId: id,
  /** Quotations only: valid until (inclusive). */
  validUntil: isoDate.nullable().default(null),
  /** Orders: expected delivery / receipt date. */
  dueDate: isoDate.nullable().default(null),
  reference: z.string().trim().max(120).nullable().default(null),
  terms: z.string().trim().max(4000).nullable().default(null),
  narration: z.string().trim().max(1000).nullable().default(null),
  posOverride: stateCodeSchema.nullable().default(null),
  currencyCode: z.string().trim().length(3).transform((s) => s.toUpperCase()).nullable().default(null),
  exchangeRate: z.number().positive().max(100000).nullable().default(null),
  lines: z.array(tradeDocLineSchema).min(1, 'Add at least one item line').max(200)
})
export type TradeDocInputParsed = z.infer<typeof tradeDocInputSchema>
export type TradeDocInput = z.input<typeof tradeDocInputSchema>

export const tradeDocSaveSchema = z.object({ data: tradeDocInputSchema, id: id.optional() })

export const tradeDocListSchema = z.object({
  kind: tradeDocKindSchema,
  from: isoDate,
  to: isoDate,
  /** Include binned documents (the list's "In the bin" view). */
  includeBinned: z.boolean().default(false)
})
export type TradeDocListQuery = z.input<typeof tradeDocListSchema>

/** close / cancel / reopen / delete / restore. */
export const tradeDocActionSchema = z.object({ id, reason: z.string().trim().max(300).nullable().default(null) })

/** convert (quotation → sales order) / duplicate: a draft for the entry form, never saved. */
export const tradeDocConvertSchema = z.object({ id, to: tradeDocKindSchema })

/** trade:pendingOrders — open sales / purchase order lines as on a date. */
export const pendingOrdersSchema = z.object({ kind: z.enum(['sales_order', 'purchase_order']), asOn: isoDate })

/** trade:quotationPipeline — quotations dated in a period, their outcome as on `asOn`. */
export const quotationPipelineSchema = z.object({ from: isoDate, to: isoDate, asOn: isoDate })

/** trade:openSalesOrderValue — a party's open sales order value (credit-limit figure). */
export const openOrderValueSchema = z.object({ partyLedgerId: id })

export const periodSchema = z.object({ from: isoDate, to: isoDate })
export type Period = z.infer<typeof periodSchema>

export const consolidatedRunSchema = z.object({
  slugs: z.array(z.string().trim().min(1)).min(1).max(20),
  kind: z.enum(['tb', 'pnl']),
  from: isoDate,
  to: isoDate
})
export type ConsolidatedRunInput = z.infer<typeof consolidatedRunSchema>

export const gstr2bSchema = z.object({ jsonText: z.string().min(2), from: isoDate, to: isoDate })
export type Gstr2bInput = z.infer<typeof gstr2bSchema>

export const currencyInputSchema = z.object({
  code: z.string().trim().length(3).transform((s) => s.toUpperCase()),
  symbol: z.string().trim().min(1).max(4),
  name: z.string().trim().min(1).max(60),
  decimals: z.number().int().min(0).max(4).default(2)
})
export type CurrencyInput = z.infer<typeof currencyInputSchema>

export const employeeInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z.string().trim().max(30).nullable().default(null),
  designation: z.string().trim().max(80).nullable().default(null),
  joined: isoDate.nullable().default(null),
  pan: z.string().trim().max(10).transform((s) => s.toUpperCase()).nullable().default(null),
  uan: z.string().trim().max(20).nullable().default(null),
  esicNo: z.string().trim().max(20).nullable().default(null),
  basic: z.number().int().min(0),
  hra: z.number().int().min(0).default(0),
  special: z.number().int().min(0).default(0),
  pfEnabled: z.boolean().default(true),
  esiEnabled: z.boolean().default(true),
  ptEnabled: z.boolean().default(true),
  ptState: z.enum(PT_STATES).default('MH'),
  active: z.boolean().default(true),
  // WP 3.7 statutory profile
  pfNumber: z.string().trim().max(30).nullable().default(null),
  gender: z.enum(['male', 'female', 'other']).nullable().default(null),
  dob: isoDate.nullable().default(null),
  taxRegime: z.enum(['new', 'old']).default('new'),
  vpfRateBp: z.number().int().min(0).max(8800).default(0),
  pfOnFullWage: z.boolean().default(false),
  epsEligible: z.boolean().default(true),
  disabled: z.boolean().default(false),
  metro: z.boolean().default(false),
  tdsEnabled: z.boolean().default(true)
})
export type EmployeeInput = z.infer<typeof employeeInputSchema>
/** What the renderer actually sends (defaulted fields optional) — keeps older forms compiling. */
export type EmployeeInputPayload = z.input<typeof employeeInputSchema>

export const bomLineInputSchema = z.object({
  componentId: z.number().int().positive(),
  qtyMilliPerUnit: z.number().int().positive()
})
export const bomInputSchema = z.object({
  itemId: z.number().int().positive(),
  lines: z.array(bomLineInputSchema).max(100)
})
export type BomInput = z.infer<typeof bomInputSchema>

/** WP 2.4: one BOM version (create without id, replace with id). */
export const bomVersionInputSchema = z.object({
  id: id.optional(),
  itemId: id,
  name: z.string().trim().min(1).max(60),
  effectiveFrom: isoDate.nullable().optional(),
  effectiveTo: isoDate.nullable().optional(),
  isDefault: z.boolean().default(false),
  lines: z
    .array(
      z.object({
        componentId: id,
        qtyMilliPerUnit: z.number().int().positive().max(1e12),
        scrapPctBp: z.number().int().min(0).max(100_000).nullable().optional()
      })
    )
    .max(200)
})
export type BomVersionInput = z.infer<typeof bomVersionInputSchema>

/** WP 2.4: bom:explode — expand a quantity of an item through its BOM as of a date. */
export const bomExplodeSchema = z.object({
  itemId: id,
  qtyMilli: z.number().int().nonnegative().max(1e12),
  date: isoDate,
  versionId: id.nullable().optional(),
  levels: z.enum(['single', 'full']).default('single')
})
export type BomExplodeInput = z.infer<typeof bomExplodeSchema>

/** NIC live-filing credentials, per company: non-secret fields in the meta table, password and
 *  clientSecret in the encrypted secret store (src/main/services/nic.ts). */
export const nicCredentialsSchema = z.object({
  mode: z.enum(['einvoice', 'ewb']).optional(),
  baseUrlEinvoice: z.string().trim().url().or(z.literal('')).default(''),
  baseUrlEwb: z.string().trim().url().or(z.literal('')).default(''),
  username: z.string().trim().default(''),
  password: z.string().default(''),
  clientId: z.string().trim().default(''),
  clientSecret: z.string().trim().default(''),
  /** NIC RSA public key PEM used to encrypt password/app key during auth. */
  publicKeyPem: z.string().trim().default('')
})
export type NicCredentials = z.infer<typeof nicCredentialsSchema>

/** Backup filename as offered back by backup:list — no path traversal. */
export const backupFileSchema = z.string().regex(/^[A-Za-z0-9._-]+\.db$/, 'Invalid backup filename')

/** Passphrase for encrypted export/import. */
export const passphraseSchema = z.string().min(8, 'Passphrase must be at least 8 characters')

/** audit:list query — every filter optional; page is server-paged (default 100 rows). */
export const auditListSchema = z.object({
  entity: z.string().trim().min(1).optional(),
  action: z.string().trim().min(1).optional(),
  user: z.string().trim().min(1).optional(),
  voucherId: z.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.number().int().min(0).default(0),
  /** Rows per page; server defaults to AUDIT_PAGE_SIZE (100) when absent. */
  pageSize: z.number().int().min(10).max(500).optional()
})
export type AuditListInput = z.infer<typeof auditListSchema>

/** audit:exportCsv / audit:exportPdf — the same filters, no paging (the whole period). */
export const auditExportSchema = auditListSchema.omit({ page: true, pageSize: true })
export type AuditExportInput = z.infer<typeof auditExportSchema>

// ---------- lane Q: audit retention + batch invoice PDF ----------

/** config:audit:set — days of audit history to keep (at least 8 years, MIN_AUDIT_KEEP_DAYS in
 *  src/shared/auditRetention.ts), or null = keep forever (the default). */
export const auditRetentionSchema = z.object({
  keepDays: z.number().int().min(2922).max(36600).nullable()
})
/** config:audit:required — the company's "audit trail required" flag (default on). */
export const auditTrailRequiredSchema = z.object({ required: z.boolean() })
export type AuditRetentionInput = z.infer<typeof auditRetentionSchema>

/** invoice:pdfBatch — render several sales invoices into one exports folder, sequentially. */
export const invoicePdfBatchSchema = z.object({
  voucherIds: z.array(id).min(1).max(500)
})
export type InvoicePdfBatchInput = z.infer<typeof invoicePdfBatchSchema>

/** search:global input — ⌘K global search query (min 1 so an empty string is rejected outright;
 *  the palette itself gates the IPC call to 2+ chars). */
export const searchGlobalSchema = z.object({
  q: z.string().trim().min(1).max(80)
})
export type SearchGlobalInput = z.infer<typeof searchGlobalSchema>

/** search:query input — the books-search query language (src/shared/searchQuery.ts). `today` /
 *  `fyStartYear` anchor relative dates (`date:apr`, `date:today`) to the renderer's working
 *  period; `kind` + `offset` page one result kind (results screen "Load more"). */
export const searchQuerySchema = z.object({
  q: z.string().max(500),
  today: isoDate.optional(),
  fyStartYear: z.number().int().min(1900).max(9998).optional(),
  kind: z.enum(['ledger', 'item', 'voucher']).optional(),
  limitPerKind: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).max(1_000_000).optional()
})
export type SearchQueryInput = z.infer<typeof searchQuerySchema>

/** users:save input — pin is digits-only, 4-12 long; required on create, optional on update
 *  (an update without a pin keeps the existing hash). Role requests are honored except for the
 *  very first user of a company, which the service always forces to 'owner'. */
export const userInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(['owner', 'accountant', 'viewer']),
  pin: z.string().regex(/^\d{4,12}$/, 'PIN must be 4-12 digits').optional(),
  active: z.boolean().default(true)
})
export type UserInput = z.infer<typeof userInputSchema>

/** auth:login input. */
export const authLoginSchema = z.object({
  userId: id,
  pin: z.string().min(1).max(20)
})
export type AuthLoginInput = z.infer<typeof authLoginSchema>

/** Renderer-side crash report sent to the main process for logging. */
export const rendererLogSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  screen: z.string().optional()
})
export type RendererLogInput = z.infer<typeof rendererLogSchema>

// ---------- TDS ----------

const rateDeducteeTypeSchema = z.enum(['individual_huf', 'company', 'firm', 'other', 'any'])
const basisPoints = z.number().int().min(0).max(10000)
const fyStartYearSchema = z.number().int().min(1990).max(2100)
const quarterSchema = z.number().int().min(1).max(4)

export const tdsSectionInputSchema = z.object({
  id: id.optional(),
  code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  description: z.string().trim().min(1).max(200),
  rate: z.number().min(0).max(100),
  thresholdSingle: paise.min(0).default(0),
  thresholdAnnual: paise.min(0).default(0),
  /** Absent = keep the stored value. */
  nature: z.string().trim().max(200).nullable().optional(),
  legacyCode: z.string().trim().max(20).nullable().optional(),
  newReference: z.string().trim().max(60).nullable().optional()
})
export type TdsSectionInput = z.input<typeof tdsSectionInputSchema>

export const tdsRateInputSchema = z
  .object({
    id: id.optional(),
    sectionId: id,
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().default(null),
    deducteeType: rateDeducteeTypeSchema,
    rateBp: basisPoints,
    thresholdSinglePaise: paise.min(0).default(0),
    thresholdAnnualPaise: paise.min(0).default(0),
    thresholdBasis: z.enum(['fy', 'month']).default('fy'),
    thresholdExcessOnly: z.boolean().default(false),
    returnCode: z.string().trim().max(10).nullable().default(null),
    noPanRateBp: basisPoints.default(2000),
    /** TCS rows: the base includes GST (WP 3.3). Absent = keep (update) / false (create). */
    baseIncludesGst: z.boolean().optional()
  })
  .refine((r) => r.effectiveTo == null || r.effectiveTo >= r.effectiveFrom, {
    message: 'Effective-to date is before effective-from',
    path: ['effectiveTo']
  })
export type TdsRateInput = z.input<typeof tdsRateInputSchema>

export const tdsRatesQuerySchema = z.object({ sectionId: id.optional() }).default({})

export const tdsCertificateInputSchema = z
  .object({
    id: id.optional(),
    ledgerId: id,
    sectionId: id.nullable().default(null),
    certificateNo: z.string().trim().min(1).max(40),
    rateBp: basisPoints,
    validFrom: isoDate,
    validTo: isoDate,
    capPaise: paise.min(0).nullable().default(null)
  })
  .refine((c) => c.validTo >= c.validFrom, { message: 'Valid-to date is before valid-from', path: ['validTo'] })
export type TdsCertificateInput = z.input<typeof tdsCertificateInputSchema>

export const tdsCertificatesQuerySchema = z.object({ ledgerId: id.optional() }).default({})

export const tdsSuggestSchema = z.object({
  partyLedgerId: id,
  base: positivePaise,
  date: isoDate,
  /** Expense / purchase ledger debited — its default section applies when the party has none. */
  expenseLedgerId: id.nullable().optional(),
  /** Alteration: the voucher being edited, excluded from the threshold history and from the
   *  certificate's consumed amount. */
  excludeVoucherId: id.optional(),
  /** The banner's section choice (WP 3.2); absent = party flag, then ledger default. */
  sectionId: id.nullable().optional(),
  /** 'payment' = first-of-credit-or-payment: deduct only on undeducted bills + advance. */
  voucherKind: z.enum(['purchase', 'journal', 'payment']).optional()
})
export type TdsSuggestInput = z.infer<typeof tdsSuggestSchema>

/** tds:ensurePayable — find-or-create the section's tagged TDS payable ledger. Kept as a thin
 *  wrapper; entry screens now let saveVoucher create it (tds.autoPayable). */
export const tdsEnsurePayableSchema = z.object({ sectionId: id })

export const tdsSummarySchema = z.object({ fyStartYear: fyStartYearSchema })
export type TdsSummaryInput = z.infer<typeof tdsSummarySchema>

export const tdsExport26qSchema = z.object({ fyStartYear: fyStartYearSchema, quarter: quarterSchema })
export type TdsExport26qInput = z.infer<typeof tdsExport26qSchema>

export const tdsChallanInputSchema = z.object({
  id: id.optional(),
  date: isoDate,
  /** 7-digit BSR code of the bank branch. */
  bsrCode: z.string().trim().regex(/^\d{7}$/, 'BSR code is 7 digits'),
  /** Challan serial number (up to 5 digits). */
  challanNo: z.string().trim().regex(/^\d{1,5}$/, 'Challan serial number is 1-5 digits'),
  amountPaise: positivePaise,
  paymentVoucherId: id.nullable().default(null),
  quarter: quarterSchema,
  fyStartYear: fyStartYearSchema
})
export type TdsChallanInput = z.input<typeof tdsChallanInputSchema>

export const tdsChallansQuerySchema = z.object({ fyStartYear: fyStartYearSchema, quarter: quarterSchema.optional() })
export const tdsAllocateSchema = z.object({ challanId: id, entryIds: z.array(id).min(1).max(1000) })
export const tdsUnallocateSchema = z.object({ entryIds: z.array(id).min(1).max(1000) })
export const tdsUnallocatedSchema = z.object({ fyStartYear: fyStartYearSchema, quarter: quarterSchema.optional() })

// WP 3.2 — the TDS screen
export const tdsEligibleSchema = z.object({ from: isoDate, to: isoDate, includeExempt: z.boolean().optional() })
export const tdsDeductedSchema = z.object({ from: isoDate, to: isoDate })
export const tdsApplySchema = z.object({
  voucherId: id,
  sectionId: id.nullable().optional(),
  /** A typed deduction (stored is_manual); absent = the rate table's figure. */
  manualPaise: positivePaise.nullable().optional()
})
export type TdsApplyInput = z.infer<typeof tdsApplySchema>
export const tdsApplyManySchema = z.object({ voucherIds: z.array(id).min(1).max(500) })
export const tdsVoucherSchema = z.object({ voucherId: id })
export const tdsExemptSchema = z.object({ voucherId: id, reason: z.string().trim().min(1).max(200) })
export const tdsQuarterSchema = z.object({ fyStartYear: fyStartYearSchema, quarter: quarterSchema })
/** Quarter 0 = the whole financial year. */
export const tdsLedgerSummarySchema = z.object({ fyStartYear: fyStartYearSchema, quarter: z.number().int().min(0).max(4) })
export const tdsChallanFromPaymentSchema = z.object({
  paymentVoucherId: id,
  bsrCode: z.string().trim().regex(/^\d{7}$/, 'BSR code is 7 digits'),
  challanNo: z.string().trim().regex(/^\d{1,5}$/, 'Challan serial number is 1-5 digits'),
  date: isoDate.nullable().optional(),
  quarter: quarterSchema.nullable().optional(),
  fyStartYear: fyStartYearSchema.nullable().optional(),
  autoAllocate: z.boolean().optional()
})
export type TdsChallanFromPaymentInput = z.infer<typeof tdsChallanFromPaymentSchema>
// WP 3.3 — TCS (the kind-agnostic calls reuse the TDS schemas below)
export const tcsSuggestSchema = z.object({
  partyLedgerId: id,
  date: isoDate,
  voucherKind: z.enum(['sales', 'receipt']),
  taxablePaise: positivePaise,
  gstPaise: paise.min(0).optional(),
  salesLedgerId: id.nullable().optional(),
  items: z.array(z.object({ stockItemId: id, amount: paise.min(0) })).max(200).optional(),
  excludeVoucherId: id.optional(),
  sectionId: id.nullable().optional()
})
export type TcsSuggestInputSchema = z.infer<typeof tcsSuggestSchema>

export const tdsChallanRowsSchema = z.object({ fyStartYear: fyStartYearSchema, quarter: quarterSchema.optional(), rateBp: basisPoints.optional() })
export const tdsChallanInterestSchema = z.object({ challanId: id, rateBp: basisPoints.optional() })
export const tdsAutoAllocateSchema = z.object({ challanId: id })
export const tdsForm16aSchema = z.object({ fyStartYear: fyStartYearSchema, quarter: quarterSchema, partyLedgerId: id.optional() })

// ---------- cost centres ----------

export const costCentreInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  parentId: id.nullable().default(null),
  active: z.boolean().default(true)
})
export type CostCentreInput = z.infer<typeof costCentreInputSchema>

export const ccStatementSchema = z.object({ ccId: id, from: isoDate, to: isoDate })
export type CcStatementInput = z.infer<typeof ccStatementSchema>

// ---------- outstandings / bill reminders ----------

export const billsOpenSchema = z.object({ partyLedgerId: id, asOn: isoDate })
export type BillsOpenInput = z.infer<typeof billsOpenSchema>

// ---------- budgets ----------

/** budget:save line input — mirrors the budget_lines CHECK (ledger XOR group) so a bad payload is
 *  rejected here rather than surfacing as a raw SQLite CHECK-constraint error. */
export const budgetLineInputSchema = z
  .object({
    ledgerId: id.nullable().default(null),
    groupId: id.nullable().default(null),
    /** 'YYYY-MM' within the budget's FY, or null for an annual line. */
    month: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM')
      .nullable()
      .default(null),
    amount: positivePaise
  })
  .refine((v) => (v.ledgerId == null) !== (v.groupId == null), {
    message: 'Each budget line must target exactly one of a ledger or a group',
    path: ['ledgerId']
  })
export type BudgetLineInput = z.infer<typeof budgetLineInputSchema>

export const budgetInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  fyStartYear: z.number().int().min(1990).max(2100),
  lines: z.array(budgetLineInputSchema).max(200)
})
export type BudgetInput = z.infer<typeof budgetInputSchema>

export const budgetVarianceSchema = z.object({
  budgetId: id,
  /** 'YYYY-MM' — annual lines report FY-to-date actuals through this month. */
  upToMonth: z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM')
})
export type BudgetVarianceInput = z.infer<typeof budgetVarianceSchema>

// ---------- bank rules (auto-categorization, task 2.5) ----------

export const bankRuleInputSchema = z.object({
  pattern: z.string().trim().min(2).max(80),
  ledgerId: id,
  kind: z.enum(['payment', 'receipt']),
  /** Statement cell the pattern matches against; defaults to 'description' server-side. */
  matchField: z.enum(['description', 'reference']).optional(),
  /** Amount window (paise, inclusive); null/omitted = unbounded on that side. */
  minAmount: paise.min(0).nullable().optional(),
  maxAmount: paise.min(0).nullable().optional(),
  /** Opt-in: an applying statement import auto-creates the voucher on an exact rule match. */
  autoApply: z.boolean().optional(),
  active: z.boolean().default(true)
})

// ---------- cheque printing (task 2.7) ----------

/** mm offset/size fields on a cheque layout — positive and boxed under a sane printable-page cap. */
const mm = z.number().positive().max(300)

/** Per-bank-ledger cheque print calibration, stored in `meta` under key `cheque.<bankLedgerId>`.
 *  Consumed by src/main/services/cheque.ts. */
export const chequeConfigSchema = z.object({
  widthMm: mm,
  heightMm: mm,
  /** Top-right CTS date boxes: first box's position, plus the per-digit horizontal gap. */
  date: z.object({ xMm: mm, yMm: mm, charGapMm: mm }),
  payee: z.object({ xMm: mm, yMm: mm }),
  words: z.object({ xMm: mm, yMm: mm, wMm: mm }),
  figures: z.object({ xMm: mm, yMm: mm }),
  acPayee: z.boolean()
})
export type ChequeConfig = z.infer<typeof chequeConfigSchema>

/** Standard CTS-2010 cheque leaf (202×92mm) — a reasonable starting point until the user
 *  calibrates their own stationery via Banking → "Cheque setup…" + the test-grid printout. */
export const DEFAULT_CHEQUE_CONFIG: ChequeConfig = {
  widthMm: 202,
  heightMm: 92,
  date: { xMm: 152, yMm: 8, charGapMm: 4.5 },
  payee: { xMm: 18, yMm: 22 },
  words: { xMm: 28, yMm: 32, wMm: 150 },
  figures: { xMm: 158, yMm: 38 },
  acPayee: true
}

/** Merge a partial/unknown-shaped object over the defaults, then validate. Never throws — falls
 *  back to all-defaults if the merged shape still doesn't validate (mirrors mergeInvoiceConfig). */
export function mergeChequeConfig(partial: unknown): ChequeConfig {
  const obj = partial && typeof partial === 'object' ? (partial as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_CHEQUE_CONFIG, ...obj }
  const parsed = chequeConfigSchema.safeParse(merged)
  return parsed.success ? parsed.data : { ...DEFAULT_CHEQUE_CONFIG }
}

/** `app:notifyDeadlines` — the renderer hands over titles/bodies it already computed from
 *  `src/shared/compliance.ts`; the main process just guards the once-per-day fire and pops the
 *  OS notifications (see `services/notifications.ts`). */
export const notifyDeadlinesSchema = z.object({
  items: z.array(z.object({ title: z.string().min(1), body: z.string().min(1) }))
})
export type NotifyDeadlinesInput = z.infer<typeof notifyDeadlinesSchema>
export type BankRuleInput = z.infer<typeof bankRuleInputSchema>

// ---------- report print/export (task 3.6) ----------

/** Filenames are slugified client-side before hitting the wire — this just double-checks it
 *  server-side too, since the string is joined straight into an exports/<file> path. */
const exportFilename = z.string().trim().regex(/^[a-z0-9-_]+$/, 'Filename must be lowercase letters, digits, - or _')

export const reportColumnSchema = z.object({
  label: z.string().trim().min(1).max(60),
  align: z.enum(['l', 'r', 'c']),
  width: z.number().positive().max(2000).optional()
})

export const reportRowSchema = z.object({
  cells: z.array(z.string()).max(40),
  bold: z.boolean().optional(),
  indent: z.number().int().min(0).max(12).optional(),
  rule: z.boolean().optional()
})

export const reportPdfSchema = z.object({
  title: z.string().trim().min(1).max(120),
  periodLabel: z.string().trim().max(120).default(''),
  columns: z.array(reportColumnSchema).min(1).max(20),
  rows: z.array(reportRowSchema).max(5000),
  footNote: z.string().max(500).optional(),
  filename: exportFilename,
  /** Landscape orientation for wide reports (lane Q #95). */
  landscape: z.boolean().default(false)
})
export type ReportPdfInput = z.infer<typeof reportPdfSchema>

export const exportCsvSchema = z.object({
  filename: exportFilename,
  csv: z.string().max(2 * 1024 * 1024)
})
export type ExportCsvInput = z.infer<typeof exportCsvSchema>

// ---------- payroll pay heads + statutory exports (lane Y, task Y1) ----------

/** payroll:heads:save input. `value` is monthly paise for calc 'flat', or percent × 100 (basis
 *  points of basic, 4000 = 40%) for 'percent_of_basic'. */
export const payHeadInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['earning', 'deduction']),
    calc: z.enum(['flat', 'percent_of_basic']),
    value: z.number().int().min(0),
    active: z.boolean().default(true),
    /** WP 3.7: "wages" under CoSS s.2(88) (false = an excluded item such as HRA or conveyance). */
    inWages: z.boolean().default(true)
  })
  .refine((v) => v.calc !== 'percent_of_basic' || v.value <= 10000, {
    message: 'Percent-of-basic value is percent × 100 (max 10000 = 100%)',
    path: ['value']
  })
export type PayHeadInput = z.infer<typeof payHeadInputSchema>

/** payroll:employeeHeads:set input — replaces the employee's full head assignment list.
 *  overrideValue null = use the head's default value. */
export const employeeHeadsSetSchema = z.object({
  employeeId: id,
  heads: z
    .array(z.object({ payHeadId: id, overrideValue: z.number().int().min(0).nullable().default(null) }))
    .max(50)
})
export type EmployeeHeadsSetInput = z.infer<typeof employeeHeadsSetSchema>

/** payroll:ecr / payroll:esi / payroll:ptSummary input. */
export const payrollRunIdSchema = z.object({ runId: id })

// ---------- payroll statutory (WP 3.7) ----------

export const STATUTORY_RATE_KINDS = ['epf', 'eps', 'edli', 'epf_admin', 'esi_emp', 'esi_er', 'pt', 'ss_wages'] as const
export type StatutoryRateKind = (typeof STATUTORY_RATE_KINDS)[number]

/** payroll:rates:save — one effective-dated statutory rate / PT slab row. */
export const statutoryRateInputSchema = z
  .object({
    kind: z.enum(STATUTORY_RATE_KINDS),
    state: z.string().trim().toUpperCase().length(2).nullable().default(null),
    effectiveFrom: isoDate,
    effectiveTo: isoDate.nullable().default(null),
    rateBp: z.number().int().min(0).max(10000).nullable().default(null),
    ceilingPaise: z.number().int().min(0).nullable().default(null),
    thresholdPaise: z.number().int().min(0).nullable().default(null),
    minPaise: z.number().int().min(0).nullable().default(null),
    slabFromPaise: z.number().int().min(0).nullable().default(null),
    slabToPaise: z.number().int().min(0).nullable().default(null),
    amountPaise: z.number().int().min(0).nullable().default(null),
    basis: z.enum(['month', 'half_year', 'year']).default('month'),
    gender: z.enum(['any', 'male', 'female']).default('any'),
    variant: z.enum(['standard', 'disabled']).default('standard'),
    specialMonth: z.number().int().min(1).max(12).nullable().default(null),
    specialAmountPaise: z.number().int().min(0).nullable().default(null),
    source: z.string().trim().min(1).max(600),
    verified: z.boolean().default(false)
  })
  .refine((v) => v.effectiveTo == null || v.effectiveTo >= v.effectiveFrom, { message: 'Effective to is before effective from', path: ['effectiveTo'] })
  .refine((v) => v.kind !== 'pt' || (v.state != null && v.amountPaise != null && v.slabFromPaise != null), {
    message: 'A professional-tax row needs a state, a slab start and an amount', path: ['kind']
  })
  .refine((v) => v.kind === 'pt' || v.rateBp != null, { message: 'A rate row needs a rate', path: ['rateBp'] })
export type StatutoryRateInput = z.infer<typeof statutoryRateInputSchema>

export const DECLARATION_SECTION_IDS = [
  '80C', '80CCD1B', '80D', '80D_PARENTS', '24B', 'RENT', 'OTHER_INCOME', 'PREV_SALARY', 'PREV_TDS', 'PREV_PT'
] as const

/** payroll:declarations:set — replaces an employee's declarations for one financial year. */
export const taxDeclarationsSetSchema = z.object({
  employeeId: id,
  fyStartYear: z.number().int().min(2000).max(2100),
  rows: z
    .array(z.object({
      section: z.enum(DECLARATION_SECTION_IDS),
      amountPaise: z.number().int().min(0).max(1_000_000_000_00),
      proofReceived: z.boolean().default(false)
    }))
    .max(DECLARATION_SECTION_IDS.length)
})
export type TaxDeclarationsSetInput = z.infer<typeof taxDeclarationsSetSchema>

export const STATUTORY_PAYMENT_KINDS = ['pf', 'esi', 'pt', 'tds'] as const
export type StatutoryPaymentKind = (typeof STATUTORY_PAYMENT_KINDS)[number]

/** payroll:payments:record — pay a month's dues: books a Payment voucher (Dr the tagged payable /
 *  Cr bank or cash) and records it against the period. */
export const statutoryPaymentInputSchema = z.object({
  kind: z.enum(STATUTORY_PAYMENT_KINDS),
  period: z.string().regex(/^\d{4}-\d{2}$/),
  state: z.string().trim().toUpperCase().length(2).nullable().default(null),
  amountPaise: z.number().int().positive(),
  paidOn: isoDate,
  bankLedgerId: id,
  reference: z.string().trim().max(60).nullable().default(null),
  /** TDS only: register the challan on the TDS screen too (BSR code + challan serial). */
  bsrCode: z.string().trim().regex(/^\d{7}$/, 'BSR code is 7 digits').nullable().default(null),
  challanNo: z.string().trim().min(1).max(10).nullable().default(null)
})
export type StatutoryPaymentInput = z.infer<typeof statutoryPaymentInputSchema>

export const payrollFySchema = z.object({ fyStartYear: z.number().int().min(2000).max(2100) })
export const form16InputSchema = z.object({ fyStartYear: z.number().int().min(2000).max(2100), employeeId: id.optional() })

// ---------- agent bridge (lane A) ----------

/** agent:exportMirror input — regenerate the CSV/JSON mirror under `<company>/agent/`. */
export const agentExportSchema = z.object({
  what: z.enum(['masters', 'vouchers', 'reports', 'all']).default('all'),
  format: z.enum(['csv', 'json', 'all']).default('all'),
  from: isoDate.optional(),
  to: isoDate.optional()
})
export type AgentExportInput = z.input<typeof agentExportSchema>

/** agent:setConfig input — toggle the inbox watcher + auto mirror refresh (default OFF). */
export const agentBridgeConfigSchema = z.object({ enabled: z.boolean() })
export type AgentBridgeConfigInput = z.infer<typeof agentBridgeConfigSchema>

// ---------- Tally import wizard v2 (task 3.5) ----------

export const tallyImportSchema = z
  .object({
    xmlText: z.string().optional(),
    filePath: z.string().optional(),
    dryRun: z.boolean().default(false)
  })
  .default({})
export type TallyImportInput = z.infer<typeof tallyImportSchema>

// ---------- GST rebuild (lane G): voucher transport + GSTR-3B manual adjustments ----------

/** edoc:transportSet payload — per-voucher transporter/vehicle/transport-doc + ship-to block
 *  persisted to voucher_transport (migration 013); consumed by the EWB/e-invoice builders. */
export const voucherTransportSchema = z.object({
  transMode: z.enum(['1', '2', '3', '4']).nullable().default(null),
  transDistanceKm: z.number().int().min(0).max(10000).nullable().default(null),
  transporterId: z.string().trim().max(20).nullable().default(null),
  transporterName: z.string().trim().max(120).nullable().default(null),
  transDocNo: z.string().trim().max(30).nullable().default(null),
  transDocDate: isoDate.nullable().default(null),
  vehicleNo: z.string().trim().max(20).nullable().default(null),
  vehicleType: z.enum(['R', 'O']).nullable().default(null),
  shipToName: z.string().trim().max(120).nullable().default(null),
  shipToGstin: gstinSchema.nullable().default(null),
  shipToAddr1: z.string().trim().max(200).nullable().default(null),
  shipToAddr2: z.string().trim().max(200).nullable().default(null),
  shipToPlace: z.string().trim().max(80).nullable().default(null),
  shipToPincode: z.string().trim().regex(/^\d{6}$/, 'PIN code must be 6 digits').nullable().default(null),
  shipToState: stateCodeSchema.nullable().default(null)
})
export type VoucherTransportInput = z.infer<typeof voucherTransportSchema>

const itcPartSchema = z.object({
  igst: paise.default(0),
  cgst: paise.default(0),
  sgst: paise.default(0),
  cess: paise.default(0)
})

/** Manual GSTR-3B adjustments for one period, persisted in meta `gst3b.manual.<MMYYYY>`:
 *  4(B) ITC reversals, 5.1 interest and late fee. All amounts integer paise. */
export const gst3bManualSchema = z.object({
  itcRevRul: itcPartSchema.default({}),
  itcRevOth: itcPartSchema.default({}),
  /** 4(D)(1) — ITC reclaimed that was reversed under 4(B)(2) in an earlier period (rule 37 /
   *  37A re-availment; Circular 170/02/2022-GST): availed again in 4(A)(5) and reported here. */
  itcReclaimed: itcPartSchema.default({}),
  interest: itcPartSchema.default({}),
  lateFee: z.object({ camt: paise.default(0), samt: paise.default(0) }).default({})
})
export type Gst3bManualInput = z.infer<typeof gst3bManualSchema>
// ---------- inventory depth (lane I): batches, price levels, stock analysis ----------

export const batchInputSchema = z.object({
  stockItemId: id,
  name: z.string().trim().min(1).max(60),
  mfgDate: isoDate.nullable().default(null),
  expiryDate: isoDate.nullable().default(null)
})
export type BatchInput = z.infer<typeof batchInputSchema>

export const priceLevelInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  /** WP 2.6: the level's rates include GST. Absent = keep (update) / no (create). */
  inclusiveOfTax: z.boolean().optional(),
  /** WP 2.6: the company's default level (only one). Absent = keep (update) / no (create). */
  isDefault: z.boolean().optional()
})
export type PriceLevelInput = z.infer<typeof priceLevelInputSchema>

/** One date-effective per-item rate under a price level. `rate` is paise per whole unit. */
export const priceRateInputSchema = z.object({
  priceLevelId: id,
  stockItemId: id,
  rate: paise.min(0),
  effectiveFrom: isoDate,
  /** WP 2.6 (migration 030): inclusive end date (null = open), quantity slab, slab discount,
   *  rate currency. Defaults = the pre-030 meaning (open-ended ₹ base slab, no discount). */
  effectiveTo: isoDate.nullable().default(null),
  minQtyMilli: z.number().int().min(0).default(0),
  discountBp: z.number().int().min(0).max(10000).default(0),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('INR')
}).refine((r) => r.effectiveTo == null || r.effectiveTo >= r.effectiveFrom, 'The end date is before the start date')
export type PriceRateInput = z.input<typeof priceRateInputSchema>

/** stock:* report queries — asOn plus optional godown scope. */
export const stockQuerySchema = z.object({
  asOn: isoDate,
  godownId: id.optional()
})
export type StockQueryInput = z.infer<typeof stockQuerySchema>

/** stock:costAsOf (WP 2.1) — exact engine cost position at a voucher's date (and, for an edit,
 *  its position among that date's vouchers), optionally pricing proposed outward lines. */
export const stockCostAsOfSchema = z.object({
  date: isoDate,
  voucherId: id.optional(),
  itemIds: z.array(id).max(2000).optional(),
  lines: z
    .array(z.object({ itemId: id, qtyMilli: z.number().int().nonnegative().max(1e12) }))
    .max(500)
    .optional()
})
export type StockCostAsOfInput = z.infer<typeof stockCostAsOfSchema>

// ---------- manufacture voucher (WP 2.2) ----------
// Structural parsing only — the business rules (row completeness, duplicates, profit to the
// paisa) live in @shared/manufacture's validateManufacture so the screen and server agree.

export const manufactureInputSchema = z.object({
  voucherTypeId: id.optional(),
  date: isoDate,
  number: z.string().trim().max(40).optional(),
  narration: z.string().trim().max(1000).nullable().optional(),
  godownId: id.nullable().optional(),
  finishedItemId: z.number().int().nonnegative(),
  qtyMilli: z.number().int().nonnegative().max(1e12),
  saleRatePaise: paise,
  raw: z
    .array(
      z.object({
        stockItemId: z.number().int().nonnegative(),
        qtyMilli: z.number().int().nonnegative().max(1e12),
        godownId: id.nullable().optional(),
        lossQtyMilli: z.number().int().max(1e12).optional()
      })
    )
    .max(200),
  labourPaise: paise,
  labourPosted: z.boolean(),
  labourCreditLedgerId: id.nullable().optional(),
  profitPaise: paise,
  confirmLoss: z.boolean().optional(),
  // WP 2.4
  byProducts: z
    .array(
      z.object({
        stockItemId: z.number().int().nonnegative(),
        qtyMilli: z.number().int().nonnegative().max(1e12),
        valuePaise: paise,
        kind: z.enum(['by_product', 'scrap']).default('by_product'),
        godownId: id.nullable().optional()
      })
    )
    .max(50)
    .optional(),
  bomVersionId: id.nullable().optional(),
  bomExploded: z.boolean().optional(),
  jobWork: z
    .object({
      godownId: z.number().int().nonnegative(),
      challanNo: z.string().trim().max(40).nullable().optional(),
      challanDate: isoDate.nullable().optional(),
      natureOfProcessing: z.string().trim().max(200).nullable().optional(),
      originalChallanVoucherId: id.nullable().optional()
    })
    .nullable()
    .optional()
})
export type ManufactureInputParsed = z.infer<typeof manufactureInputSchema>

export const manufactureSaveSchema = z.object({ data: manufactureInputSchema, id: id.optional() })

export const manufactureCostPreviewSchema = z.object({
  date: isoDate,
  /** The voucher being edited (its own lines are left out of the pricing). */
  voucherId: id.optional(),
  finishedItemId: id.nullable().optional(),
  lines: z.array(z.object({ itemId: id, qtyMilli: z.number().int().nonnegative().max(1e12) })).max(200).default([])
})
export type ManufactureCostPreviewInput = z.infer<typeof manufactureCostPreviewSchema>

export const manufactureRegisterSchema = z.object({ from: isoDate, to: isoDate })

/** WP 2.4 manufacturing reports: a period, optionally one finished item. */
export const manufactureReportSchema = z.object({ from: isoDate, to: isoDate, itemId: id.optional() })

/** WP 2.4: a job-work send / return challan — the godown-transfer voucher plus its ITC-04 facts.
 *  The voucher payload is parsed again by saveVoucher. */
export const jobWorkChallanSaveSchema = z.object({
  id: id.optional(),
  voucher: z.unknown(),
  challan: z.object({
    kind: z.enum(['send', 'return']),
    godownId: id,
    natureOfProcessing: z.string().trim().max(200).nullable().optional(),
    goodsType: z.enum(['inputs', 'capital_goods']).default('inputs'),
    /** Return only: the job worker's challan for the material coming back. */
    challanNo: z.string().trim().max(40).nullable().optional(),
    challanDate: isoDate.nullable().optional(),
    originalChallanVoucherId: id.nullable().optional()
  })
})
export type JobWorkChallanSaveInput = z.infer<typeof jobWorkChallanSaveSchema>

/** WP 2.4: material at job workers as on a date; `pendingDays` flags lots older than that. */
export const jobWorkPendingSchema = z.object({ asOn: isoDate, pendingDays: z.number().int().min(0).max(3650).default(180) })

export const stockMovementsSchema = z.object({ stockItemId: id, from: isoDate, to: isoDate })
// ---------- stock visibility (WP 2.3) ----------

/** stock:register — one item's movement register over a period with running quantity and
 *  value from the valuation pass, optionally one godown (WP 2.2's stock:movements is the plain
 *  line list). */
export const stockRegisterSchema = z.object({
  itemId: id,
  from: isoDate,
  to: isoDate,
  godownId: id.optional()
})

/** stock:reorder — reorder planning over a consumption window ending `to`. */
export const stockReorderSchema = z.object({ from: isoDate, to: isoDate, onlyBelow: z.boolean().optional() })

/** stock:expiryReport — batches expired or expiring within N days of asOn. */
export const stockExpiryReportSchema = z.object({ asOn: isoDate, withinDays: z.number().int().min(0).max(3650) })

/** stock:labelsHtml / stock:labelsPdf — barcode label sheet. */
export const stockLabelsSchema = z.object({
  items: z.array(z.object({ itemId: id, copies: z.number().int().min(0).max(500) })).min(1).max(500),
  priceLevelId: id.nullable().optional(),
  date: isoDate
})
export type StockLabelsInput = z.infer<typeof stockLabelsSchema>

/** serials:list / serials:available. */
export const serialsListSchema = z.object({
  stockItemId: id.optional(),
  status: z.enum(['in_stock', 'sold', 'consumed', 'returned', 'delivered']).optional()
})
export const serialsAvailableSchema = z.object({ stockItemId: id, voucherId: id.optional() })
