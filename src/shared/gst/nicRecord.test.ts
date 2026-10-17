import { describe, expect, it } from 'vitest'
import { ewbCancelWindow, ewbExtendWindow, irnCancelWindow, istLabel, nicTimestampMs } from './nicRecord'

const H = 3600 * 1000

describe('NIC timestamps (read as IST — UNVERIFIED)', () => {
  it('reads the e-invoice API form and the EWB API form', () => {
    expect(nicTimestampMs('2026-08-20 11:00:00')).toBe(Date.UTC(2026, 7, 20, 5, 30))
    expect(nicTimestampMs('20/08/2026 11:00:00 AM')).toBe(Date.UTC(2026, 7, 20, 5, 30))
    expect(nicTimestampMs('20/08/2026 12:05:00 PM')).toBe(Date.UTC(2026, 7, 20, 6, 35))
    expect(nicTimestampMs('20/08/2026 12:05:00 AM')).toBe(Date.UTC(2026, 7, 19, 18, 35))
    expect(nicTimestampMs('27/08/2026 11:59:00 PM')).toBe(Date.UTC(2026, 7, 27, 18, 29))
    expect(nicTimestampMs('soon')).toBeNull()
    expect(nicTimestampMs(null)).toBeNull()
    expect(istLabel(Date.UTC(2026, 7, 20, 5, 30))).toBe('20 Aug 2026, 11:00 IST')
  })
})

describe('the windows', () => {
  const ack = '2026-08-20 11:00:00'
  const ackMs = Date.UTC(2026, 7, 20, 5, 30)
  const live = { irn: 'a'.repeat(64), irnCancelledAt: null, ackDate: ack, ewbNo: null }

  it('Cancel IRN: within 24 h of AckDt ([CNL]), not with an active e-way bill, never twice', () => {
    expect(irnCancelWindow(live, ackMs + 23 * H)).toEqual({ allowed: true, reason: null, opensAt: ackMs, closesAt: ackMs + 24 * H })
    expect(irnCancelWindow(live, ackMs + 24 * H)).toMatchObject({ allowed: true })
    expect(irnCancelWindow(live, ackMs + 24 * H + 1)).toMatchObject({ allowed: false, reason: 'The 24-hour window to cancel this IRN closed on 21 Aug 2026, 11:00 IST — issue a credit note instead' })
    expect(irnCancelWindow({ ...live, ewbNo: '391000000001' }, ackMs + H)).toMatchObject({ allowed: false, reason: expect.stringMatching(/^Cancel the e-way bill first/) })
    expect(irnCancelWindow({ ...live, irnCancelledAt: '2026-08-20 12:00:00' }, ackMs + H)).toMatchObject({ allowed: false, reason: 'The IRN is already cancelled' })
    expect(irnCancelWindow({ ...live, irn: null }, ackMs)).toMatchObject({ allowed: false })
    // An unreadable AckDt leaves the deadline to the portal.
    expect(irnCancelWindow({ ...live, ackDate: null }, ackMs + 99 * H)).toEqual({ allowed: true, reason: null, opensAt: null, closesAt: null })
  })

  it('Cancel e-way bill: within 24 h of EwbDt ([CEWB])', () => {
    expect(ewbCancelWindow({ ewbNo: '391000000001', ewbDate: ack }, ackMs + 23 * H)).toMatchObject({ allowed: true, closesAt: ackMs + 24 * H })
    expect(ewbCancelWindow({ ewbNo: '391000000001', ewbDate: ack }, ackMs + 25 * H)).toMatchObject({ allowed: false, reason: expect.stringMatching(/24-hour window to cancel this e-way bill closed on 21 Aug 2026/) })
    expect(ewbCancelWindow({ ewbNo: null, ewbDate: ack }, ackMs)).toMatchObject({ allowed: false, reason: 'This voucher has no e-way bill' })
  })

  it('Extend validity: from 8 h before to 8 h after expiry ([EXT]); a Part-A-only bill has nothing to extend', () => {
    const until = '2026-08-22 23:59:00'
    const untilMs = Date.UTC(2026, 7, 22, 18, 29)
    const r = { ewbNo: '391000000001', ewbValidUpto: until }
    expect(ewbExtendWindow(r, untilMs - 8 * H - 1)).toMatchObject({ allowed: false, reason: 'Validity can be extended from 22 Aug 2026, 15:59 IST (8 hours before it expires)' })
    expect(ewbExtendWindow(r, untilMs - 8 * H)).toEqual({ allowed: true, reason: null, opensAt: untilMs - 8 * H, closesAt: untilMs + 8 * H })
    expect(ewbExtendWindow(r, untilMs + 8 * H)).toMatchObject({ allowed: true })
    expect(ewbExtendWindow(r, untilMs + 8 * H + 1)).toMatchObject({ allowed: false, reason: 'The extension window closed on 23 Aug 2026, 07:59 IST (8 hours after expiry)' })
    expect(ewbExtendWindow({ ewbNo: '391000000001', ewbValidUpto: null }, untilMs)).toMatchObject({ allowed: false, reason: expect.stringMatching(/no validity yet/) })
  })
})
