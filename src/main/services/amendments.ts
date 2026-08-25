import { writeFileSync } from 'fs'
import { join } from 'path'
import type { DB } from '../db/connection'
import type { CompanyInfo } from '@shared/domain'
import type { GstDoc } from '@shared/gst/returns'
import {
  buildAmendmentTables,
  diffForAmendment,
  periodOrder,
  type AmendmentChange,
  type AmendmentPair,
  type AmendmentTables
} from '@shared/gst/amendments'
import { extractOutwardDocs } from './gst'
import { companyExportsDir } from '../paths'

/**
 * GSTR-1 amendment tables (roadmap D-101), the service half.
 *
 * The rules live in src/shared/gst/amendments.ts. What can only happen here is remembering what
 * the return SAID. Once a filed invoice is corrected, the books hold the correction and nothing
 * else — the original particulars, which are the portal's match key for a 9A/9C row, are gone.
 * So the document set is snapshotted into `gstr1_filed_documents` at the moment a GSTR-1 is
 * marked filed, and every amendment is a diff of today's books against that snapshot.
 *
 * Statutory basis, checked 2026-08-25 against the CGST Act and the GSTR-1 tables as published:
 * section 37(3) permits rectification of a furnished return's particulars in a LATER return
 * (not by re-filing the earlier one), up to the 30 November following the end of the financial
 * year or the annual return, whichever is earlier. Tables 9A (amended B2B / B2CL / export
 * invoices) and 9C (amended credit/debit notes) are where those rectifications go. The section
 * 37(3) time limit is NOT enforced here — see `withinRectificationWindow` below, which reports
 * it rather than blocking, because the portal is the authority on whether a window is still
 * open and refusing an export the portal would have accepted is its own kind of wrong.
 */

/** vt.kind ⇄ the doc_type stored alongside the snapshot (mirrors edocs.docTypeFor). */
function docTypeOf(kind: GstDoc['kind']): 'INV' | 'CRN' | 'DBN' {
  if (kind === 'credit_note') return 'CRN'
  if (kind === 'debit_note') return 'DBN'
  return 'INV'
}

/**
 * The portal tax period ('MMYYYY') a filing period key ('2026-04', '2026-Q1') belongs to.
 *
 * A quarterly GSTR-1 is filed on the portal under the LAST month of the quarter, so the end of
 * the period's date range is the right month for both frequencies — and it keeps the amendment
 * ordering ("was this filed before the period I am amending in?") comparable across a filer who
 * switched frequency mid-year.
 */
export function portalPeriodOf(periodEndIso: string): string {
  const [y, m] = periodEndIso.split('-')
  return `${m}${y}`
}

export interface Gstr1SnapshotResult {
  /** Portal tax period 'MMYYYY' the snapshot is keyed by. */
  period: string
  /** Documents written by THIS call (0 when an earlier snapshot already stood). */
  written: number
  /** Documents the period's snapshot holds now. */
  docs: number
  /** True when a snapshot already existed and was left exactly as it was. */
  keptExisting: boolean
}

/**
 * Freeze the period's outward documents as the return that was filed.
 *
 * IDEMPOTENCE — the FIRST snapshot wins, and re-marking a period filed changes nothing.
 * The alternative (merge, or overwrite) is worse in both directions: overwriting makes every
 * amendment vanish the moment somebody re-enters the ARN, and merging would quietly insert a
 * document ADDED after filing as though it had been filed, which is exactly the case that must
 * stay visible. Deliberately NOT silent — the count of documents already held comes back so the
 * caller can say "the snapshot from the original filing was kept".
 *
 * The way to legitimately re-take a snapshot is to clear the filing (which drops it — see
 * `dropGstr1Snapshot`) and mark it filed again, which is the same act on the portal too.
 */
