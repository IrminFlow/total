import { z } from 'zod'
import { SCHEDULE_FORMATS, SCHEDULE_FREQUENCIES, SCHEDULE_PERIODS, SCHEDULE_REPORTS } from './reportSchedule'
import { GST_STATES } from './gst/states'
import { validateGstin } from './gst/validate'
import { isUqc } from './gst/uqc'
import { PT_STATES } from './payroll'
import { CAPABILITIES } from './permissions'
import { EXTERNAL_BACKUP_HOURS, EXTERNAL_KEEP_MIN, EXTERNAL_KEEP_MAX } from './backupSchedule'

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
  gstFilingFrequency: z.enum(['monthly', 'quarterly']).default('monthly'),
  address: z.string().trim().max(500).default(''),
  // .default(null) so companies created before turnover was asked for still parse.
  turnoverBand: z.enum(['upto-50L', '50L-1.5Cr', '1.5Cr-5Cr', '5Cr-10Cr', '10Cr-plus']).nullable().default(null),
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
  creditDays: z.number().int().min(0).max(365).nullable().default(null),
  exportType: z.enum(['sez_wp', 'sez_wop', 'exp_wp', 'exp_wop']).nullable().default(null),
  /** Reverse charge applies to this party's supplies (GSTR-1 rchrg / GSTR-3B 3.1(d)). */
  rcm: z.boolean().default(false),
  /** ITC eligibility class for purchases from this party — 'blocked' lands in 3B 4(D). */
  itcEligibility: z.enum(['eligible', 'blocked', 'capital_goods', 'input_services']).default('eligible'),
  /** Price level whose rates prefill this party's invoice lines; absent/null = item base rate. */
  priceLevelId: id.nullable().optional(),
  /** Cost centre prefilled on lines posted against this party; absent = leave it as it is, which
   *  is what lets a partial update (an importer, the agent bridge) rename a ledger without
   *  silently clearing a default nobody mentioned. */
  defaultCostCentreId: id.nullable().optional(),
  /** Credit limit in paise; absent/null = no limit. */
  creditLimit: paise.min(0).nullable().optional(),
  /** Overdue interest in basis points (1800 = 18% p.a.); absent/null = no interest charged.
   *  Capped at 60% p.a. — above that it is a penalty nobody will pay and a court would not
   *  uphold, and a stray extra digit should be caught here rather than on a customer's statement. */
  interestRateBp: z.number().int().min(0).max(6000).nullable().optional(),
  interestGraceDays: z.number().int().min(0).max(365).nullable().optional(),
  relatedParty: z.boolean().optional(),
  relationship: z.string().trim().max(80).nullable().optional(),
  /** MSME classification. Absent/null means nobody has asked, which is not the same as
   *  'not_registered' and must not be treated as an exemption from section 43B(h). */
  msmeStatus: z.enum(['micro', 'small', 'medium', 'not_registered']).nullable().optional(),
  udyamNumber: z.string().trim().max(25).nullable().optional(),
  salesperson: z.string().trim().max(60).nullable().optional(),
  territory: z.string().trim().max(60).nullable().optional(),
  // Stored as typed. Normalising to E.164 happens at the point of use, because a user pasting
  // a number from a phonebook should not have it silently rewritten in their master data.
  phone: z.string().trim().max(24).nullable().optional(),
  email: z.string().trim().max(120).nullable().optional(),
  /** Where this party is paid. Stored as typed apart from the length cap — the comparison that
   *  matters (is this the same account as another party's?) normalises at the point of use, see
   *  src/shared/bankDetails.ts. Absent leaves whatever is already on the master alone; the
   *  two-person rule (roadmap V #388) is applied above this schema, not by it. */
  bankAccount: z.string().trim().max(34).nullable().optional(),
  bankIfsc: z
    .string()
    .trim()
    .toUpperCase()
    .max(11)
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Not an IFSC (e.g. HDFC0001234)')
    .nullable()
    .optional(),
  bankHolder: z.string().trim().max(120).nullable().optional(),
  /** The user has said this account is knowingly shared with another party — a proprietor and
   *  their firm. Silences the shared-account exception for this party only. */
  bankSharedOk: z.boolean().optional()
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
  parentId: id.nullable().default(null),
  /** Tax an item in this group inherits when it states none of its own. Absent/null = nothing
   *  to inherit, which is what every group was before this existed. */
  gstRate: z.number().min(0).max(100).nullable().optional(),
  cessRate: z.number().min(0).max(300).nullable().optional(),
  hsn: z.string().trim().max(12).nullable().optional()
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
  /** Short code printed on the shelf label — what a person types at a counter. An empty string
   *  is normalised to null in the service, so a cleared field does not claim the unique index. */
  code: z.string().trim().max(32).nullable().optional(),
  barcode: z
    .string()
    .trim()
    .max(64)
    .nullable()
    .default(null)
    .transform((s) => (s === '' ? null : s)),
  /** Alternate unit and how many base units are in one of it (thousandths). Both or neither. */
  altUnitId: id.nullable().optional(),
  altConversionMilli: z.number().int().positive().nullable().optional(),
  /** Reorder level in integer thousandths; null = no reorder alert (v0.3 #58). */
  reorderLevelMilli: z.number().int().min(0).nullable().default(null),
  /** Absent = keep existing (update) / 'weighted_avg' (create). */
  valuationMethod: z.enum(['weighted_avg', 'fifo']).optional(),
  /**
   * Refuse to let this item go negative, whatever the company setting says.
   *
   * Three states, not two: null follows the company, true blocks regardless, false permits
   * regardless. A boolean would have forced every existing item to an opinion nobody has.
   */
  // Optional rather than defaulted: "not specified" and "explicitly null" both mean follow the
  // company, so there is nothing for a default to add — and requiring it would make every
  // existing caller state an opinion it does not have.
  blockNegative: z.boolean().nullable().optional()
})
export type StockItemInput = z.infer<typeof stockItemInputSchema>

