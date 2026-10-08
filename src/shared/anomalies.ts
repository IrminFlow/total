/**
 * Anomaly and duplicate detection (WP 5.5). Pure: the main process loads the vouchers of the
 * period plus a history window before it (services/assistants.ts); this module decides what looks
 * wrong and why. The assistant only narrates the result (the numbers rule) — every figure here is
 * integer paise, every ratio integer-scaled (z-scores in thousandths, GST rates in basis points),
 * and the variance maths runs in BigInt so squared paise never overflow a double.
 *
 * Every anomaly carries a STABLE key (kind + the voucher / item ids it is about), so a dismissal
 * (assistant_marks) survives re-runs and only hides that exact finding.
 */

export type AnomalyKind =
  | 'duplicate_party_amount'
  | 'duplicate_bill_number'
  | 'duplicate_narration'
  | 'round_amount'
  | 'unusual_pairing'
  | 'amount_outlier'
  | 'weekend_posting'
  | 'holiday_posting'
  | 'backdated'
  | 'gst_rate_deviation'
  | 'hsn_rate_mismatch'

export type AnomalySeverity = 'high' | 'medium' | 'low'

export const ANOMALY_LABELS: Record<AnomalyKind, string> = {
  duplicate_party_amount: 'Possible duplicate (same party and amount)',
  duplicate_bill_number: 'Same bill number entered twice',
  duplicate_narration: 'Same narration and amount',
  round_amount: 'Large round amount',
  unusual_pairing: 'Unusual ledger pairing',
  amount_outlier: 'Amount far above the usual',
  weekend_posting: 'Dated on a weekly off day',
  holiday_posting: 'Dated on a holiday',
  backdated: 'Back-dated entry',
  gst_rate_deviation: 'GST charged differs from the item rates',
  hsn_rate_mismatch: 'Same HSN, different GST rates'
}

/** How the ledger behaves, for pairing and outlier baselines. */
export type LedgerRole = 'party' | 'cashBank' | 'tax' | 'other'

export interface AnomalyLine {
  ledgerId: number
  drCr: 'dr' | 'cr'
  /** Paise, positive. */
  amount: number
}

export interface AnomalyVoucher {
  voucherId: number
  date: string
  kind: string
  typeName: string
  number: string
  partyLedgerId: number | null
  partyName: string | null
  /** Voucher total = sum of debits, paise. */
  amount: number
  narration: string | null
  /** Supplier bill / reference number as entered. */
  reference: string | null
  /** ISO date (YYYY-MM-DD) the voucher was first saved (audit trail); null = unknown. */
  createdOn: string | null
  lines: AnomalyLine[]
  /** GST tax lines total (paise) and taxable value of the stock lines — for the rate check. */
  taxPaise?: number
  /** Stock lines: amount (paise) and the item's master rate in basis points (1800 = 18%). */
  stockLines?: { itemId: number; itemName: string; hsn: string | null; amount: number; rateBp: number | null }[]
}

export interface AnomalyItem {
  itemId: number
  name: string
  hsn: string | null
  rateBp: number | null
}

export interface AnomalyInput {
  /** The period anomalies are reported for. */
  from: string
  to: string
  /** Vouchers of the period AND the history window before it (baselines), in the books only. */
  vouchers: readonly AnomalyVoucher[]
  ledgers: ReadonlyMap<number, { name: string; role: LedgerRole }>
  items?: readonly AnomalyItem[]
}

export interface AnomalyOptions {
  /** Same party + amount within this many days = possible duplicate. */
  duplicateWindowDays: number
  /** A round amount is a multiple of this (paise) … */
  roundUnitPaise: number
  /** … and at least this large (paise). */
  roundMinPaise: number
  /** Flag amounts at least this many standard deviations above the mean (thousandths: 3000 = 3σ). */
  zThresholdMilli: number
  /** History vouchers needed before a baseline counts (outliers, pairings). */
  minHistory: number
  /** Entered this many days or more after its date = back-dated. */
  backdatedDays: number
  /** Weekly off days, 0 = Sunday … 6 = Saturday. */
  weekendDays: readonly number[]
  /** Holiday dates (YYYY-MM-DD). */
  holidays: readonly string[]
  /** The books' lock date (entries on or before it were locked). */
  lockDate: string | null
  /** Months marked closed in the close checklist: entries into them saved after closing are high. */
  closedPeriods: readonly { period: string; closedOn: string }[]
  /** Tolerance on the effective GST rate (basis points). */
  gstRateToleranceBp: number
}

