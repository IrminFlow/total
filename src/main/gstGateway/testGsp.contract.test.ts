// The gateway adapter contract against the built-in Test GSP (every capability; no DB, no network).
import { createTestGsp, memoryTestGspState, TEST_GSP_OTP, TEST_GSP_PASSWORD, TEST_GSP_USERNAME } from './testGsp'
import { CONTRACT_GSTIN, runGatewayContract, type ContractClock } from './contract.testutil'

/** 20 Aug 2026, 10:00 IST — July's GSTR-2B (generated 14 Aug) exists, August's does not. */
const START = Date.parse('2026-08-20T10:00:00+05:30')

function clock(): ContractClock {
  let t = START
  return { now: () => t, advance: (ms) => { t += ms } }
}

runGatewayContract('Test GSP', () => {
  const c = clock()
  return {
    adapter: createTestGsp({
      state: memoryTestGspState(),
      now: c.now,
      ratePerMinute: 30,
      inwardFor: (_gstin, period) => (period === '072026'
        ? [{ supplierGstin: '29AACCR7832C1ZD', supplierName: 'Rao Traders', kind: 'invoice', number: 'R-77', date: '2026-07-03', value: 118000_00, taxable: 100000_00, igst: 18000_00, cgst: 0, sgst: 0, cess: 0, reverseCharge: false }]
        : [])
    }),
    who: { gstin: CONTRACT_GSTIN, username: TEST_GSP_USERNAME, password: TEST_GSP_PASSWORD },
    badWho: { gstin: CONTRACT_GSTIN, username: TEST_GSP_USERNAME, password: 'not-the-password' },
    clock: c,
    otp: TEST_GSP_OTP,
    gstr2b: { period: '072026', expectInvoices: 1 },
    rateLimit: 30
  }
})
