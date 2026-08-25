/**
 * TDS lower-deduction certificates — persistence and resolution (roadmap D-109).
 *
 * The statutory reasoning lives in `@shared/tds/lowerDeduction` (section 197 / 197A, Rule 28AA);
 * this file only stores what the Assessing Officer issued and answers one question at deduction
 * time: *for this party, this section and this date, what has already been paid under the
 * certificate, and therefore what is deducted now?*
 *
 * Statutory position checked on 2026-08-25 against the Income-tax Act s.197/197A and Rules
 * 28AA/28AB. Nothing here hard-codes a rate or a ceiling: both are per-certificate data.
 */
import type { DB } from '../db/connection'
import type { TdsCertificateInput } from '@shared/schemas'
import {
  applicableCertificate,
  deductionWithCertificate,
  type AppliedRate,
  type LowerDeductionCertificate
} from '@shared/tds/lowerDeduction'
import { writeAudit } from './audit'
// IN_BOOKS, not bare NOT_DELETED: a soft-deleted voucher must not consume somebody's Rule 28AA
// ceiling, and neither must an optional (memorandum) or an unmatured post-dated one — none of
// them is a payment or a credit yet, and the ceiling counts amounts actually paid or credited.
// IN_BOOKS is NOT_DELETED plus those, so the deleted_at filter is included by construction.
import { IN_BOOKS } from './vouchers'

/** A stored certificate: the engine's shape plus the row's own identity. */
export interface TdsCertificate extends LowerDeductionCertificate {
  id: number
  /** Same value as the engine's `sectionId`, named as the column is. */
  sectionCode: string
  notes: string | null
  createdAt: string
}

interface CertRow {
  id: number
  certificate_number: string
  pan: string
  section_code: string
  rate_percent: number
  valid_from: string
  valid_to: string
  ceiling_paise: number | null
  notes: string | null
  created_at: string
}

const mapCert = (r: CertRow): TdsCertificate => ({
  id: r.id,
  certificateNumber: r.certificate_number,
  pan: r.pan,
  // The engine keys certificates on `sectionId`, which for a section 197 certificate is the
  // section CODE as printed on it ('194C'), not our tds_sections row id.
  sectionId: r.section_code,
  sectionCode: r.section_code,
  ratePercent: r.rate_percent,
  validFrom: r.valid_from,
  validTo: r.valid_to,
  ceilingPaise: r.ceiling_paise,
  notes: r.notes,
  createdAt: r.created_at
})

const SELECT = 'SELECT * FROM tds_lower_deduction_certificates'

export function listCertificates(db: DB): TdsCertificate[] {
  return (db.prepare(`${SELECT} ORDER BY valid_from DESC, pan, section_code`).all() as CertRow[]).map(mapCert)
}