export const godownInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().max(500).nullable().optional()
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
  tdsAmount: positivePaise
})

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
    isAbsolute: z.boolean().optional()
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
  tds: tdsSchema.nullable().default(null)
})
export type VoucherInputParsed = z.infer<typeof voucherInputSchema>
/** Unparsed shape (defaults optional) — saveVoucher parses internally. */
export type VoucherInput = z.input<typeof voucherInputSchema>

export const voucherTypeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum([
    'contra', 'payment', 'receipt', 'journal', 'sales',
    'purchase', 'credit_note', 'debit_note', 'stock_journal', 'physical_stock'
  ]),
  numbering: z.enum(['auto', 'manual']).default('auto'),
  prefix: z.string().trim().max(20).default(''),
  suffix: z.string().trim().max(20).default(''),
  padWidth: z.number().int().min(0).max(8).default(0),
  restartFy: z.boolean().default(true)
})
export type VoucherTypeInput = z.infer<typeof voucherTypeInputSchema>

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
  // Optional rather than defaulted: an employee paid in cash genuinely has neither, and
  // requiring them would make payroll refuse a run it should accept.
  bankAccount: z.string().trim().max(30).nullable().optional(),
  // Shape-checked only. An IFSC that is well-formed but wrong still sends money somewhere, so
  // the check that matters is the bank's, not ours — this only catches obvious typos.
  ifsc: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Not an IFSC (e.g. HDFC0001234)')
    .nullable()
    .optional(),
  email: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(24).nullable().optional(),
  /** Section 115BAC. Absent or null means the new regime, which is the statutory default —
   *  stored as NULL so "never chosen" and "chose the default" stay the same fact. */
  taxRegime: z.enum(['new', 'old']).nullable().optional(),
  /** Chapter VI-A deductions declared and accepted, paise. Ignored under the new regime. */
  declaredDeductions: paise.min(0).nullable().optional(),
  /** TDS a previous system already took this financial year. */
  openingTds: paise.min(0).nullable().optional(),
  active: z.boolean().default(true)
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

/** NIC live-filing credentials, stored per company in the meta table. */
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

/** Scheduled copy of the books into a folder somewhere else (roadmap #245, #253). */
export const externalBackupSchema = z.object({
  dir: z.string().max(1000).nullable(),
  everyHours: z.number().int().refine((h) => (EXTERNAL_BACKUP_HOURS as readonly number[]).includes(h), 'Unsupported interval'),
  encrypt: z.boolean(),
  keep: z.number().int().min(EXTERNAL_KEEP_MIN).max(EXTERNAL_KEEP_MAX),
  /** Only when turning encryption on or changing it; stored in the OS keychain, never in the DB. */
  passphrase: passphraseSchema.optional()
})
export type ExternalBackupInput = z.infer<typeof externalBackupSchema>

/** The entry screen's crash-safe draft (roadmap #250). Opaque to main by design. */
export const draftSaveSchema = z.object({ payload: z.unknown() })