export const DEFAULT_ANOMALY_OPTIONS: AnomalyOptions = {
  duplicateWindowDays: 3,
  roundUnitPaise: 10_000_00, // ₹10,000
  roundMinPaise: 1_00_000_00, // ₹1,00,000
  zThresholdMilli: 3000,
  minHistory: 6,
  backdatedDays: 30,
  weekendDays: [0],
  holidays: [],
  lockDate: null,
  closedPeriods: [],
  gstRateToleranceBp: 50
}

export interface Anomaly {
  key: string
  kind: AnomalyKind
  severity: AnomalySeverity
  /** The voucher the finding is about (null for an item-level finding). */
  voucherId: number | null
  /** The other vouchers involved (the earlier duplicate, …). */
  relatedVoucherIds: number[]
  date: string | null
  /** "Purchase 12" — the voucher as the books show it, or the item name. */
  label: string
  partyLedgerId: number | null
  partyName: string | null
  ledgerId: number | null
  itemId: number | null
  /** Paise. */
  amount: number | null
  /** Plain-language reason, figures pre-formatted by the caller-free helpers here. */
  detail: string
  /** Integer-scaled measure behind the finding (z in thousandths, rate in bp, days …). */
  metric: number | null
}

// ---------------------------------------------------------------- integer helpers

const DAY_MS = 86_400_000
const dayNo = (iso: string): number => Math.round(Date.parse(`${iso}T00:00:00Z`) / DAY_MS)
export const daysBetween = (a: string, b: string): number => Math.abs(dayNo(a) - dayNo(b))
/** 0 = Sunday. */
export const weekday = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay()

/** floor(sqrt(n)) for a non-negative BigInt (Newton's method). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt of a negative number')
  if (n < 2n) return n
  let x = n
  let y = (x + 1n) / 2n
  while (y < x) {
    x = y
    y = (x + n / x) / 2n
  }
  return x
}

/**
 * How far `x` sits above the mean of `history`, in thousandths of a standard deviation
 * (population SD), or null when there is no spread. Exact integer maths:
 *   z = (x − S/n) / sqrt(Q/n − (S/n)²) = (n·x − S) / sqrt(n·Q − S²)
 * floored to thousandths,
 * with S = Σa, Q = Σa², all BigInt.
 */
export function zScoreMilli(x: number, history: readonly number[]): number | null {
  const n = BigInt(history.length)
  if (n < 2n) return null
  let s = 0n
  let q = 0n
  for (const a of history) {
    const b = BigInt(a)
    s += b
    q += b * b
  }
  const v = n * q - s * s
  if (v <= 0n) return null
  const d = n * BigInt(x) - s
  // z·1000 = sqrt(d²·10⁶ / v), signed — one square root of the scaled ratio keeps every digit.
  const mag = isqrt((d * d * 1_000_000n) / v)
  return Number(d < 0n ? -mag : mag)
}

/** Basis points of `part` in `whole` (rounded half up; null when whole is 0). */
export function bpOf(part: number, whole: number): number | null {
  if (whole === 0) return null
  return Number((BigInt(part) * 20000n + BigInt(whole)) / (2n * BigInt(whole)))
}

/** "18%" / "0.25%" from basis points. */
export const rateText = (bp: number): string => {
  const whole = Math.trunc(bp / 100)
  const frac = Math.abs(bp % 100)
  return frac ? `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%` : `${whole}%`
}

/** "4.2σ" from thousandths. */
export const sigmaText = (milli: number): string => `${Math.trunc(milli / 1000)}.${Math.trunc(Math.abs(milli % 1000) / 100)}σ`