/** Create a certificate, or update the one identified by `id`. */
export function saveCertificate(db: DB, input: TdsCertificateInput, id?: number): TdsCertificate {
  const args = [
    input.certificateNumber,
    input.pan,
    input.sectionCode,
    input.ratePercent,
    input.validFrom,
    input.validTo,
    input.ceilingPaise,
    input.notes
  ] as const

  if (id) {
    const existing = db.prepare(`${SELECT} WHERE id = ?`).get(id) as CertRow | undefined
    if (!existing) throw new Error('Lower-deduction certificate not found')
    db.prepare(
      `UPDATE tds_lower_deduction_certificates
       SET certificate_number = ?, pan = ?, section_code = ?, rate_percent = ?,
           valid_from = ?, valid_to = ?, ceiling_paise = ?, notes = ?
       WHERE id = ?`
    ).run(...args, id)
    const updated = mapCert(db.prepare(`${SELECT} WHERE id = ?`).get(id) as CertRow)
    writeAudit(db, 'tdsCertificate', id, 'update', mapCert(existing), updated)
    return updated
  }

  const res = db
    .prepare(
      `INSERT INTO tds_lower_deduction_certificates
         (certificate_number, pan, section_code, rate_percent, valid_from, valid_to, ceiling_paise, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(...args)
  const created = mapCert(db.prepare(`${SELECT} WHERE id = ?`).get(res.lastInsertRowid) as CertRow)
  writeAudit(db, 'tdsCertificate', created.id, 'create', null, created)
  return created
}

/**
 * Delete a certificate.
 *
 * Deliberately unconditional. Unlike a master, a certificate is not referenced by any posted row:
 * a deduction already made under it is a fact in `voucher_lines` and does not change when the
 * certificate record goes away. What does change is future deductions, which is exactly what
 * someone deleting a wrongly-typed certificate wants.
 */
export function deleteCertificate(db: DB, id: number): void {
  const existing = db.prepare(`${SELECT} WHERE id = ?`).get(id) as CertRow | undefined
  if (!existing) throw new Error('Lower-deduction certificate not found')
  db.prepare('DELETE FROM tds_lower_deduction_certificates WHERE id = ?').run(id)
  writeAudit(db, 'tdsCertificate', id, 'delete', mapCert(existing), null)
}

const norm = (s: string | null | undefined): string => (s ?? '').trim().toUpperCase()

/**
 * Amount already paid or credited, in the certificate's own validity window, to every ledger that
 * carries this PAN and is flagged for this section.
 *
 * Computed from `voucher_lines`, not from `tds_entries`. `tds_entries.tds_amount` is a positive
 * paise value by schema, so a NIL certificate (rate 0, and every section 197A declaration)
 * produces a voucher with no TDS entry at all — measuring the ceiling from `tds_entries` would
 * let a nil certificate run for ever, which is the one case the ceiling exists to stop.
 *
 * Both sides of the party ledger are summed and the LARGER is taken, because "paid or credited"
 * (the words of every deduction section) is one event recorded twice in a normal accrual: the
 * expense credits the payee and the later payment debits them back. Adding the two would count
 * the same income twice and exhaust the ceiling at half the right amount; taking the larger
 * handles accrual-only, payment-only and accrual-then-payment books alike.
 *
 * VERIFY: a debit note or a refund from the payee inside the window inflates the debit side and
 * so can overstate consumption. That errs toward the ordinary rate (more tax withheld), which is
 * the safe direction for the deductor under s.201(1), but a books-level "amount paid or credited"
 * marker per voucher would be exact and is the better long-term answer.
 */
export function paidUnderCertificate(
  db: DB,
  cert: Pick<LowerDeductionCertificate, 'pan' | 'sectionId' | 'validFrom' | 'validTo'>,
  opts: { excludeVoucherId?: number } = {}
): number {
  const exclude = opts.excludeVoucherId ?? -1
  const rows = db
    .prepare(
      `SELECT vl.dr_cr AS drCr, COALESCE(SUM(vl.amount), 0) AS total
       FROM voucher_lines vl
       JOIN vouchers v ON v.id = vl.voucher_id
       JOIN ledgers l ON l.id = vl.ledger_id
       JOIN tds_sections ts ON ts.id = l.tds_section_id
       WHERE UPPER(TRIM(l.pan)) = ? AND UPPER(TRIM(ts.code)) = ?
         AND v.date BETWEEN ? AND ? AND v.id <> ? AND ${IN_BOOKS}
       GROUP BY vl.dr_cr`
    )
    .all(norm(cert.pan), norm(cert.sectionId), cert.validFrom, cert.validTo, exclude) as {
    drCr: 'dr' | 'cr'
    total: number
  }[]
  const dr = rows.find((r) => r.drCr === 'dr')?.total ?? 0
  const cr = rows.find((r) => r.drCr === 'cr')?.total ?? 0
  return Math.max(dr, cr)
}

/** What the certificate did to one deduction, for the caller that has to show it. */
export interface CertificateEffect {
  certificateId: number
  certificateNumber: string
  ratePercent: number
  validFrom: string
  validTo: string
  ceilingPaise: number | null
  /** Paid or credited under this certificate before the transaction being computed, paise. */
  alreadyPaidPaise: number
  /** Headroom remaining before this transaction, paise. Null when the certificate is uncapped. */
  headroomPaise: number | null
}

export interface ResolvedDeduction {
  /** Total tax to deduct on this transaction, paise — the number the voucher posts. */
  tdsPaise: number
  atCertificateRatePaise: number
  atNormalRatePaise: number
  /** True once the ceiling is spent as at the end of this transaction. */
  certificateExhausted: boolean
  /** One entry per rate actually applied; two when the payment straddles the ceiling. */
  ratesApplied: AppliedRate[]
  /** Null when no certificate is in force — the ordinary-rate path, unchanged. */
  certificate: CertificateEffect | null
}

/**
 * The certificate in force for a ledger, section and date, or null.
 *
 * The lookup is by PAN, not by ledger: section 197 issues to a PERSON, and the same person can be
 * two ledgers in these books (an "Acme Ltd" and an "Acme Limited — Delhi"). A ledger with no PAN
 * can never have one — Rule 28AA(2) forbids the AO from issuing a certificate without a PAN — so
 * the answer there is null without a query.
 */
export function certificateFor(
  db: DB,
  args: { pan: string | null; sectionCode: string; date: string }
): TdsCertificate | null {
  if (!norm(args.pan)) return null
  const candidates = (
    db
      .prepare(`${SELECT} WHERE UPPER(TRIM(pan)) = ? AND UPPER(TRIM(section_code)) = ?`)
      .all(norm(args.pan), norm(args.sectionCode)) as CertRow[]
  ).map(mapCert)
  const chosen = applicableCertificate(candidates, {
    pan: norm(args.pan),
    sectionId: norm(args.sectionCode),
    date: args.date
  })
  return chosen === null ? null : (chosen as TdsCertificate)
}

/**
 * Deduct on one transaction, honouring any section 197 certificate.
 *
 * With no certificate the result is exactly `computeTds(normalRatePercent, basePaise, panAvailable)`
 * in a wrapper — the pre-existing behaviour, unchanged, including the section 206AA 20% floor.
 */
export function resolveDeduction(
  db: DB,
  args: {
    pan: string | null
    sectionCode: string
    normalRatePercent: number
    basePaise: number
    date: string
    excludeVoucherId?: number
  }
): ResolvedDeduction {
  const panAvailable = !!norm(args.pan)
  const cert = certificateFor(db, { pan: args.pan, sectionCode: args.sectionCode, date: args.date })
  const alreadyPaidPaise = cert
    ? paidUnderCertificate(db, cert, { excludeVoucherId: args.excludeVoucherId })
    : 0

  const out = deductionWithCertificate({
    amountPaise: args.basePaise,
    normalRatePercent: args.normalRatePercent,
    certificate: cert,
    alreadyPaidUnderCertificatePaise: alreadyPaidPaise,
    panAvailable
  })

  return {
    tdsPaise: out.tdsPaise,
    atCertificateRatePaise: out.atCertificateRatePaise,
    atNormalRatePaise: out.atNormalRatePaise,
    certificateExhausted: out.certificateExhausted,
    ratesApplied: out.ratesApplied,
    certificate: cert
      ? {
          certificateId: cert.id,
          certificateNumber: cert.certificateNumber,
          ratePercent: cert.ratePercent,
          validFrom: cert.validFrom,
          validTo: cert.validTo,
          ceilingPaise: cert.ceilingPaise,
          alreadyPaidPaise,
          headroomPaise:
            cert.ceilingPaise === null ? null : Math.max(0, cert.ceilingPaise - alreadyPaidPaise)
        }
      : null
  }
}

/** A certificate with its consumption filled in, for the Certificates tab's list. */
export interface CertificateWithUsage extends TdsCertificate {
  /** Paid or credited under it so far, paise. */
  usedPaise: number
  /** Ceiling less used, floored at zero; null when uncapped. */
  headroomPaise: number | null
  /** True when a capped certificate has nothing left — every further rupee is at the normal rate. */
  exhausted: boolean
}

export function listCertificatesWithUsage(db: DB): CertificateWithUsage[] {
  return listCertificates(db).map((c) => {
    const usedPaise = paidUnderCertificate(db, c)
    const headroomPaise = c.ceilingPaise === null ? null : Math.max(0, c.ceilingPaise - usedPaise)
    return { ...c, usedPaise, headroomPaise, exhausted: headroomPaise !== null && headroomPaise === 0 }
  })
}
