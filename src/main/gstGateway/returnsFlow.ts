// GSTN returns through the gateway (Phase 4): GSTR-1 / GSTR-3B save → status → (3B: set off) →
// file with EVC (PAN + OTP) → ARN, and GSTR-2B fetch. The return's JSON is EXACTLY what the
// existing export builds (gst.gstr1 / gst.gstr3b `json`, behind the same export gate), so what is
// sent equals what "Export JSON" writes. Each state change is kept in gst_gateway_returns and
// audited (entity gst_gateway); a filing's ARN goes into meta `gstFiled` (simpleTaxes
// .recordGatewayFiling) and a fetched GSTR-2B into gst2b_statements (assistants.store2bStatement)
// — the matcher, Home and Taxes read them from there.
//
// Test mode (the Test GSP): every row says test = 1, a simulated filing is stored labelled and
// never counts as filed, a simulated 2B never replaces a statement imported from a file, and the
// GSTR-9 "as filed" snapshot is only recorded for a REAL save.
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import { AppError } from '@shared/errors'
import { todayISO } from '@shared/dates'
import type { Gateway2bResult, GatewayForm, GatewayReturnRecord, GatewayReturnState } from '@shared/gstGateway'
import * as gst from '../services/gst'
import * as gstAnnual from '../services/gstAnnual'
import { getStatement, statementSource, store2bStatement } from '../services/assistants'
import { recordGatewayFiling } from '../services/simpleTaxes'
import { writeAudit } from '../services/audit'
import { GatewayError, type ReturnsSession } from './types'
import type { OpenGateway } from './index'

/** MMYYYY → the month's first and last day. */
export function periodRange(retPeriod: string): { from: string; to: string; month: string } {
  const y = Number(retPeriod.slice(2))
  const m = Number(retPeriod.slice(0, 2))
  const month = `${y}-${String(m).padStart(2, '0')}`
  return { from: `${month}-01`, to: `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`, month }
}

interface Row {
  provider: string; test: number; form: GatewayForm; period: string; state: GatewayReturnState
  reference_id: string | null; arn: string | null; filed_on: string | null; errors_json: string; saved_at: string | null; updated_at: string
}

function rowOf(db: DB, g: Pick<OpenGateway, 'provider' | 'test'>, form: GatewayForm, period: string): Row | undefined {
  return db.prepare('SELECT * FROM gst_gateway_returns WHERE provider = ? AND test = ? AND form = ? AND period = ?').get(g.provider, g.test ? 1 : 0, form, period) as Row | undefined
}

function recordOf(r: Row): GatewayReturnRecord {
  let errors: GatewayReturnRecord['errors'] = []
  try {
    errors = JSON.parse(r.errors_json) as GatewayReturnRecord['errors']
  } catch {
    errors = []
  }
  return {
    provider: r.provider as GatewayReturnRecord['provider'], test: r.test === 1, form: r.form, period: r.period, state: r.state,
    referenceId: r.reference_id, arn: r.arn, filedOn: r.filed_on, errors, savedAt: r.saved_at, updatedAt: r.updated_at
  }
}

/** The gateway's view of a return (null = never sent through the gateway). QUERY. */
export function returnRecord(db: DB, g: Pick<OpenGateway, 'provider' | 'test'>, form: GatewayForm, period: string): GatewayReturnRecord | null {
  const r = rowOf(db, g, form, period)
  return r ? recordOf(r) : null
}