/** Invoice-number normalisation for duplicates: upper-case letters and digits only, leading zeros
 *  of the last digit run dropped ("INV-007" = "inv7"). */
export function normaliseBillNo(raw: string): string {
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return s.replace(/0+(\d+)$/, (_m, d: string) => d)
}

const normaliseNarration = (raw: string): string => raw.toLowerCase().replace(/\s+/g, ' ').replace(/[^a-z0-9 ]/g, '').trim()

/** Rupee text without floats: 1234567 → "₹12,345.67". */
export function rupeeText(paise: number): string {
  const neg = paise < 0
  const abs = Math.abs(paise)
  const rupees = String(Math.floor(abs / 100))
  const last3 = rupees.slice(-3)
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',')
  return `${neg ? '-' : ''}₹${rest ? `${rest},${last3}` : last3}.${String(abs % 100).padStart(2, '0')}`
}

// ---------------------------------------------------------------- the detector

const label = (v: AnomalyVoucher): string => `${v.typeName} ${v.number}`.trim()
const inPeriod = (v: AnomalyVoucher, from: string, to: string): boolean => v.date >= from && v.date <= to
/** Kinds whose amounts are compared with the party's usual (money moving to / from a party). */
const PARTY_KINDS = new Set(['sales', 'purchase', 'payment', 'receipt', 'credit_note', 'debit_note', 'journal'])
const BILL_KINDS = new Set(['purchase', 'debit_note', 'credit_note', 'sales'])

function base(v: AnomalyVoucher, kind: AnomalyKind, severity: AnomalySeverity, detail: string, extra: Partial<Anomaly> = {}): Anomaly {
  return {
    key: `${kind}:${v.voucherId}`,
    kind,
    severity,
    voucherId: v.voucherId,
    relatedVoucherIds: [],
    date: v.date,
    label: label(v),
    partyLedgerId: v.partyLedgerId,
    partyName: v.partyName,
    ledgerId: null,
    itemId: null,
    amount: v.amount,
    detail,
    metric: null,
    ...extra
  }
}

function duplicates(vs: readonly AnomalyVoucher[], input: AnomalyInput, o: AnomalyOptions): Anomaly[] {
  const out: Anomaly[] = []
  const sorted = [...vs].sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
  // Same party + kind + amount within the window. Reported on the LATER voucher of each pair.
  const byParty = new Map<string, AnomalyVoucher[]>()
  for (const v of sorted) {
    if (v.partyLedgerId == null || v.amount <= 0) continue
    const k = `${v.partyLedgerId}|${v.kind}|${v.amount}`
    const list = byParty.get(k) ?? []
    list.push(v)
    byParty.set(k, list)
  }
  for (const list of byParty.values()) {
    for (let i = 1; i < list.length; i++) {
      const v = list[i]!
      if (!inPeriod(v, input.from, input.to)) continue
      const earlier = list.slice(0, i).filter((e) => daysBetween(e.date, v.date) <= o.duplicateWindowDays)
      if (!earlier.length) continue
      const first = earlier[earlier.length - 1]!
      out.push(
        base(v, 'duplicate_party_amount', 'high', `${rupeeText(v.amount)} to ${v.partyName ?? 'the same party'} on ${v.date}, and ${label(first)} for the same amount on ${first.date} (${daysBetween(first.date, v.date)} days apart)`, {
          key: `duplicate_party_amount:${first.voucherId}:${v.voucherId}`,
          relatedVoucherIds: earlier.map((e) => e.voucherId),
          metric: daysBetween(first.date, v.date)
        })
      )
    }
  }
  // Same bill / reference number for the same party (any date).
  const byBill = new Map<string, AnomalyVoucher[]>()
  for (const v of sorted) {
    if (!v.reference || v.partyLedgerId == null || !BILL_KINDS.has(v.kind)) continue
    const n = normaliseBillNo(v.reference)
    if (!n) continue
    const k = `${v.partyLedgerId}|${v.kind}|${n}`
    const list = byBill.get(k) ?? []
    list.push(v)
    byBill.set(k, list)
  }
  for (const list of byBill.values()) {
    for (let i = 1; i < list.length; i++) {
      const v = list[i]!
      if (!inPeriod(v, input.from, input.to)) continue
      const first = list[0]!
      out.push(
        base(v, 'duplicate_bill_number', 'high', `Bill “${v.reference}” from ${v.partyName ?? 'this party'} is also on ${label(first)} dated ${first.date}`, {
          key: `duplicate_bill_number:${first.voucherId}:${v.voucherId}`,
          relatedVoucherIds: list.slice(0, i).map((e) => e.voucherId)
        })
      )
    }
  }
  // Same (meaningful) narration + same amount within the window, different parties allowed.
  const byNarr = new Map<string, AnomalyVoucher[]>()
  for (const v of sorted) {
    const n = v.narration ? normaliseNarration(v.narration) : ''
    if (n.length < 12) continue
    const k = `${n}|${v.amount}`
    const list = byNarr.get(k) ?? []
    list.push(v)
    byNarr.set(k, list)
  }
  const flagged = new Set(out.map((a) => a.voucherId))
  for (const list of byNarr.values()) {
    for (let i = 1; i < list.length; i++) {
      const v = list[i]!
      if (!inPeriod(v, input.from, input.to) || flagged.has(v.voucherId)) continue
      const earlier = list.slice(0, i).filter((e) => daysBetween(e.date, v.date) <= o.duplicateWindowDays)
      if (!earlier.length) continue
      const first = earlier[earlier.length - 1]!
      out.push(
        base(v, 'duplicate_narration', 'medium', `Same narration and amount (${rupeeText(v.amount)}) as ${label(first)} on ${first.date}`, {
          key: `duplicate_narration:${first.voucherId}:${v.voucherId}`,
          relatedVoucherIds: earlier.map((e) => e.voucherId)
        })
      )
    }
  }
  return out
}

