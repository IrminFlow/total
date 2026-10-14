// WP 7.1 — the large-company generator is deterministic: the same seed writes the same books
// (counts and a hash of totals), another seed different ones, and it writes exactly the number
// of vouchers asked for through the services (the audit trail holds one create per voucher).
import { describe, it, expect } from 'vitest'
import { freshDb } from '../db/testdb'
import { verifyAudit } from '../services/audit'
import { trialBalance } from '../services/reports'
import { booksFingerprint, PERF_TODAY, seedLarge } from './seedLarge'
import { fingerprintHash } from './cli'

const N = 3_000
/** The fingerprint hash of seedLarge({ vouchers: 3000 }) — update only for a deliberate change
 *  to the generator (or to what the services store for the same input). */
const PINNED = '5a1fb2bbe4e765ab2f42b567c27e3f45a79bb02eaf58b139ac51fa7285b493d3'

describe('seedLarge (WP 7.1)', () => {
  const a = freshDb()
  const summary = seedLarge(a, { vouchers: N })
  const fp = booksFingerprint(a)

  it('writes exactly N vouchers of every kind, through the services', () => {
    expect(summary.vouchers).toBe(N)
    expect(fp.vouchers).toBe(N)
    expect(Object.keys(summary.byKind).sort()).toEqual(['contra', 'credit_note', 'debit_note', 'journal', 'payment', 'purchase', 'receipt', 'sales', 'stock_journal'])
    expect(fp.binned).toBe(summary.binned)
    expect(Number(fp.lineLinks)).toBeGreaterThan(0)
    expect(Number(fp.openingBills)).toBeGreaterThan(0)
    const creates = (a.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity = 'voucher' AND action = 'create'").get() as { n: number }).n
    expect(creates).toBe(N)
    expect(verifyAudit(a).ok).toBe(true)
    // Balanced books: the trial balance agrees (openings included).
    const tb = trialBalance(a, PERF_TODAY)
    expect(tb.totalDebit).toBe(tb.totalCredit)
  })

  it('is deterministic: the same seed gives the same books, another seed different ones', () => {
    const b = freshDb()
    seedLarge(b, { vouchers: N })
    expect(booksFingerprint(b)).toEqual(fp)
    const c = freshDb()
    seedLarge(c, { vouchers: N, seed: 42 })
    expect(booksFingerprint(c)).not.toEqual(fp)
    expect(fingerprintHash(fp)).toBe(PINNED)
  })
})
