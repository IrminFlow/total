// The GST gateway (Phase 4 of the upgrade plan) — the ONE way to the GST portals from main:
//
//   index.ts        settings (meta `gstGateway`, no secret), the provider choice, the password in
//                   the secret store (companyScope(slug)), the returns sessions, `openGateway`
//   types.ts        the adapter contract + GatewayError
//   testGsp.ts      the built-in Test GSP (simulates the portals; sends nothing)
//   nicAdapter.ts   the NIC e-invoice client (services/nic.ts) as an adapter
//   edocFlow.ts     IRN / e-way bill flows (validate → adapter → store + audit)
//   returnsFlow.ts  GSTR-1 / 3B save → status → (offset) → file, GSTR-2B fetch
//   sources.ts      the official sources of every call + what is UNVERIFIED
//
// 1.0 (owner, 7 Nov 2026): no GSP chosen, no sandbox credentials — the only selectable provider is
// the Test GSP and the "live filing" switch cannot be turned on (LIVE_FILING_AVAILABLE). Real
// adapters are plug-ins later: they register in `adapterFor` and become selectable once live
// filing ships. Settings → NIC live filing (services/nic.ts) is unchanged and separate.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import {
  DEFAULT_GATEWAY_SETTINGS, GATEWAY_PROVIDERS, LIVE_FILING_AVAILABLE, SELECTABLE_PROVIDERS, gatewaySettingsSchema,
  type GatewayProviderId, type GatewaySettings, type GatewayStatus
} from '@shared/gstGateway'
import { extractPurchaseDocs } from '../services/gst'
import { writeAudit } from '../services/audit'
import { companyScope, type SecretStore } from '../services/secrets'
import { appSecretStore } from '../services/secretStore'
import { TEST_STORE, VOUCHER_STORE, type EdocCall, type EdocStore } from './edocFlow'
import { createTestGsp, memoryTestGspState, TEST_GSP_OTP, TEST_GSP_PASSWORD, TEST_GSP_USERNAME, type SimulatedInwardDoc } from './testGsp'
import { GatewayError, type GatewayIdentity, type GstGatewayAdapter, type ReturnsSession } from './types'

export { GatewayError } from './types'

const META_KEY = 'gstGateway'
const PASSWORD_SECRET = 'gstGateway.password'

export function readGatewaySettings(db: DB): GatewaySettings {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(META_KEY) as { value: string } | undefined
  if (!row) return { ...DEFAULT_GATEWAY_SETTINGS }
  try {
    const p = gatewaySettingsSchema.safeParse(JSON.parse(row.value))
    // A stored `live: true` (impossible in 1.0) or a provider this build can't select reads as the default.
    if (!p.success || (p.data.live && !LIVE_FILING_AVAILABLE) || !SELECTABLE_PROVIDERS.includes(p.data.provider)) return { ...DEFAULT_GATEWAY_SETTINGS }
    return p.data
  } catch {
    return { ...DEFAULT_GATEWAY_SETTINGS }
  }
}

const passwordOf = (slug: string, store: SecretStore): string => {
  if (!store.available()) return ''
  try {
    return store.get(companyScope(slug), PASSWORD_SECRET) ?? ''
  } catch {
    return ''
  }
}

const CAPS: Record<GatewayProviderId, GatewayStatus['providers'][number]['capabilities']> = {
  'test-gsp': { einvoice: true, ewb: true, gstr1: true, gstr3b: true, gstr3bFile: true, gstr2b: true },
  'nic-direct': { einvoice: true, ewb: true, gstr1: false, gstr3b: false, gstr3bFile: false, gstr2b: false }
}
const LABELS: Record<GatewayProviderId, string> = {
  'test-gsp': 'Test GSP (built in — simulates the portal, sends nothing)',
  'nic-direct': 'NIC e-invoice API (direct) — Settings → NIC live filing'
}

// ---------- returns sessions (in memory, per company + provider + login) ----------

const sessions = new Map<string, ReturnsSession>()
const sessionKey = (slug: string, provider: string, username: string): string => JSON.stringify([slug, provider, username])

/** Forget every returns session (company switch / close, settings change). */
export function resetGatewaySessions(): void {
  sessions.clear()
  testPortals.clear()
}

export function gatewayStatus(db: DB, slug: string, store: SecretStore = appSecretStore(), now = Date.now()): GatewayStatus {
  const settings = readGatewaySettings(db)
  const s = sessions.get(sessionKey(slug, settings.provider, settings.username))
  const testMode = settings.provider === 'test-gsp'
  return {
    settings,
    testMode,
    liveFilingAvailable: LIVE_FILING_AVAILABLE,
    providers: GATEWAY_PROVIDERS.map((id) => ({ id, label: LABELS[id], selectable: SELECTABLE_PROVIDERS.includes(id), capabilities: CAPS[id] })),
    passwordStored: passwordOf(slug, store) !== '',
    signedIn: !!s && s.expiresAt > now,
    testHints: testMode ? { username: TEST_GSP_USERNAME, password: TEST_GSP_PASSWORD, otp: TEST_GSP_OTP } : null
  }
}

/** Owner: choose the provider / username / password. `live: true` and any provider this build
 *  can't select are refused; the password goes to the secret store, never the company DB, and is
 *  audited by presence only. An unchanged save writes nothing. */
