import { z } from 'zod'
import { GST_STATES } from './gst/states'
import { validateGstin } from './gst/validate'

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

export const stateCodeSchema = z.string().refine((s) => s in GST_STATES, 'Unknown GST state code')

export const gstinSchema = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .refine((s) => validateGstin(s).valid, 'Invalid GSTIN')

const paise = z.number().int().safe()
const positivePaise = paise.positive()
const id = z.number().int().positive()

export const companyCreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  stateCode: stateCodeSchema,
  gstin: gstinSchema.nullable(),
  gstRegistrationType: z.enum(['regular', 'composition', 'unregistered']),
  address: z.string().trim().max(500).default(''),
  booksFrom: z.number().int().min(1990).max(2100),
  email: z.string().trim().email().nullable(),
  phone: z.string().trim().max(20).nullable()
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
  hsn: z.string().trim().nullable().default(null)
})
export type LedgerInput = z.infer<typeof ledgerInputSchema>

export const unitInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  symbol: z.string().trim().min(1).max(12),
  decimals: z.number().int().min(0).max(3),
  uqc: z.string().trim().min(2).max(8).transform((s) => s.toUpperCase())
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
  openingValue: paise.min(0).default(0)
})
export type StockItemInput = z.infer<typeof stockItemInputSchema>

export const godownInputSchema = z.object({
  name: z.string().trim().min(1).max(120)
})
export type GodownInput = z.infer<typeof godownInputSchema>

export const voucherLineSchema = z.object({
  ledgerId: id,
  drCr: z.enum(['dr', 'cr']),
  amount: positivePaise
})

export const inventoryLineSchema = z.object({
  stockItemId: id,
  godownId: id.nullable().default(null),
  qtyMilli: z.number().int().positive(),
  ratePaise: paise.min(0),
  amount: paise.min(0),
  direction: z.enum(['in', 'out'])
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
  currencyCode: z.string().trim().length(3).transform((s) => s.toUpperCase()).nullable().default(null),
  exchangeRate: z.number().positive().max(100000).nullable().default(null),
  lines: z.array(voucherLineSchema).max(200),
  inventory: z.array(inventoryLineSchema).max(200).default([])
})
export type VoucherInputParsed = z.infer<typeof voucherInputSchema>

export const voucherTypeInputSchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum([
    'contra', 'payment', 'receipt', 'journal', 'sales',
    'purchase', 'credit_note', 'debit_note', 'stock_journal', 'physical_stock'
  ]),
  numbering: z.enum(['auto', 'manual']).default('auto'),
  prefix: z.string().trim().max(20).default('')
})
export type VoucherTypeInput = z.infer<typeof voucherTypeInputSchema>

export const periodSchema = z.object({ from: isoDate, to: isoDate })
export type Period = z.infer<typeof periodSchema>

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
  active: z.boolean().default(true)
})
export type EmployeeInput = z.infer<typeof employeeInputSchema>

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

/** Renderer-side crash report sent to the main process for logging. */
export const rendererLogSchema = z.object({
  message: z.string(),
  stack: z.string().optional(),
  componentStack: z.string().optional(),
  screen: z.string().optional()
})
export type RendererLogInput = z.infer<typeof rendererLogSchema>