export function snapshotGstr1(
  db: DB,
  company: CompanyInfo,
  periodEndIso: string,
  from: string,
  to: string,
  filedAt: string
): Gstr1SnapshotResult {
  const period = portalPeriodOf(periodEndIso)
  const existing = db
    .prepare('SELECT COUNT(*) AS n FROM gstr1_filed_documents WHERE period = ?')
    .get(period) as { n: number }
  if (existing.n > 0) return { period, written: 0, docs: existing.n, keptExisting: true }

  const docs = extractOutwardDocs(db, company, from, to)
  const stmt = db.prepare(
    `INSERT INTO gstr1_filed_documents
       (period, voucher_id, doc_number, doc_date, doc_type, party_gstin, pos, payload, filed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (period, doc_number, doc_type) DO NOTHING`
  )
  const write = db.transaction((list: GstDoc[]) => {
    for (const d of list) {
      stmt.run(
        period,
        d.voucherId,
        d.number,
        d.date,
        docTypeOf(d.kind),
        d.partyGstin,
        d.pos,
        JSON.stringify(d),
        filedAt
      )
    }
  })
  write(docs)

  const after = db
    .prepare('SELECT COUNT(*) AS n FROM gstr1_filed_documents WHERE period = ?')
    .get(period) as { n: number }
  return { period, written: after.n, docs: after.n, keptExisting: false }
}

/**
 * Forget a period's snapshot, because the filing behind it was cleared.
 *
 * A return that is no longer marked filed has not been filed, and diffing against a snapshot of
 * one would invent amendments to a return the portal has never seen.
 */
export function dropGstr1Snapshot(db: DB, periodEndIso: string): number {
  const period = portalPeriodOf(periodEndIso)
  const r = db.prepare('DELETE FROM gstr1_filed_documents WHERE period = ?').run(period)
  return r.changes
}

interface SnapshotRow {
  id: number
  period: string
  voucherId: number | null
  docNumber: string
  docDate: string
  docType: string
  payload: string
  filedAt: string
}

export interface FiledPeriodInfo {
  /** 'MMYYYY'. */
  period: string
  filedAt: string
  docs: number
  /** Whether this period is earlier than the one being amended (only those can be amended). */
  earlier: boolean
}

/** One amendment row, with the plain-language account of what moved. */
export interface AmendmentRowInfo {
  table: 'b2ba' | 'b2cla' | 'cdnra' | 'cdnura'
  originalPeriod: string
  originalNumber: string
  originalDate: string
  originalGstin: string | null
  number: string
  date: string
  partyName: string | null
  partyGstin: string | null
  pos: string
  invoiceValue: number
  voucherId: number
  changes: AmendmentChange[]
}

/** A document that was in the filed return and is no longer in the books. */
export interface DeletedFiledDoc {
  originalPeriod: string
  number: string
  date: string
  partyGstin: string | null
  invoiceValue: number
  voucherId: number | null
  message: string
}

/** A document dated inside a filed period that the filed return does not contain. */
export interface AddedAfterFilingDoc {
  originalPeriod: string
  number: string
  date: string
  voucherId: number
  invoiceValue: number
  message: string
}

export interface AmendmentReport {
  /** Portal tax period 'MMYYYY' the amendments would be filed in. */
  period: string
  filedPeriods: FiledPeriodInfo[]
  /** True when no earlier period has ever been marked filed — nothing to amend AGAINST. */
  noSnapshots: boolean
  tables: AmendmentTables
  rows: AmendmentRowInfo[]
  deleted: DeletedFiledDoc[]
  addedAfterFiling: AddedAfterFilingDoc[]
  /** Portal-shaped JSON for the amendment tables, or null when there is nothing to file. */
  json: Record<string, unknown> | null
  counts: { amended: number; unchanged: number; rejected: number }
}

/** The emitted-table shapes, only so a built row can be traced back to the pair that made it. */
interface EmittedInvGroup { inv: { oinum: string; oidt: string }[] }
interface EmittedNtGroup { nt: { ont_num: string; ont_dt: string }[] }
interface EmittedFlatNote { ont_num: string; ont_dt: string }

/**
 * Amendment tables for a period, against every earlier GSTR-1 that was marked filed.
 *
 * The pairing is by VOUCHER ID, not by document number: a document number is itself an amendable
 * particular (a corrected invoice can be renumbered), and matching on it would read a renumbered
 * invoice as one document deleted and another added.
 */
