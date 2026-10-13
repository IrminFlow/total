// GST rate slabs for the plain rate picker (WP 8.4, plan 2026-10-13 §4.2). Pure data with sources.
//
// Tax rules are never written from memory: every slab below cites the notification that sets it,
// and what could not be checked against the official text is listed in GST_RATE_UNVERIFIED.
// This table offers the SLABS only — which slab a product falls in is the HSN-level mapping in the
// schedules of the notifications, OUT OF SCOPE here (plan §4.2 / owner decision D4: a bundled,
// cited HSN list comes later). The picker therefore never pre-picks a rate: blank and required in
// a regular company (WP 8.0), the user picks it (0 for nil-rated / exempt goods), and "Other
// rate" stays open for a rate the table does not list.
//
// Rates are the TOTAL rate (IGST = CGST + SGST); the Central Tax notifications list the CGST half.

export interface GstSlab {
  /** Total GST rate, percent. */
  rate: number
  /** Common = shown first; special = listed under "other rates" (gold, rough diamonds, …). */
  common: boolean
  /** Plain hint for the picker (English; the simple dialog shows its own t() text). */
  note: string
}

export interface GstRatePeriod {
  /** First day the slabs apply (ISO). */
  from: string
  /** Last day (ISO, inclusive); null = still in force. */
  to: string | null
  slabs: readonly GstSlab[]
  sources: readonly string[]
}

const NIL = 'Nil-rated or exempt'

export const GST_RATE_TABLE: readonly GstRatePeriod[] = [
  {
    from: '2017-07-01',
    to: '2025-09-21',
    slabs: [
      { rate: 0, common: true, note: NIL },
      { rate: 5, common: true, note: 'Schedule I' },
      { rate: 12, common: true, note: 'Schedule II' },
      { rate: 18, common: true, note: 'Schedule III' },
      { rate: 28, common: true, note: 'Schedule IV' },
      { rate: 3, common: false, note: 'Schedule V (gold, silver, jewellery)' },
      { rate: 0.25, common: false, note: 'Schedule VI (rough diamonds, precious stones)' }
    ],
    sources: [
      'Notification No. 1/2017-Central Tax (Rate), 28 June 2017 — Schedules I–VI: CGST 2.5% / 6% / 9% / 14% / 1.5% / 0.125% (with equal SGST / UTGST; IGST at twice the rate under Notification No. 1/2017-Integrated Tax (Rate))',
      'Notification No. 2/2017-Central Tax (Rate), 28 June 2017 — goods exempt from CGST (nil)',
      'Notification No. 11/2017-Central Tax (Rate), 28 June 2017 — rates on services'
    ]
  },
  {
    from: '2025-09-22',
    to: '2026-01-31',
    slabs: [
      { rate: 0, common: true, note: NIL },
      { rate: 5, common: true, note: 'Schedule I' },
      { rate: 18, common: true, note: 'Schedule II' },
      { rate: 40, common: false, note: 'Schedule III (luxury and sin goods)' },
      { rate: 3, common: false, note: 'Schedule IV (gold, silver, jewellery)' },
      { rate: 0.25, common: false, note: 'Schedule V (rough diamonds, precious stones)' },
      { rate: 1.5, common: false, note: 'Schedule VI' },
      { rate: 28, common: false, note: 'Schedule VII (a few goods)' }
    ],
    sources: [
      'Notification No. 9/2025-Central Tax (Rate), 17 September 2025, in force from 22 September 2025 (56th GST Council) — Schedules I–VII: CGST 2.5% / 9% / 20% / 1.5% / 0.125% / 0.75% / 14%; Notification No. 9/2025-Integrated Tax (Rate) lists the same seven slabs at 5% / 18% / 40% / 3% / 0.25% / 1.5% / 28%',
      'Notification No. 10/2025-Central Tax (Rate), 17 September 2025 — goods exempt (nil)'
    ]
  },
  {
    from: '2026-02-01',
    to: null,
    slabs: [
      { rate: 0, common: true, note: NIL },
      { rate: 5, common: true, note: 'Schedule I' },
      { rate: 18, common: true, note: 'Schedule II' },
      { rate: 40, common: false, note: 'Schedule III (luxury and sin goods, now incl. pan masala / tobacco)' },
      { rate: 3, common: false, note: 'Schedule IV (gold, silver, jewellery)' },
      { rate: 0.25, common: false, note: 'Schedule V (rough diamonds, precious stones)' },
      { rate: 1.5, common: false, note: 'Schedule VI' }
    ],
    sources: [
      'Notification No. 19/2025-Central Tax (Rate), 31 December 2025, in force from 1 February 2026 — omits Schedule VII (CGST 14%, i.e. 28%); pan masala / tobacco goods move to Schedule III (CGST 20%, i.e. 40%), biris to 18%',
      'Notification No. 9/2025-Central Tax (Rate), 17 September 2025 — Schedules I–VI as amended'
    ]
  }
]

/** Compensation cess: a separate levy, not offered by the picker (the full item form keeps its own
 *  cess field). Which goods still carry it changed twice — see GST_RATE_UNVERIFIED — so the note
 *  names no goods. */
export const GST_CESS_NOTE = {
  note: 'A few goods may carry cess on top of GST; set it in the full product form if yours does.',
  sources: [
    'Goods and Services Tax (Compensation to States) Act, 2017, s.8 and Schedule',
    'Notification No. 1/2017-Compensation Cess (Rate), 28 June 2017',
    'Notification No. 02/2025-Compensation Cess (Rate) — nil cess on goods other than tobacco from 22 September 2025 (secondary sources)'
  ]
} as const

/** What this table states but could not be checked against the official text. */
export const GST_RATE_UNVERIFIED: readonly string[] = [
  'The 2025 and 2026 slabs and schedule numbering come from secondary copies / summaries, not the Gazette text: Notification No. 9/2025-Central Tax (Rate) (https://www.taxheal.com/?p=104997, https://a2ztaxcorp.net/cbic-notifies-new-igst-goods-rate-notification-effective-from-22nd-september-2025/, West Bengal tax department monthly update, TexProCil circular 158/2025) and Notification No. 19/2025-Central Tax (Rate) (text reproduced at https://taxo.online, summary at https://www.taxmann.com); CBIC rates page https://cbic-gst.gov.in/gst-goods-services-rates.html not re-read.',
  'Rates on SERVICES after 22 September 2025 (the services notification replacing No. 11/2017) are not reflected — whether 12% or 28% remain for any service is unverified.',
  'Compensation cess: nil on goods other than tobacco from 22 September 2025 (Notification No. 02/2025-Compensation Cess (Rate)), and ended on tobacco from 1 February 2026 (replaced by central excise plus a new cess) — both per secondary sources only.',
  'Biris at 18% from 1 February 2026 (Notification No. 19/2025-Central Tax (Rate)) — secondary sources only.',
  'Which product falls in which slab (the HSN mapping) is not covered at all — the user picks the slab.'
]

/** The period in force on `date` (ISO). Before the first period → the first one. */
export function ratePeriodOn(date: string): GstRatePeriod {
  return GST_RATE_TABLE.find((p) => p.from <= date && (p.to == null || date <= p.to)) ?? GST_RATE_TABLE[0]!
}

/** Slabs on `date`, common ones first in rate order, then the special ones. */
export function slabsOn(date: string): GstSlab[] {
  const s = [...ratePeriodOn(date).slabs]
  return [...s.filter((x) => x.common).sort((a, b) => a.rate - b.rate), ...s.filter((x) => !x.common).sort((a, b) => a.rate - b.rate)]
}
