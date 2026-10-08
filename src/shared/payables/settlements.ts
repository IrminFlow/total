/**
 * Settlement timeline (WP 4.3) — pure. Replays a party's bill events through the Outstandings
 * allocation (allocateBills) one event at a time and reports, for every event, how much of which
 * bill it settled. Used for MSME Form 1 ("paid within / after 45 days"): per event, so a bill and
 * its payment on the same day are both seen, and each settlement keeps the voucher that made it
 * (so debit notes can be told apart from payments).
 */
import { allocateBills, type BillEvent } from '../outstanding'

export interface Settlement {
  /** `${billVoucherId ?? 'open'}|${billName}` */
  billKey: string
  billDate: string
  billVoucherId: number | null
  /** The settling event's voucher (null for none). */
  byVoucherId: number | null
  date: string
  amount: number
}

const keyOf = (b: { voucherId: number | null; number: string }): string => `${b.voucherId ?? 'open'}|${b.number}`

export function settlementTimeline(events: readonly BillEvent[], asOn: string, creditDays: number | null, from = ''): Settlement[] {
  const out: Settlement[] = []
  const firstIdx = events.findIndex((e) => e.date >= from)
  if (firstIdx === -1) return out
  let before = new Map(allocateBills(events.slice(0, firstIdx) as BillEvent[], asOn, creditDays).bills.map((b) => [keyOf(b), b]))
  for (let i = firstIdx; i < events.length; i++) {
    const ev = events[i]!
    if (ev.date > asOn) break
    const after = new Map(allocateBills(events.slice(0, i + 1) as BillEvent[], asOn, creditDays).bills.map((b) => [keyOf(b), b]))
    // Bills this event created (not open before): start from their full amount.
    const created = new Map<string, { amount: number; date: string; voucherId: number | null }>()
    for (const r of ev.refs) if (r.kind === 'new') created.set(`${ev.voucherId ?? 'open'}|${r.name}`, { amount: r.amount, date: ev.date, voucherId: ev.voucherId })
    if (ev.refs.length === 0 && ev.amount > 0) created.set(`${ev.voucherId ?? 'open'}|${ev.number}`, { amount: ev.amount, date: ev.date, voucherId: ev.voucherId })
    const keys = new Set([...before.keys(), ...created.keys()])
    for (const k of keys) {
      const prev = before.get(k)
      const was = prev?.pending ?? created.get(k)?.amount ?? 0
      const now = after.get(k)?.pending ?? 0
      if (was - now <= 0) continue
      out.push({
        billKey: k,
        billDate: prev?.date ?? created.get(k)!.date,
        billVoucherId: prev?.voucherId ?? created.get(k)!.voucherId,
        byVoucherId: ev.voucherId,
        date: ev.date,
        amount: was - now
      })
    }
    before = after
  }
  return out
}