export function gstr1Amendments(db: DB, company: CompanyInfo, period: string): AmendmentReport {
  const order = periodOrder(period)
  const snapshots = db
    .prepare(
      `SELECT id, period, voucher_id AS voucherId, doc_number AS docNumber, doc_date AS docDate,
              doc_type AS docType, payload, filed_at AS filedAt
       FROM gstr1_filed_documents ORDER BY period, id`
    )
    .all() as SnapshotRow[]

  const byPeriod = new Map<string, SnapshotRow[]>()
  for (const row of snapshots) {
    byPeriod.set(row.period, [...(byPeriod.get(row.period) ?? []), row])
  }
  const filedPeriods: FiledPeriodInfo[] = [...byPeriod.entries()]
    .map(([p, rows]) => ({
      period: p,
      filedAt: rows[0]!.filedAt,
      docs: rows.length,
      earlier: periodOrder(p) < order
    }))
    .sort((a, b) => periodOrder(a.period) - periodOrder(b.period))

  const earlier = filedPeriods.filter((p) => p.earlier)
  const empty: AmendmentReport = {
    period,
    filedPeriods,
    noSnapshots: earlier.length === 0,
    tables: { b2ba: [], b2cla: [], cdnra: [], cdnura: [], rejected: [] },
    rows: [],
    deleted: [],
    addedAfterFiling: [],
    json: null,
    counts: { amended: 0, unchanged: 0, rejected: 0 }
  }
  if (earlier.length === 0) return empty

  // The whole book, deliberately: a corrected voucher's DATE is one of the particulars an
  // amendment restates, so a re-dated invoice can sit anywhere. Bounding this to the filed
  // period's own dates would report such an invoice as deleted from the return and missing from
  // the books — a much worse answer than one slow query on a panel nobody opens twice a minute.
  const todayDocs = extractOutwardDocs(db, company, '0000-01-01', '9999-12-31')
  const byVoucher = new Map<number, GstDoc>()
  for (const d of todayDocs) byVoucher.set(d.voucherId, d)

  // Reading the bin on purpose: "the voucher behind a filed document is gone" is precisely the
  // question here, and IN_BOOKS would make a deleted voucher indistinguishable from one that
  // never existed.
  const voucherStmt = db.prepare(
    'SELECT id, deleted_at AS deletedAt FROM vouchers WHERE id = ?'
  )

  const pairs: AmendmentPair[] = []
  const pairMeta = new Map<string, { originalPeriod: string; doc: GstDoc; original: GstDoc }>()
  const deleted: DeletedFiledDoc[] = []
  let unchanged = 0

  for (const p of earlier) {
    for (const row of byPeriod.get(p.period) ?? []) {
      const original = JSON.parse(row.payload) as GstDoc
      const revised = row.voucherId != null ? byVoucher.get(row.voucherId) : undefined
      if (!revised) {
        const v = row.voucherId != null
          ? (voucherStmt.get(row.voucherId) as { id: number; deletedAt: string | null } | undefined)
          : undefined
        deleted.push({
          originalPeriod: p.period,
          number: original.number,
          date: original.date,
          partyGstin: original.partyGstin,
          invoiceValue: original.invoiceValue,
          voucherId: row.voucherId,
          // No GSTR-1 table deletes a filed document. Section 34 credit note, or an amendment
          // that restates it — and neither can be invented from an absent voucher, so this is
          // reported for a human rather than turned into a row.
          message:
            `${original.number} dated ${original.date} was filed in ${p.period} and is ` +
            `${v && v.deletedAt ? 'now in the bin' : 'no longer an outward document in the books'}. ` +
            'A filed document cannot be withdrawn: issue a credit note under section 34 for the ' +
            'value, or restore the voucher and correct it so it can be amended in Table 9A/9C.'
        })
        continue
      }
      if (!diffForAmendment(original, revised).hasChange) unchanged++
      pairs.push({ original, revised, originalPeriod: p.period })
      pairMeta.set(`${original.partyGstin ?? ''}|${original.number}|${original.date}`, {
        originalPeriod: p.period,
        doc: revised,
        original
      })
    }
  }

  const tables = buildAmendmentTables({ pairs, companyState: company.stateCode, period })

  // Which table each pair landed in, derived from what the engine actually emitted rather than
  // from a second copy of its placement rules — a copy would eventually disagree with the file
  // being uploaded, and the screen would explain the wrong thing.
  const rows: AmendmentRowInfo[] = []
  const addRow = (
    table: AmendmentRowInfo['table'],
    oinum: string,
    oidtPortal: string
  ): void => {
    const oidt = oidtPortal.split('-').reverse().join('-') // portal DD-MM-YYYY → ISO
    for (const [key, meta] of pairMeta) {
      const [, num, date] = key.split('|')
      if (num !== oinum || date !== oidt) continue
      const diff = diffForAmendment(meta.original, meta.doc)
      rows.push({
        table,
        originalPeriod: meta.originalPeriod,
        originalNumber: meta.original.number,
        originalDate: meta.original.date,
        originalGstin: meta.original.partyGstin,
        number: meta.doc.number,
        date: meta.doc.date,
        partyName: meta.doc.partyName,
        partyGstin: meta.doc.partyGstin,
        pos: meta.doc.pos,
        invoiceValue: meta.doc.invoiceValue,
        voucherId: meta.doc.voucherId,
        changes: diff.changes
      })
      return
    }
  }
  for (const g of tables.b2ba as EmittedInvGroup[]) for (const inv of g.inv) addRow('b2ba', inv.oinum, inv.oidt)
  for (const g of tables.b2cla as EmittedInvGroup[]) for (const inv of g.inv) addRow('b2cla', inv.oinum, inv.oidt)
  for (const g of tables.cdnra as EmittedNtGroup[]) for (const nt of g.nt) addRow('cdnra', nt.ont_num, nt.ont_dt)
  for (const n of tables.cdnura as EmittedFlatNote[]) addRow('cdnura', n.ont_num, n.ont_dt)

  // A document dated inside a filed period that the filed return does not contain was never
  // filed, so it is NOT an amendment: a missed invoice is reported in the ordinary tables of the
  // return it is being included in (Table 4/5/6/9B of this period). Surfaced so it is not
  // mistaken for a missing amendment row.
  const snapshotVoucherIds = new Set(
    snapshots.filter((s) => s.voucherId != null).map((s) => s.voucherId as number)
  )
  const addedAfterFiling: AddedAfterFilingDoc[] = []
  for (const p of earlier) {
    const month = `${p.period.slice(2)}-${p.period.slice(0, 2)}`
    for (const d of todayDocs) {
      if (snapshotVoucherIds.has(d.voucherId)) continue
      // Monthly filers only: a quarterly snapshot covers three months and its period key names
      // the last of them, so this test would call the first two months "added after filing".
      // VERIFY: quarterly (QRMP) periods are deliberately not scanned for missed documents.
      if (!d.date.startsWith(month)) continue
      addedAfterFiling.push({
        originalPeriod: p.period,
        number: d.number,
        date: d.date,
        voucherId: d.voucherId,
        invoiceValue: d.invoiceValue,
        message:
          `${d.number} is dated in ${p.period}, which has been filed, but it was not in that ` +
          'return. A document that was never filed is not amendable — report it in the ordinary ' +
          'tables of the return you are filing now.'
      })
    }
  }

  const json = amendmentJson(company.gstin ?? '', period, tables)
  return {
    period,
    filedPeriods,
    noSnapshots: false,
    tables,
    rows,
    deleted,
    addedAfterFiling,
    json,
    counts: { amended: rows.length, unchanged, rejected: tables.rejected.length }
  }
}