/** audit:list query — entity/date range are optional filters; page is server-paged at 100 rows. */
export const auditListSchema = z.object({
  entity: z.string().trim().min(1).optional(),
  /** Narrow to one record's history — the trail behind a single voucher, ledger or filing. */
  entityId: z.number().int().positive().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.number().int().min(0).default(0),
  /** Rows per page; server defaults to AUDIT_PAGE_SIZE (100) when absent. */
  pageSize: z.number().int().min(10).max(500).optional()
})
export type AuditListInput = z.infer<typeof auditListSchema>

// ---------- lane Q: audit retention + batch invoice PDF ----------

/** config:audit:set — days of audit history to keep, or null = keep forever (the default). */
export const auditRetentionSchema = z.object({
  keepDays: z.number().int().min(30).max(3650).nullable()
})
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

/** users:save input — pin is digits-only, 4-12 long; required on create, optional on update
 *  (an update without a pin keeps the existing hash). Role requests are honored except for the
 *  very first user of a company, which the service always forces to 'owner'. */
export const userInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  role: z.enum(['owner', 'accountant', 'viewer']),
  pin: z.string().regex(/^\d{4,12}$/, 'PIN must be 4-12 digits').optional(),
  active: z.boolean().default(true),
  /** Areas cut out of this user's role (roadmap #266). Deny-only — see @shared/permissions. */
  denied: z.array(z.enum(CAPABILITIES)).default([])
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

export const tdsSectionInputSchema = z.object({
  id: id.optional(),
  code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
  description: z.string().trim().min(1).max(200),
  rate: z.number().min(0).max(100),
  thresholdSingle: paise.min(0).default(0),
  thresholdAnnual: paise.min(0).default(0)
})
export type TdsSectionInput = z.infer<typeof tdsSectionInputSchema>

export const tdsSuggestSchema = z.object({
  partyLedgerId: id,
  base: positivePaise,
  date: isoDate,
  /** The voucher being edited, so its own lines don't consume the payee's Rule 28AA ceiling
   *  before we ask how much of that ceiling is left. Absent on a new voucher. */
  excludeVoucherId: id.optional()
})
export type TdsSuggestInput = z.infer<typeof tdsSuggestSchema>

export const tdsSummarySchema = z.object({ fyStartYear: z.number().int().min(1990).max(2100) })
export type TdsSummaryInput = z.infer<typeof tdsSummarySchema>

export const tdsExport26qSchema = z.object({
  fyStartYear: z.number().int().min(1990).max(2100),
  quarter: z.number().int().min(1).max(4)
})
export type TdsExport26qInput = z.infer<typeof tdsExport26qSchema>

/**
 * A section 197 / 197A lower-deduction certificate as issued by the Assessing Officer.
 *
 * `ceilingPaise` is nullable and that null is load-bearing: null = the AO named no amount
 * (uncapped), 0 = a certificate with nothing left on it. Collapsing the two would either let an
 * uncapped nil certificate start deducting or let a spent one keep going. PAN is required, not
 * optional as it is on a ledger — Rule 28AA(2) does not let a certificate exist without one.
 */
export const tdsCertificateInputSchema = z
  .object({
    certificateNumber: z.string().trim().min(1).max(40).transform((s) => s.toUpperCase()),
    pan: z
      .string()
      .trim()
      .transform((s) => s.toUpperCase())
      .refine((s) => /^[A-Z]{5}\d{4}[A-Z]$/.test(s), 'Invalid PAN'),
    sectionCode: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()),
    ratePercent: z.number().min(0).max(100),
    validFrom: isoDate,
    validTo: isoDate,
    ceilingPaise: paise.min(0).nullable().default(null),
    notes: z.string().trim().max(500).nullable().default(null)
  })
  .refine((v) => v.validFrom <= v.validTo, {
    message: 'Certificate valid-from must not be after valid-to',
    path: ['validTo']
  })
export type TdsCertificateInput = z.infer<typeof tdsCertificateInputSchema>

/** Form 26AS reconciliation. `text` is inline so a driver can test it without a file dialog. */
export const tds26asSchema = z.object({
  text: z.string().min(1).max(20_000_000),
  from: isoDate,
  to: isoDate,
  /** Paise two TDS figures may differ by and still be the same deduction. Default ₹1. */
  amountTolerancePaise: paise.min(0).default(100),
  /** Days the two dates may differ by before the pair is called a date drift. */
  dateWindowDays: z.number().int().min(0).max(370).default(7)
})
export type Tds26asInput = z.infer<typeof tds26asSchema>

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