/** Insert / update the row and audit the whole before / after (an unchanged row writes nothing). */
function writeRow(db: DB, g: OpenGateway, form: GatewayForm, period: string, patch: Partial<Omit<Row, 'provider' | 'test' | 'form' | 'period' | 'updated_at'>>): GatewayReturnRecord {
  const before = rowOf(db, g, form, period)
  const merged = {
    state: patch.state ?? before?.state ?? 'saved',
    reference_id: patch.reference_id !== undefined ? patch.reference_id : before?.reference_id ?? null,
    arn: patch.arn !== undefined ? patch.arn : before?.arn ?? null,
    filed_on: patch.filed_on !== undefined ? patch.filed_on : before?.filed_on ?? null,
    errors_json: patch.errors_json ?? before?.errors_json ?? '[]',
    saved_at: patch.saved_at !== undefined ? patch.saved_at : before?.saved_at ?? null
  }
  const same = before && before.state === merged.state && before.reference_id === merged.reference_id && before.arn === merged.arn &&
    before.filed_on === merged.filed_on && before.errors_json === merged.errors_json && before.saved_at === merged.saved_at
  if (same) return recordOf(before)
  db.transaction(() => {
    db.prepare(
      `INSERT INTO gst_gateway_returns (provider, test, form, period, state, reference_id, arn, filed_on, errors_json, saved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, test, form, period) DO UPDATE SET state = excluded.state, reference_id = excluded.reference_id, arn = excluded.arn,
         filed_on = excluded.filed_on, errors_json = excluded.errors_json, saved_at = excluded.saved_at,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
    ).run(g.provider, g.test ? 1 : 0, form, period, merged.state, merged.reference_id, merged.arn, merged.filed_on, merged.errors_json, merged.saved_at)
    const after = rowOf(db, g, form, period)!
    const facts = (r: Row | undefined): Record<string, unknown> | null =>
      r ? { provider: r.provider, test: r.test === 1, form: r.form, period: r.period, state: r.state, referenceId: r.reference_id, arn: r.arn, filedOn: r.filed_on, errors: JSON.parse(r.errors_json) as unknown } : null
    const id = (db.prepare('SELECT id FROM gst_gateway_returns WHERE provider = ? AND test = ? AND form = ? AND period = ?').get(g.provider, g.test ? 1 : 0, form, period) as { id: number }).id
    writeAudit(db, 'gst_gateway', id, before ? 'update' : 'create', facts(before), facts(after))
  })()
  return recordOf(rowOf(db, g, form, period)!)
}

function needSession(g: OpenGateway): ReturnsSession {
  const s = g.session()
  if (!s) throw new GatewayError('Sign in to the GST portal with the OTP first', ['OTP_REQUIRED'], 'otp_required')
  return s
}

function needRegular(company: CompanyInfo): void {
  if (company.gstRegistrationType !== 'regular') throw new AppError('gst_filed_not_regular', 'Only a regular GST registration files GSTR-1 and GSTR-3B.')
}

/** A return is filed after its period: refused locally for a month that has not ended. */
function needPeriodOver(retPeriod: string, today: string): void {
  if (periodRange(retPeriod).to >= today) throw new AppError('gateway_period_open', 'This month is not over yet, so its return can’t be filed.', { field: 'period' })
}

// ---------- sign-in ----------

/** OTPREQUEST: the portal sends the sign-in OTP (the Test GSP: always its published test OTP). */
export async function requestSignInOtp(g: OpenGateway): Promise<{ sent: true }> {
  await g.adapter.requestOtp(g.who)
  return { sent: true }
}

/** AUTHTOKEN with the OTP → a returns session kept in memory for this app session. */
export async function signIn(g: OpenGateway, otp: string): Promise<{ signedIn: true; expiresAt: number }> {
  const s = await g.adapter.signIn(g.who, otp)
  g.keepSession(s)
  return { signedIn: true, expiresAt: s.expiresAt }
}

// ---------- GSTR-1 / GSTR-3B ----------

/** The return's JSON — the export's, behind the export's own gate (blocking issues refuse it). */
function returnJson(db: DB, company: CompanyInfo, form: GatewayForm, retPeriod: string): Record<string, unknown> {
  const { from, to } = periodRange(retPeriod)
  gst.assertExportable(db, company, from, to)
  return form === 'gstr1' ? gst.gstr1(db, company, from, to, retPeriod).json : gst.gstr3b(db, company, from, to, retPeriod).json
}

/** RETSAVE: send the return's JSON; keeps the reference id (state saved). */
export async function saveReturn(db: DB, company: CompanyInfo, g: OpenGateway, form: GatewayForm, retPeriod: string): Promise<GatewayReturnRecord> {
  needRegular(company)
  const prior = rowOf(db, g, form, retPeriod)
  if (prior?.state === 'filed') throw new AppError('gateway_already_filed', `This ${form === 'gstr1' ? 'GSTR-1' : 'GSTR-3B'} is already filed.`)
  const data = returnJson(db, company, form, retPeriod)
  const s = needSession(g)
  const res = await g.adapter.saveReturn(g.who, s, form, retPeriod, data)
  if (!g.test) {
    // A real save is what was sent to the portal: the GSTR-9 "as filed" side, as an export records it.
    const { from, to } = periodRange(retPeriod)
    if (form === 'gstr1') gstAnnual.recordGstr1Export(db, retPeriod, data)
    else gstAnnual.recordGstr3bExport(db, retPeriod, gst.gstr3b(db, company, from, to, retPeriod))
  }
  return writeRow(db, g, form, retPeriod, { state: 'saved', reference_id: res.reference_id, errors_json: '[]', saved_at: new Date(g.now()).toISOString() })
}

/** RETSTATUS of the last save: processing / processed / error (with the portal's error report). */
export async function refreshReturnStatus(db: DB, g: OpenGateway, form: GatewayForm, retPeriod: string): Promise<GatewayReturnRecord> {
  const prior = rowOf(db, g, form, retPeriod)
  if (!prior?.reference_id) throw new AppError('gateway_not_saved', 'Send the return to the portal first.')
  if (prior.state === 'filed' || prior.state === 'offset') return recordOf(prior)
  const s = needSession(g)
  const st = await g.adapter.returnStatus(g.who, s, form, retPeriod, prior.reference_id)
  const state: GatewayReturnState = st.status_cd === 'IP' ? 'processing' : st.status_cd === 'P' ? 'processed' : 'error'
  const errors = st.error_report.map((e) => ({ code: e.error_cd, message: e.error_msg }))
  return writeRow(db, g, form, retPeriod, { state, errors_json: JSON.stringify(errors) })
}

/** GSTR-3B: set the liability off. The figures are gstr3b()'s (credit used = liability − cash
 *  payable on the normal heads; cash = that cash + reverse charge), in paise — the adapter maps them
 *  onto its provider's request (the official offset request layout is UNVERIFIED, sources.ts). */
export async function offsetLiability(db: DB, company: CompanyInfo, g: OpenGateway, retPeriod: string): Promise<GatewayReturnRecord> {
  needRegular(company)
  const prior = rowOf(db, g, 'gstr3b', retPeriod)
  if (prior?.state !== 'processed') throw new AppError('gateway_not_processed', 'The saved GSTR-3B must be processed by the portal before the liability is set off.')
  const { from, to } = periodRange(retPeriod)
  const r = gst.gstr3b(db, company, from, to, retPeriod)
  const heads = ['igst', 'cgst', 'sgst', 'cess'] as const
  const liability = { igst: r.outward.igst + r.zeroRated.igst, cgst: r.outward.cgst, sgst: r.outward.sgst, cess: r.outward.cess + r.zeroRated.cess }
  const creditUsed = Object.fromEntries(heads.map((h) => [h, Math.max(0, liability[h] - r.netPayable[h])]))
  const cash = Object.fromEntries(heads.map((h) => [h, r.netPayable[h] + r.rcmPayable[h]]))
  const s = needSession(g)
  await g.adapter.offsetLiability(g.who, s, retPeriod, { gstin: r.gstin, ret_period: retPeriod, creditUsedPaise: creditUsed, cashPaise: cash })
  return writeRow(db, g, 'gstr3b', retPeriod, { state: 'offset' })
}

/** EVC: ask the portal for the filing OTP (the return must be ready to file). */
export async function requestEvcOtp(db: DB, company: CompanyInfo, g: OpenGateway, form: GatewayForm, retPeriod: string, today = todayISO()): Promise<{ sent: true }> {
  needRegular(company)
  needPeriodOver(retPeriod, today)
  const prior = rowOf(db, g, form, retPeriod)
  const ready = form === 'gstr1' ? prior?.state === 'processed' : prior?.state === 'offset'
  if (!ready) throw new AppError('gateway_not_ready', form === 'gstr1' ? 'Send the GSTR-1 and wait until the portal has processed it.' : 'Send the GSTR-3B, let it process and set off the liability first.')
  await g.adapter.requestEvcOtp(g.who, needSession(g), form, retPeriod)
  return { sent: true }
}

/** "dd-MM-yyyy" → ISO date; anything else → today. */
function isoFiled(s: string | undefined, today: string): string {
  const m = s ? /^(\d{2})-(\d{2})-(\d{4})$/.exec(s) : null
  return m ? `${m[3]}-${m[2]}-${m[1]}` : today
}

/** RETFILE with EVC (the PAN of the GSTIN + the OTP) → the ARN, kept on the return and in meta
 *  `gstFiled` (a Test GSP filing labelled and never counted as filed). */
export async function fileReturn(
  db: DB, company: CompanyInfo, g: OpenGateway, form: GatewayForm, retPeriod: string, otp: string, user: string | null, today = todayISO()
): Promise<GatewayReturnRecord> {
  needRegular(company)
  needPeriodOver(retPeriod, today)
  const prior = rowOf(db, g, form, retPeriod)
  if (prior?.state === 'filed') return recordOf(prior)
  const ready = form === 'gstr1' ? prior?.state === 'processed' : prior?.state === 'offset'
  if (!ready) throw new AppError('gateway_not_ready', 'This return is not ready to file yet.')
  const res = await g.adapter.fileReturn(g.who, needSession(g), form, retPeriod, { pan: g.who.gstin.slice(2, 12), otp })
  const arn = String(res.ack_num ?? '').toUpperCase()
  if (!/^[A-Z0-9]{10,20}$/.test(arn)) throw new GatewayError('The portal returned no valid ARN')
  const filedOn = isoFiled(res.filed_on, today)
  return db.transaction(() => {
    const rec = writeRow(db, g, form, retPeriod, { state: 'filed', arn, filed_on: filedOn })
    recordGatewayFiling(db, { month: periodRange(retPeriod).month, form, arn, date: filedOn, provider: g.provider, test: g.test }, user)
    return rec
  })()
}

// ---------- GSTR-2B ----------

/** Fetch a month's GSTR-2B into gst2b_statements (source gateway / gateway-test), where the WP 3.4
 *  matcher, the mismatch assistant, Home and Taxes read it. A test fetch never replaces a
 *  statement imported from a file (`keptImported`). */
export async function fetchGstr2b(db: DB, g: OpenGateway, retPeriod: string, user: string | null): Promise<Gateway2bResult> {
  const s = needSession(g)
  const imported = getStatement(db, retPeriod) && statementSource(db, retPeriod) === null
  if (g.test && imported) {
    const kept = getStatement(db, retPeriod)!
    return { period: retPeriod, documents: kept.documents, test: true, keptImported: true, jsonText: kept.jsonText, fileName: kept.fileName }
  }
  const { json } = await g.adapter.fetchGstr2b(g.who, s, retPeriod)
  const label = g.test ? `GSTR-2B ${retPeriod} (Test GSP — simulated)` : `GSTR-2B ${retPeriod} (from the GST portal)`
  const info = store2bStatement(db, { jsonText: json, fileName: label, period: periodRange(retPeriod).month, source: g.test ? 'gateway-test' : 'gateway' }, user)
  return { period: info.period, documents: info.documents, test: g.test, keptImported: false, jsonText: json, fileName: label }
}