/**
 * Portal-shaped JSON carrying only the amendment tables.
 *
 * The header mirrors what buildGstr1 emits (gstin / fp / version / hash) so the file is the same
 * shape the offline tool reads, and empty tables are omitted rather than sent as `[]` — the same
 * rule the ordinary GSTR-1 export follows.
 *
 * // VERIFY: whether the portal's offline utility accepts an amendment-only upload alongside a
 * separately uploaded ordinary GSTR-1 for the same period, or expects one merged file. Both have
 * worked at different schema versions; check before relying on the split.
 */
export function amendmentJson(
  gstin: string,
  period: string,
  tables: AmendmentTables
): Record<string, unknown> | null {
  const json: Record<string, unknown> = {
    gstin,
    fp: period,
    version: 'GST3.2.1',
    hash: 'hash'
  }
  let any = false
  if (tables.b2ba.length) { json.b2ba = tables.b2ba; any = true }
  if (tables.b2cla.length) { json.b2cla = tables.b2cla; any = true }
  if (tables.cdnra.length) { json.cdnra = tables.cdnra; any = true }
  if (tables.cdnura.length) { json.cdnura = tables.cdnura; any = true }
  return any ? json : null
}

/** Write the amendment JSON beside the period's other return exports. */
export function exportAmendmentJson(
  slug: string,
  period: string,
  json: Record<string, unknown>
): string {
  const path = join(companyExportsDir(slug), `gstr1-amendments-${period}.json`)
  writeFileSync(path, JSON.stringify(json, null, 2))
  return path
}
