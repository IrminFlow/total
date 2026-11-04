// PR #191 review (differential test, kept): the bill engine became incremental (billAllocator)
// so the Tally import can track each party's open bills. It must give exactly what the engine gave
// before — refless inference, named bills, named credits, refs that don't add up, zero amounts, due
// dates, ageing — on 50,000 generated event lists (seeded, so every run checks the same cases), for
// allocateBillsWithCredits, allocateBills and billAllocator applied one event at a time.
import { describe, it, expect } from 'vitest'
import * as A from './fixtures/outstandingMain'
import * as B from './outstanding'
import type { BillEvent, BillRef } from './outstanding'

function rng(seed: number) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32 } }

function gen(r: () => number): BillEvent[] {
  const n = 1 + Math.floor(r() * 30)
  const names = ['1', '2', '3', 'A/1', 'Opening', 'Adv', '1/25-26', 'x']
  const evs: BillEvent[] = []
  let d = Date.parse('2024-04-01')
  const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]!
  const amt = () => [1, 99, 100, 1000, 12345, 50000, 3][Math.floor(r() * 7)]! * (1 + Math.floor(r() * 5))
  if (r() < 0.5) { // opening bills
    const k = 1 + Math.floor(r() * 3)
    for (let i = 0; i < k; i++) { const a = amt(); evs.push({ voucherId: null, date: '2024-04-01', number: 'Opening', amount: a, refs: r() < 0.7 ? [{ kind: 'new', name: pick(names), amount: a, dueDate: r() < 0.3 ? '2024-05-01' : null }] : [] }) }
  }
  for (let i = 0; i < n; i++) {
    d += Math.floor(r() * 200) * 86400000 // across FYs
    const date = new Date(d).toISOString().slice(0, 10)
    const sign = r() < 0.5 ? 1 : -1
    const total = amt()
    const refs: BillRef[] = []
    const mode = r()
    if (mode < 0.35) { /* refless */ }
    else {
      let left = total
      const parts = 1 + Math.floor(r() * 3)
      for (let p = 0; p < parts && left > 0; p++) {
        const a = p === parts - 1 ? left : Math.max(1, Math.floor(left * r()))
        left -= a
        refs.push({ kind: r() < 0.5 ? 'new' : 'against', name: pick(names), amount: a, dueDate: r() < 0.2 ? date : null })
      }
      if (r() < 0.1 && refs.length) refs[0]!.amount += 7 // refs not summing
    }
    evs.push({ voucherId: r() < 0.05 ? null : i + 1, date, number: r() < 0.3 ? pick(names) : String(i + 1), amount: r() < 0.03 ? 0 : sign * total, refs })
  }
  return evs
}

describe('bill allocation: the incremental engine = origin/main\'s, case for case', () => {
  it('identical on 50k random event lists', () => {
    for (let seed = 1; seed <= 50000; seed++) {
      const r = rng(seed)
      const evs = gen(r)
      const cd = r() < 0.3 ? null : Math.floor(r() * 60)
      const asOn = r() < 0.5 ? '2026-11-04' : '2025-01-01'
      const clone = () => JSON.parse(JSON.stringify(evs)) as BillEvent[]
      const a = A.allocateBillsWithCredits(clone(), asOn, cd)
      const b = B.allocateBillsWithCredits(clone(), asOn, cd)
      expect(JSON.stringify(b), `seed ${seed}`).toBe(JSON.stringify(a))
      const a2 = A.allocateBills(clone(), asOn, cd), b2 = B.allocateBills(clone(), asOn, cd)
      expect(JSON.stringify(b2), `seed ${seed}`).toBe(JSON.stringify(a2))
      // incremental: apply one by one = list
      const al = B.billAllocator(cd); for (const e of clone()) al.apply(e)
      expect(JSON.stringify(al.result(asOn)), `seed ${seed}`).toBe(JSON.stringify(a))
    }
  }, 60_000)
})