// ---------- recurring vouchers ----------

/** recurring:save input. `voucherJson` is the exact VoucherInputParsed payload for the template —
 *  validated for JSON-parseability/shape here; the service re-validates against voucherInputSchema
 *  itself (see recurring.ts) so schema drift is caught at save time too, not just at post time. */
export const recurringInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    voucherJson: z.string().min(2),
    cadence: z.enum(['monthly', 'weekly']),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    weekday: z.number().int().min(0).max(6).optional(),
    nextDue: isoDate,
    active: z.boolean().default(true)
  })
  .refine((v) => v.cadence !== 'monthly' || v.dayOfMonth != null, {
    message: 'dayOfMonth is required for a monthly cadence',
    path: ['dayOfMonth']
  })
  .refine((v) => v.cadence !== 'weekly' || v.weekday != null, {
    message: 'weekday is required for a weekly cadence',
    path: ['weekday']
  })
export type RecurringInput = z.infer<typeof recurringInputSchema>

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

// ---------- spreadsheet export, saved views, scheduled reports (roadmap C58/C59/C67) ----------

/** A cell as the renderer sends it: money stays integer paise all the way into the workbook. */
const xlsCellSchema = z.union([z.string().max(1000), z.number(), z.null()])

export const exportXlsSchema = z.object({
  filename: exportFilename,
  sheets: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        columns: z
          .array(
            z.object({
              label: z.string().trim().max(60),
              kind: z.enum(['text', 'money', 'date', 'number'])
            })
          )
          .min(1)
          .max(40),
        // Deliberately generous: an export covers the whole period, and a cap that silently
        // truncated a year of day book would be exactly the trap CSV export already avoids.
        rows: z
          .array(z.object({ cells: z.array(xlsCellSchema).max(40), bold: z.boolean().optional() }))
          .max(200_000)
      })
    )
    .min(1)
    .max(20)
})
export type ExportXlsInput = z.infer<typeof exportXlsSchema>

export const reportViewSaveSchema = z.object({
  screen: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  /** Opaque display state — the screen that wrote it is the only thing that reads it. */
  state: z.unknown()
})

export const reportScheduleInputSchema = z.object({
  report: z.enum(SCHEDULE_REPORTS),
  periodKind: z.enum(SCHEDULE_PERIODS),
  format: z.enum(SCHEDULE_FORMATS),
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  /** Absolute path, or null for the company's own exports folder. */
  folder: z.string().trim().max(500).nullable().default(null),
  nextRun: isoDate,
  active: z.boolean().default(true)
})
export type ReportScheduleInputParsed = z.infer<typeof reportScheduleInputSchema>

// ---------- payroll pay heads + statutory exports (lane Y, task Y1) ----------

/** payroll:heads:save input. `value` is monthly paise for calc 'flat', or percent × 100 (basis
 *  points of basic, 4000 = 40%) for 'percent_of_basic'. */
export const payHeadInputSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    kind: z.enum(['earning', 'deduction']),
    calc: z.enum(['flat', 'percent_of_basic']),
    value: z.number().int().min(0),
    active: z.boolean().default(true)
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
  name: z.string().trim().min(1).max(60)
})
export type PriceLevelInput = z.infer<typeof priceLevelInputSchema>

/** One date-effective per-item rate under a price level. `rate` is paise per whole unit. */
export const priceRateInputSchema = z.object({
  priceLevelId: id,
  stockItemId: id,
  rate: paise.min(0),
  effectiveFrom: isoDate
})
export type PriceRateInput = z.infer<typeof priceRateInputSchema>

/**
 * One dated GST rate change on a stock item (roadmap D-92). Rates are percentages, not paise —
 * that is what the statute states and what the portal expects. The upper bounds are deliberately
 * loose (the Council notified a 40% demerit rate in 2025); the engine warns about anything that
 * is not a notified slab rather than refusing it.
 */
export const itemRateInputSchema = z.object({
  stockItemId: id,
  effectiveFrom: isoDate,
  ratePercent: z.number().min(0).max(100),
  cessPercent: z.number().min(0).max(1000).default(0),
  /** The notification that made the change — a rate with no citation cannot be audited. */
  note: z.string().trim().max(120).nullable().default(null)
})
export type ItemRateInput = z.infer<typeof itemRateInputSchema>

/** stock:* report queries — asOn plus optional godown scope. */
export const stockQuerySchema = z.object({
  asOn: isoDate,
  godownId: id.optional()
})
export type StockQueryInput = z.infer<typeof stockQuerySchema>