/** The main counter-ledgers of a voucher: its largest debit and largest credit outside tax lines. */
function mainPair(v: AnomalyVoucher, ledgers: AnomalyInput['ledgers']): [number, number] | null {
  let dr: AnomalyLine | null = null
  let cr: AnomalyLine | null = null
  for (const l of v.lines) {
    if (ledgers.get(l.ledgerId)?.role === 'tax') continue
    if (l.drCr === 'dr' && (!dr || l.amount > dr.amount)) dr = l
    if (l.drCr === 'cr' && (!cr || l.amount > cr.amount)) cr = l
  }
  if (!dr || !cr || dr.ledgerId === cr.ledgerId) return null
  return [dr.ledgerId, cr.ledgerId]
}

function baselines(vs: readonly AnomalyVoucher[], input: AnomalyInput, o: AnomalyOptions): Anomaly[] {
  const out: Anomaly[] = []
  const sorted = [...vs].sort((a, b) => a.date.localeCompare(b.date) || a.voucherId - b.voucherId)
  const name = (id: number): string => input.ledgers.get(id)?.name ?? `#${id}`

  // Pairings: (main Dr ledger, main Cr ledger) never seen before, both ledgers established.
  const seenPairs = new Set<string>()
  const ledgerUse = new Map<number, number>()
  // Outliers: party amounts per (party, kind); 'other' ledger amounts per (ledger, side).
  const partyHist = new Map<string, number[]>()
  const ledgerHist = new Map<string, number[]>()
  for (const v of sorted) {
    const pair = mainPair(v, input.ledgers)
    if (inPeriod(v, input.from, input.to)) {
      if (pair && !seenPairs.has(pair.join('>'))) {
        const [d, c] = pair
        if ((ledgerUse.get(d) ?? 0) >= o.minHistory && (ledgerUse.get(c) ?? 0) >= o.minHistory) {
          out.push(
            base(v, 'unusual_pairing', 'medium', `Dr ${name(d)} / Cr ${name(c)} has not been used together before (both ledgers have ${o.minHistory}+ earlier vouchers)`, {
              key: `unusual_pairing:${v.voucherId}`,
              ledgerId: d
            })
          )
        }
      }
      if (v.partyLedgerId != null && PARTY_KINDS.has(v.kind)) {
        const hist = partyHist.get(`${v.partyLedgerId}|${v.kind}`) ?? []
        const z = hist.length >= o.minHistory ? zScoreMilli(v.amount, hist) : null
        if (z !== null && z >= o.zThresholdMilli) {
          out.push(
            base(v, 'amount_outlier', z >= o.zThresholdMilli * 2 ? 'high' : 'medium', `${rupeeText(v.amount)} is ${sigmaText(z)} above ${v.partyName ?? 'this party'}’s usual ${v.typeName.toLowerCase()} amounts (${hist.length} earlier vouchers, largest ${rupeeText(Math.max(...hist))})`, {
              key: `amount_outlier:${v.voucherId}`,
              metric: z
            })
          )
        }
      } else {
        for (const l of v.lines) {
          if (input.ledgers.get(l.ledgerId)?.role !== 'other') continue
          const hist = ledgerHist.get(`${l.ledgerId}|${l.drCr}`) ?? []
          const z = hist.length >= o.minHistory ? zScoreMilli(l.amount, hist) : null
          if (z !== null && z >= o.zThresholdMilli) {
            out.push(
              base(v, 'amount_outlier', z >= o.zThresholdMilli * 2 ? 'high' : 'medium', `${rupeeText(l.amount)} on ${name(l.ledgerId)} is ${sigmaText(z)} above its usual ${l.drCr === 'dr' ? 'debits' : 'credits'} (${hist.length} earlier entries, largest ${rupeeText(Math.max(...hist))})`, {
                key: `amount_outlier:${v.voucherId}:${l.ledgerId}`,
                ledgerId: l.ledgerId,
                amount: l.amount,
                metric: z
              })
            )
            break
          }
        }
      }
    }
    // The voucher joins the history AFTER it was judged (a voucher is never its own baseline).
    if (pair) seenPairs.add(pair.join('>'))
    for (const id of new Set(v.lines.map((l) => l.ledgerId))) ledgerUse.set(id, (ledgerUse.get(id) ?? 0) + 1)
    if (v.partyLedgerId != null && PARTY_KINDS.has(v.kind)) {
      const k = `${v.partyLedgerId}|${v.kind}`
      partyHist.set(k, [...(partyHist.get(k) ?? []), v.amount])
    } else {
      for (const l of v.lines) {
        if (input.ledgers.get(l.ledgerId)?.role !== 'other') continue
        const k = `${l.ledgerId}|${l.drCr}`
        const h = ledgerHist.get(k) ?? []
        h.push(l.amount)
        ledgerHist.set(k, h)
      }
    }
  }
  return out
}

