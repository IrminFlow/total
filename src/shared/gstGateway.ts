// Phase 4 (upgrade plan): the GST gateway — one way to the GST portals (IRP e-invoice, e-way bill,
// GSTN returns) behind an adapter, in main (`src/main/gstGateway/`). These are the shapes the
// renderer and main share: provider ids, the settings the renderer may see (never a secret), the
// stored return-filing state and the Zod payloads of the `gateway:*` IPC channels.
//
// 1.0 rule (owner, 7 Nov 2026): no GSP is chosen yet and there are no sandbox credentials, so the
// ONLY selectable provider is the built-in Test GSP, which simulates the official responses and
// sends nothing anywhere. The "live filing" switch exists and stays OFF — `LIVE_FILING_AVAILABLE`
// is false and `gateway:settings:set` refuses `live: true`. Real adapters plug in later.
import { z } from 'zod'

/** Providers the gateway knows. `nic-direct` is the existing NIC e-invoice client (services/nic.ts,
 *  Settings → NIC live filing — unchanged); it is not selectable for the gateway in 1.0. */
export const GATEWAY_PROVIDERS = ['test-gsp', 'nic-direct'] as const
export type GatewayProviderId = (typeof GATEWAY_PROVIDERS)[number]

/** Providers the gateway may be pointed at in this build (1.0: the Test GSP only). */
export const SELECTABLE_PROVIDERS: readonly GatewayProviderId[] = ['test-gsp']

/** The master switch "live filing" cannot be turned on in 1.0. */
export const LIVE_FILING_AVAILABLE = false

/** What a provider can do (the Test GSP: everything the plan lists; NIC direct: e-invoice + EWB). */
export interface GatewayCapabilities {
  einvoice: boolean
  ewb: boolean
  gstr1: boolean
  gstr3b: boolean
  /** GSTR-3B filing through the API (save + offset are always there when gstr3b is). */
  gstr3bFile: boolean
  gstr2b: boolean
}

/** meta `gstGateway` (no secret ever): the chosen provider, the switch and the test username. */
export interface GatewaySettings {
  provider: GatewayProviderId
  /** Always false in 1.0. */
  live: boolean
  /** The GSTN / GSP username (the portal login of the taxpayer); '' = the provider's default. */
  username: string
}

export const DEFAULT_GATEWAY_SETTINGS: GatewaySettings = { provider: 'test-gsp', live: false, username: '' }

/** What the renderer is told about the gateway. */
export interface GatewayStatus {
  settings: GatewaySettings
  /** True while results are simulated — every UI line says "test mode — nothing is sent". */
  testMode: boolean
  liveFilingAvailable: boolean
  providers: { id: GatewayProviderId; label: string; selectable: boolean; capabilities: GatewayCapabilities }[]
  /** A password is stored in the secret store for this company (never the password). */
  passwordStored: boolean
  /** A returns session (OTP sign-in) is open for this company in this app session. */
  signedIn: boolean
  /** The Test GSP's published test credentials / OTP, shown only in test mode. */
  testHints: { username: string; password: string; otp: string } | null
}

/** The forms the gateway files. */
export const GATEWAY_FORMS = ['gstr1', 'gstr3b'] as const
export type GatewayForm = (typeof GATEWAY_FORMS)[number]

/** A return's state on the portal as the gateway last saw it. */
export type GatewayReturnState = 'saved' | 'processing' | 'processed' | 'error' | 'offset' | 'filed'

export interface GatewayReturnRecord {
  provider: GatewayProviderId
  /** True for the Test GSP (simulated; nothing was sent). */
  test: boolean
  form: GatewayForm
  /** Return period MMYYYY (GSTN `ret_period`). */
  period: string
  state: GatewayReturnState
  referenceId: string | null
  arn: string | null
  filedOn: string | null
  /** The portal's error report for a save that failed processing (codes + messages). */
  errors: { code: string; message: string }[]
  savedAt: string | null
  updatedAt: string
}

/** One GSTR-2B fetch (the statement itself goes into gst2b_statements). */
export interface Gateway2bResult {
  /** MMYYYY. */
  period: string
  documents: number
  test: boolean
  /** A test fetch found a REAL statement for the month (imported from a file, or fetched from the
   *  portal) and kept it — a simulation never replaces one. */
  keptImported: boolean
  /** The statement now stored for the month (the fetched one, or the real one that was kept). */
  jsonText: string
  fileName: string | null
}

const mmyyyy = z.string().regex(/^(0[1-9]|1[0-2])\d{4}$/)
const voucherId = z.number().int().positive()

export const gatewaySettingsSchema = z
  .object({
    provider: z.enum(GATEWAY_PROVIDERS),
    live: z.boolean(),
    username: z.string().trim().max(60)
  })
  .strict()

/** Password '' = forget the stored one; omitted = keep. Never echoed back. */
export const gatewaySettingsSetSchema = gatewaySettingsSchema.extend({ password: z.string().max(200).optional() }).strict()

export const gatewayVoucherSchema = z.object({ voucherId }).strict()
export const gatewayCancelSchema = z
  .object({
    voucherId,
    reason: z.enum(['duplicate', 'data_entry_mistake', 'order_cancelled', 'other']),
    remark: z.string().max(100).optional()
  })
  .strict()
/** Extend an e-way bill (= nic:extendEwb's payload; [MASTER] reasons / modes). */
export const gatewayExtendSchema = z
  .object({
    voucherId,
    reasonCode: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(5), z.literal(99)]),
    remarks: z.string().trim().min(1).max(50),
    fromPlace: z.string().trim().min(1).max(50),
    fromStateCode: z.number().int().min(1).max(99),
    fromPincode: z.number().int().min(100000).max(999999),
    remainingDistanceKm: z.number().int().min(1).max(4000),
    transMode: z.enum(['1', '2', '3', '4', '5']),
    vehicleNo: z.string().trim().max(20).optional(),
    transDocNo: z.string().trim().max(15).optional(),
    transDocDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    transitType: z.enum(['R', 'W', 'O']).optional(),
    addressLine1: z.string().trim().max(120).optional()
  })
  .strict()
export const gatewayReturnSchema = z.object({ form: z.enum(GATEWAY_FORMS), period: mmyyyy }).strict()
export const gatewayOtpSchema = z.object({ purpose: z.enum(['signin', 'evc']), form: z.enum(GATEWAY_FORMS).optional(), period: mmyyyy.optional() }).strict()
export const gatewaySignInSchema = z.object({ otp: z.string().regex(/^\d{6}$/) }).strict()
export const gatewayFileSchema = z
  .object({ form: z.enum(GATEWAY_FORMS), period: mmyyyy, otp: z.string().regex(/^\d{6}$/) })
  .strict()
export const gateway2bSchema = z.object({ period: mmyyyy }).strict()

/** Plain copy every gateway surface shows while the Test GSP answers. */
export const TEST_MODE_NOTE = 'Test mode — nothing is sent to the GST portal.'