export function setGatewaySettings(
  db: DB, slug: string, input: GatewaySettings & { password?: string }, store: SecretStore = appSecretStore()
): GatewayStatus {
  if (input.live && !LIVE_FILING_AVAILABLE) {
    throw new AppError('gateway_live_unavailable', 'Live filing is not available in this version — only test mode (nothing is sent to the GST portal).', { field: 'live' })
  }
  if (!SELECTABLE_PROVIDERS.includes(input.provider)) {
    throw new AppError('gateway_provider_unavailable', 'Only the built-in Test GSP can be chosen in this version.', { field: 'provider' })
  }
  const before = readGatewaySettings(db)
  const next: GatewaySettings = { provider: input.provider, live: input.live, username: input.username.trim() }
  const hadPassword = passwordOf(slug, store) !== ''
  const passwordChange = input.password !== undefined && input.password !== passwordOf(slug, store)
  const settingsChange = JSON.stringify(before) !== JSON.stringify(next)
  if (!settingsChange && !passwordChange) return gatewayStatus(db, slug, store)
  // Secret first: if the store can't encrypt, nothing else changes.
  if (passwordChange) {
    if (input.password) store.set(companyScope(slug), PASSWORD_SECRET, input.password)
    else store.delete(companyScope(slug), PASSWORD_SECRET)
  }
  db.transaction(() => {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(META_KEY, JSON.stringify(next))
    writeAudit(db, 'gst_gateway', 0, 'update', { settings: before, passwordStored: hadPassword }, { settings: next, passwordStored: passwordChange ? !!input.password : hadPassword })
  })()
  resetGatewaySessions()
  return gatewayStatus(db, slug, store)
}

// ---------- the Test GSP: one simulator per company for this app session ----------
//
// Its "portal" memory (issued IRNs, e-way bills, saved returns, OTPs) and its rate limiter live in
// memory, never in the company file — the simulator writes nothing to the books. Forgotten when the
// company closes (resetGatewaySessions), like a sandbox reset.

interface TestPortal { adapter: GstGatewayAdapter; db: { current: DB } }
const testPortals = new Map<string, TestPortal>()

function testPortalFor(slug: string, db: DB, now: () => number): GstGatewayAdapter {
  const existing = testPortals.get(slug)
  if (existing) {
    existing.db.current = db
    return existing.adapter
  }
  const ref = { current: db }
  const adapter = createTestGsp({ state: memoryTestGspState(), now, inwardFor: (_gstin, period) => simulatedInward(ref.current, period) })
  testPortals.set(slug, { adapter, db: ref })
  return adapter
}

/** What the Test GSP's simulated GSTR-2B shows for a month: the company's own purchase bills from
 *  suppliers with a GSTIN (a debit note to a supplier = their credit note), as booked. */
export function simulatedInward(db: DB, retPeriod: string): SimulatedInwardDoc[] {
  const y = Number(retPeriod.slice(2))
  const m = Number(retPeriod.slice(0, 2))
  const from = `${y}-${String(m).padStart(2, '0')}-01`
  const to = `${y}-${String(m).padStart(2, '0')}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`
  return extractPurchaseDocs(db, from, to)
    .filter((d) => !!d.partyGstin)
    .map((d) => ({
      supplierGstin: d.partyGstin!.toUpperCase(),
      supplierName: d.partyName ?? '',
      kind: d.kind === 'debit_note' ? 'credit_note' as const : 'invoice' as const,
      number: d.supplierRef || d.number,
      date: d.date,
      value: d.invoiceValue,
      taxable: d.taxable,
      igst: d.igst,
      cgst: d.cgst,
      sgst: d.sgst,
      cess: d.cess,
      reverseCharge: false
    }))
}

export interface OpenGateway extends EdocCall {
  /** The Test GSP answered (simulated; nothing sent). */
  test: boolean
  provider: GatewayProviderId
  slug: string
  /** The open returns session for this company + provider + login, if any. */
  session(): ReturnsSession | null
  keepSession(s: ReturnsSession): void
}

export interface GatewayDeps {
  store?: SecretStore
  now?: () => number
  /** Tests: another adapter (e.g. the Test GSP with a low rate limit, or a fake real one). */
  adapter?: GstGatewayAdapter
}

/** The gateway for the open company: the selected adapter, who calls and where answers go. */
export function openGateway(db: DB, slug: string, company: CompanyInfo, deps: GatewayDeps = {}): OpenGateway {
  if (!company.gstin) throw new GatewayError('Company GSTIN is missing — set it in Company settings', [], 'config')
  const settings = readGatewaySettings(db)
  const now = deps.now ?? Date.now
  const store = deps.store ?? appSecretStore()
  const adapter = deps.adapter ?? testPortalFor(slug, db, now)
  const who: GatewayIdentity = { gstin: company.gstin.toUpperCase(), username: settings.username, password: passwordOf(slug, store) }
  const edocStore: EdocStore = adapter.test ? TEST_STORE : VOUCHER_STORE
  const key = sessionKey(slug, adapter.id, settings.username)
  return {
    adapter, who, store: edocStore, now, test: adapter.test, provider: adapter.id, slug,
    session: () => {
      const s = sessions.get(key)
      return s && s.expiresAt > now() ? s : null
    },
    keepSession: (s) => sessions.set(key, s)
  }
}