function perVoucher(vs: readonly AnomalyVoucher[], input: AnomalyInput, o: AnomalyOptions): Anomaly[] {
  const out: Anomaly[] = []
  const holidays = new Set(o.holidays)
  for (const v of vs) {
    if (!inPeriod(v, input.from, input.to)) continue
    if ((v.kind === 'journal' || v.kind === 'payment') && v.amount >= o.roundMinPaise && v.amount % o.roundUnitPaise === 0) {
      out.push(base(v, 'round_amount', 'low', `${rupeeText(v.amount)} is an exact multiple of ${rupeeText(o.roundUnitPaise)} — check it is not an estimate or a placeholder`))
    }
    if (holidays.has(v.date)) out.push(base(v, 'holiday_posting', 'low', `Dated ${v.date}, a holiday in the company calendar`))
    else if (o.weekendDays.includes(weekday(v.date))) out.push(base(v, 'weekend_posting', 'low', `Dated ${v.date}, a weekly off day`))
    if (v.createdOn && v.createdOn > v.date) {
      const late = daysBetween(v.createdOn, v.date)
      const closed = o.closedPeriods.find((p) => p.period === v.date.slice(0, 7) && v.createdOn! > p.closedOn)
      const locked = o.lockDate !== null && v.date <= o.lockDate
      if (closed || locked || late >= o.backdatedDays) {
        const why = closed
          ? `entered on ${v.createdOn}, after ${v.date.slice(0, 7)} was marked closed (${closed.closedOn})`
          : locked
            ? `entered on ${v.createdOn} into the period now locked up to ${o.lockDate}`
            : `entered on ${v.createdOn}, ${late} days after its date`
        out.push(base(v, 'backdated', closed || locked ? 'high' : 'medium', `Dated ${v.date} but ${why}`, { metric: late }))
      }
    }
    // GST charged vs the items' rates (stock vouchers with tax lines).
    if (v.stockLines?.length && v.taxPaise !== undefined && (v.kind === 'sales' || v.kind === 'purchase')) {
      const rated = v.stockLines.filter((l) => l.rateBp !== null)
      const taxable = v.stockLines.reduce((s, l) => s + l.amount, 0)
      if (rated.length === v.stockLines.length && taxable > 0) {
        // Expected rate = item rates weighted by line value (BigInt, rounded) — basis points.
        let w = 0n
        for (const l of rated) w += BigInt(l.amount) * BigInt(l.rateBp!)
        const expected = Number((w * 2n + BigInt(taxable)) / (2n * BigInt(taxable)))
        const effective = bpOf(v.taxPaise, taxable)!
        if (Math.abs(effective - expected) > o.gstRateToleranceBp) {
          const hsn = [...new Set(v.stockLines.map((l) => l.hsn).filter(Boolean))].join(', ')
          out.push(
            base(v, 'gst_rate_deviation', 'medium', `GST charged is ${rateText(effective)} of the taxable value ${rupeeText(taxable)}; the items’ rates give ${rateText(expected)}${hsn ? ` (HSN ${hsn})` : ''}`, {
              itemId: v.stockLines[0]!.itemId,
              metric: effective - expected
            })
          )
        }
      }
    }
  }
  return out
}

function hsnRates(items: readonly AnomalyItem[]): Anomaly[] {
  const byHsn = new Map<string, AnomalyItem[]>()
  for (const i of items) {
    if (!i.hsn || i.rateBp === null) continue
    const k = i.hsn.trim()
    byHsn.set(k, [...(byHsn.get(k) ?? []), i])
  }
  const out: Anomaly[] = []
  for (const [hsn, list] of byHsn) {
    const counts = new Map<number, number>()
    for (const i of list) counts.set(i.rateBp!, (counts.get(i.rateBp!) ?? 0) + 1)
    if (counts.size < 2) continue
    // The most common rate (ties: the higher) is "usual"; items on any other rate are flagged.
    const usual = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]![0]
    for (const i of list) {
      if (i.rateBp === usual) continue
      out.push({
        key: `hsn_rate_mismatch:${i.itemId}`,
        kind: 'hsn_rate_mismatch',
        severity: 'medium',
        voucherId: null,
        relatedVoucherIds: [],
        date: null,
        label: i.name,
        partyLedgerId: null,
        partyName: null,
        ledgerId: null,
        itemId: i.itemId,
        amount: null,
        detail: `HSN ${hsn}: ${i.name} is at ${rateText(i.rateBp!)} while ${counts.get(usual)} other item(s) with this HSN are at ${rateText(usual)} — rates follow the HSN, check the item master`,
        metric: i.rateBp! - usual
      })
    }
  }
  return out
}

const SEVERITY_ORDER: Record<AnomalySeverity, number> = { high: 0, medium: 1, low: 2 }

/** Every anomaly in [from, to], most severe first, then by date. */
export function findAnomalies(input: AnomalyInput, opts: Partial<AnomalyOptions> = {}): Anomaly[] {
  const o = { ...DEFAULT_ANOMALY_OPTIONS, ...opts }
  const list = [...duplicates(input.vouchers, input, o), ...baselines(input.vouchers, input, o), ...perVoucher(input.vouchers, input, o), ...hsnRates(input.items ?? [])]
  const seen = new Set<string>()
  return list
    .filter((a) => (seen.has(a.key) ? false : (seen.add(a.key), true)))
    .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || (a.date ?? '').localeCompare(b.date ?? '') || a.key.localeCompare(b.key))
}
