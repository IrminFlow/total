// GST golden fixtures (Phase 2a): hand-worked bills. Every expected figure below was worked out
// by hand from the inputs, with the arithmetic in the comment above it — never by running the app.
//
// Conventions used in the working:
//  - tax per LINE (rule 46 invoice particulars; the e-invoice validates each item's tax): a line's
//    CGST / SGST is taxable × (rate ÷ 2) %, its IGST taxable × rate %, cess taxable × cess %; each
//    rounded to the paisa, half away from zero; the bill's tax is the sum of its lines' tax.
//  - the bill is rounded to the nearest rupee, half up; the difference is the round off.
//  - GSTR-1 / 3B / e-invoice figures are the bill's own figures placed in the table the rules
//    name (the classification is stated per fixture). Company: Maharashtra (27), regular, unless
//    the fixture says otherwise.
//
// Months: each fixture's document is the only document of its month in its company (earlier
// documents in `before` sit in earlier months), so a month's GSTR-1 / 3B is that document's.

import type { GoldenFixture } from './types'

export const FIXTURES: GoldenFixture[] = [
  // ───────────────────────── B2B, intra-state ─────────────────────────
  {
    id: 'B2B-01', title: 'Intra-state B2B, one 18% line',
    // 10 × ₹1,000 = ₹10,000. CGST 9% = 900, SGST 9% = 900. Total 11,800.00, no round off.
    doc: { kind: 'sales', date: '2025-05-05', number: 'G101', party: 'regMH', rows: [{ item: 'widget', qty: '10', rate: 1000 }] },
    expect: { lines: [{ taxable: 10000, rate: 18, cgst: 900, sgst: 900 }], roundOff: 0, total: 11800, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-02', title: 'Inter-state B2B, one 18% line',
    // 5 × ₹2,400 = ₹12,000. Buyer in Karnataka (29) ≠ 27 → IGST 18% = 2,160. Total 14,160.
    doc: { kind: 'sales', date: '2025-05-06', number: 'G102', party: 'regKA', rows: [{ item: 'widget', qty: '5', rate: 2400 }] },
    expect: { lines: [{ taxable: 12000, rate: 18, igst: 2160 }], roundOff: 0, total: 14160, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-03', title: 'Intra-state B2B, mixed 18% and 5%',
    // Widget 2 × 1,500 = 3,000 → CGST 270, SGST 270.
    // Rice 40 kg × 62.50 = 2,500 → 2.5% = 62.50 each.
    // Taxable 5,500; CGST 332.50; SGST 332.50; total 6,165.00 exactly.
    doc: { kind: 'sales', date: '2025-05-07', number: 'G103', party: 'regMH', rows: [{ item: 'widget', qty: '2', rate: 1500 }, { item: 'rice', qty: '40', rate: 62.5 }] },
    expect: {
      lines: [{ taxable: 3000, rate: 18, cgst: 270, sgst: 270 }, { taxable: 2500, rate: 5, cgst: 62.5, sgst: 62.5 }],
      roundOff: 0, total: 6165, gstr1: 'b2b', einvoice: true
    }
  },
  {
    id: 'B2B-04', title: 'Line discount',
    // 4 × 1,250 = 5,000 gross, less discount 500 = taxable 4,500. CGST 9% = 405, SGST 405. Total 5,310.
    doc: { kind: 'sales', date: '2025-05-08', number: 'G104', party: 'regMH', rows: [{ item: 'widget', qty: '4', rate: 1250, discount: 500 }] },
    expect: { lines: [{ taxable: 4500, rate: 18, cgst: 405, sgst: 405, gross: 5000, discount: 500 }], roundOff: 0, total: 5310, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-05', title: 'Round off upwards',
    // 1 × 101.35. 9% of 101.35 = 9.1215 → 9.12 each. 101.35 + 18.24 = 119.59 → 120.00, round off +0.41.
    doc: { kind: 'sales', date: '2025-05-09', number: 'G105', party: 'regMH', rows: [{ item: 'widget', qty: '1', rate: 101.35 }] },
    expect: { lines: [{ taxable: 101.35, rate: 18, cgst: 9.12, sgst: 9.12 }], roundOff: 0.41, total: 120, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-06', title: 'Round off downwards',
    // 1 × 101.00. 9% = 9.09 each. 101.00 + 18.18 = 119.18 → 119.00, round off −0.18.
    // The invoice value (GSTR-1 val, e-invoice TotInvVal) is the bill's total, 119.00.
    doc: { kind: 'sales', date: '2025-05-12', number: 'G106', party: 'regMH', rows: [{ item: 'widget', qty: '1', rate: 101 }] },
    expect: { lines: [{ taxable: 101, rate: 18, cgst: 9.09, sgst: 9.09 }], roundOff: -0.18, total: 119, gstr1: 'b2b', einvoice: true },
    knownBug: { in: ['gstr1', 'einvoice'], reason: 'A rounded-DOWN bill: GSTR-1 val and the e-invoice TotInvVal report the unrounded 119.18 with RndOffAmt 0 — the round off sits on the party side, so the debit total is the unrounded figure' }
  },
  {
    id: 'B2B-07', title: 'Tax per line, not per rate group',
    // Two lines of 1 × 10.05. Per line 9% of 10.05 = 0.9045 → 0.90; two lines: CGST 1.80, SGST 1.80.
    // (Rounded once on 20.10 it would be 1.809 → 1.81 — the per-line rule gives 1.80.)
    // 20.10 + 3.60 = 23.70 → 24.00, round off +0.30.
    doc: { kind: 'sales', date: '2025-05-13', number: 'G107', party: 'regMH', rows: [{ item: 'widget', qty: '1', rate: 10.05 }, { item: 'widget', qty: '1', rate: 10.05 }] },
    expect: {
      lines: [{ taxable: 10.05, rate: 18, cgst: 0.9, sgst: 0.9 }, { taxable: 10.05, rate: 18, cgst: 0.9, sgst: 0.9 }],
      roundOff: 0.3, total: 24, gstr1: 'b2b', einvoice: true
    }
  },
  {
    id: 'B2B-08', title: 'Compensation cess, intra-state',
    // 100 × 30 = 3,000 at 28% + 12% cess. CGST 14% = 420, SGST 420, cess 12% = 360. Total 4,200.
    doc: { kind: 'sales', date: '2025-06-02', number: 'G108', party: 'regMH', rows: [{ item: 'cola', qty: '100', rate: 30 }] },
    expect: { lines: [{ taxable: 3000, rate: 28, cgst: 420, sgst: 420, cess: 360, cessRate: 12 }], roundOff: 0, total: 4200, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-09', title: 'Compensation cess, inter-state',
    // 50 × 30 = 1,500. IGST 28% = 420, cess 12% = 180. Total 2,100.
    doc: { kind: 'sales', date: '2025-06-03', number: 'G109', party: 'regKA', rows: [{ item: 'cola', qty: '50', rate: 30 }] },
    expect: { lines: [{ taxable: 1500, rate: 28, igst: 420, cess: 180, cessRate: 12 }], roundOff: 0, total: 2100, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-10', title: '3% (gold), round off up',
    // 1 × 51,234.56. 1.5% = 768.5184 → 768.52 each. 51,234.56 + 1,537.04 = 52,771.60 → 52,772.00, +0.40.
    doc: { kind: 'sales', date: '2025-06-04', number: 'G110', party: 'regMH', rows: [{ item: 'gold', qty: '1', rate: 51234.56 }] },
    expect: { lines: [{ taxable: 51234.56, rate: 3, cgst: 768.52, sgst: 768.52 }], roundOff: 0.4, total: 52772, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-11', title: 'Taxable and nil-rated lines on one bill',
    // Widget 1 × 1,000 → 90 + 90. Milk 10 L × 60 = 600 at 0% (nil-rated).
    // Total 1,000 + 180 + 600 = 1,780. GSTR-1: the 18% line in 4A, the 600 in Table 8 (intra-state,
    // registered); 3B: 1,000 in 3.1(a), 600 in 3.1(c).
    doc: { kind: 'sales', date: '2025-06-05', number: 'G111', party: 'regMH', rows: [{ item: 'widget', qty: '1', rate: 1000 }, { item: 'milk', qty: '10', rate: 60 }] },
    expect: { lines: [{ taxable: 1000, rate: 18, cgst: 90, sgst: 90 }, { taxable: 600, rate: 0 }], roundOff: 0, total: 1780, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-12', title: 'Quantity with decimals',
    // Rice 12.25 kg × 52.00 = 637.00. 2.5% = 15.925 → 15.93 each. 637.00 + 31.86 = 668.86 → 669.00, +0.14.
    doc: { kind: 'sales', date: '2025-06-06', number: 'G112', party: 'regMH', rows: [{ item: 'rice', qty: '12.25', rate: 52 }] },
    expect: { lines: [{ taxable: 637, rate: 5, cgst: 15.93, sgst: 15.93 }], roundOff: 0.14, total: 669, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-13', title: 'Inter-state, three rates',
    // Widget 1 × 2,000 → IGST 18% 360. Shirt 5 × 400 = 2,000 → 12% 240. Rice 10 × 60 = 600 → 5% 30.
    // Taxable 4,600; IGST 630; total 5,230.
    doc: { kind: 'sales', date: '2025-06-09', number: 'G113', party: 'regKA', rows: [{ item: 'widget', qty: '1', rate: 2000 }, { item: 'shirt', qty: '5', rate: 400 }, { item: 'rice', qty: '10', rate: 60 }] },
    expect: {
      lines: [{ taxable: 2000, rate: 18, igst: 360 }, { taxable: 2000, rate: 12, igst: 240 }, { taxable: 600, rate: 5, igst: 30 }],
      roundOff: 0, total: 5230, gstr1: 'b2b', einvoice: true
    }
  },
  {
    id: 'B2B-14', title: 'Place of supply overridden to another state',
    // Registered Maharashtra buyer, goods delivered in Karnataka: POS 29 → inter-state.
    // 1 × 1,000 → IGST 180 → 1,180. GSTR-1 4A pos 29; e-invoice BuyerDtls.Pos 29, Stcd 27.
    doc: { kind: 'sales', date: '2025-06-10', number: 'G114', party: 'regMH', posOverride: '29', rows: [{ item: 'widget', qty: '1', rate: 1000 }] },
    expect: { lines: [{ taxable: 1000, rate: 18, igst: 180 }], roundOff: 0, total: 1180, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-15', title: 'Discounts on two rates, half-rupee round off',
    // Widget 2 × 1,000 = 2,000 less 100 = 1,900 → 9% = 171 each.
    // Rice 10 × 60 = 600 less 30 = 570 → 2.5% = 14.25 each.
    // Taxable 2,470; CGST 185.25; SGST 185.25; 2,840.50 → 2,841.00 (half up), +0.50.
    doc: { kind: 'sales', date: '2025-06-11', number: 'G115', party: 'regMH', rows: [{ item: 'widget', qty: '2', rate: 1000, discount: 100 }, { item: 'rice', qty: '10', rate: 60, discount: 30 }] },
    expect: {
      lines: [{ taxable: 1900, rate: 18, cgst: 171, sgst: 171, gross: 2000, discount: 100 }, { taxable: 570, rate: 5, cgst: 14.25, sgst: 14.25, gross: 600, discount: 30 }],
      roundOff: 0.5, total: 2841, gstr1: 'b2b', einvoice: true
    }
  },
  {
    id: 'B2B-16', title: '28% goods',
    // Cement 50 × 350 = 17,500. 14% = 2,450 each. Total 22,400.
    doc: { kind: 'sales', date: '2025-06-12', number: 'G116', party: 'regMH', rows: [{ item: 'cement', qty: '50', rate: 350 }] },
    expect: { lines: [{ taxable: 17500, rate: 28, cgst: 2450, sgst: 2450 }], roundOff: 0, total: 22400, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-17', title: '12% goods, round off up',
    // Shirt 10 × 799 = 7,990. 6% = 479.40 each. 7,990 + 958.80 = 8,948.80 → 8,949.00, +0.20.
    doc: { kind: 'sales', date: '2025-06-13', number: 'G117', party: 'regMH', rows: [{ item: 'shirt', qty: '10', rate: 799 }] },
    expect: { lines: [{ taxable: 7990, rate: 12, cgst: 479.4, sgst: 479.4 }], roundOff: 0.2, total: 8949, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'B2B-18', title: 'Half paisa rounds away from zero',
    // Rice 1 × 99.00. 2.5% = 2.475 → 2.48 each. 99.00 + 4.96 = 103.96 → 104.00, +0.04.
    doc: { kind: 'sales', date: '2025-06-16', number: 'G118', party: 'regMH', rows: [{ item: 'rice', qty: '1', rate: 99 }] },
    expect: { lines: [{ taxable: 99, rate: 5, cgst: 2.48, sgst: 2.48 }], roundOff: 0.04, total: 104, gstr1: 'b2b', einvoice: true }
  },

  // ─────────────── ledger-line (amount-only) bills — the posted-tax rate rule ───────────────
  {
    id: 'LDG-01', title: 'Service bill on a ledger with its own 18% rate',
    // Accounting form: Consulting Fees (18%, SAC 998311) 10,000; CGST 900; SGST 900; party 11,800.
    doc: {
      kind: 'sales', date: '2025-07-01', number: 'G201', party: 'regMH',
      lines: [{ ledger: 'party', side: 'dr', amount: 11800 }, { ledger: 'consulting', side: 'cr', amount: 10000 }, { ledger: 'cgstOut', side: 'cr', amount: 900 }, { ledger: 'sgstOut', side: 'cr', amount: 900 }]
    },
    expect: { lines: [{ taxable: 10000, rate: 18, cgst: 900, sgst: 900 }], roundOff: 0, total: 11800, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'LDG-02', title: 'Amount-only bill on a rate-less ledger: rate from the posted tax',
    // Service Income (no rate, SAC 998313) 2,000; CGST 180; SGST 180; party 2,360.
    // 180 ÷ 2,000 = 9% per half → the 18% slab.
    doc: {
      kind: 'sales', date: '2025-07-02', number: 'G202', party: 'regMH',
      lines: [{ ledger: 'party', side: 'dr', amount: 2360 }, { ledger: 'serviceIncome', side: 'cr', amount: 2000 }, { ledger: 'cgstOut', side: 'cr', amount: 180 }, { ledger: 'sgstOut', side: 'cr', amount: 180 }]
    },
    expect: { lines: [{ taxable: 2000, rate: 18, cgst: 180, sgst: 180 }], roundOff: 0, total: 2360, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'LDG-03', title: 'Amount-only bill to an unregistered buyer in another state (B2CS)',
    // Sales (no rate) 5,000; IGST 600; party 5,600. 600 ÷ 5,000 = 12% slab. Inter-state, unregistered,
    // value 5,600 ≤ limit → B2CS INTER, POS 29; 3B 3.2 lists POS 29: 5,000 / 600.
    doc: {
      kind: 'sales', date: '2025-07-03', number: 'G203', party: 'urKA',
      lines: [{ ledger: 'party', side: 'dr', amount: 5600 }, { ledger: 'sales', side: 'cr', amount: 5000 }, { ledger: 'igstOut', side: 'cr', amount: 600 }]
    },
    expect: { lines: [{ taxable: 5000, rate: 12, igst: 600 }], roundOff: 0, total: 5600, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'LDG-04', title: 'Amount-only bill with rupee-rounded tax',
    // Service Income (no rate) 1,234.00; CGST 111.00; SGST 111.00 (the user typed the tax rounded to
    // the rupee: 9% of 1,234 = 111.06); party 1,456.00. 111 ÷ 1,234 = 8.995% — within the line's
    // rounding + ₹1 of 9% → the 18% slab. The reported tax is what the bill posts (111.00 each).
    doc: {
      kind: 'sales', date: '2025-07-04', number: 'G204', party: 'urMH',
      lines: [{ ledger: 'party', side: 'dr', amount: 1456 }, { ledger: 'serviceIncome', side: 'cr', amount: 1234 }, { ledger: 'cgstOut', side: 'cr', amount: 111 }, { ledger: 'sgstOut', side: 'cr', amount: 111 }]
    },
    // The tax reported is the tax the bill charged: 111.00 + 111.00 (GSTR-1 B2CS, 3B 3.1(a)).
    expect: { lines: [{ taxable: 1234, rate: 18, cgst: 111, sgst: 111 }], roundOff: 0, total: 1456, gstr1: 'b2cs', einvoice: false },
    knownBug: { in: ['gstr1', 'gstr3b'], reason: 'Tax typed rounded to the rupee (111.00) is reported recomputed at the inferred rate (111.06), not as charged on the bill' }
  },

  // ───────────────────────── B2C ─────────────────────────
  {
    id: 'B2C-01', title: 'B2CS intra-state',
    // 3 × 500 = 1,500 → 135 + 135 → 1,770. Unregistered, intra-state → B2CS INTRA, POS 27.
    doc: { kind: 'sales', date: '2025-07-07', number: 'G301', party: 'urMH', rows: [{ item: 'widget', qty: '3', rate: 500 }] },
    expect: { lines: [{ taxable: 1500, rate: 18, cgst: 135, sgst: 135 }], roundOff: 0, total: 1770, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'B2C-02', title: 'B2CL from 1 Aug 2024 (limit ₹1 lakh)',
    // 1 × 1,50,000 → IGST 27,000 → 1,77,000 > ₹1,00,000 (limit from 1 Aug 2024, Notification
    // 12/2024-CT) and inter-state to an unregistered buyer → B2CL, POS 29.
    doc: { kind: 'sales', date: '2024-08-05', number: 'G302', party: 'urKA', rows: [{ item: 'widget', qty: '1', rate: 150000 }] },
    expect: { lines: [{ taxable: 150000, rate: 18, igst: 27000 }], roundOff: 0, total: 177000, gstr1: 'b2cl', einvoice: false }
  },
  {
    id: 'B2C-03', title: 'Same bill before 1 Aug 2024 stays B2CS (limit ₹2.5 lakh)',
    // 1,77,000 ≤ ₹2,50,000 (the limit until 31 Jul 2024) → B2CS INTER, POS 29.
    doc: { kind: 'sales', date: '2024-07-20', number: 'G303', party: 'urKA', rows: [{ item: 'widget', qty: '1', rate: 150000 }] },
    expect: { lines: [{ taxable: 150000, rate: 18, igst: 27000 }], roundOff: 0, total: 177000, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'B2C-04', title: 'Exactly ₹1,00,000 is not "more than" the limit',
    // Gold 1 × 97,087.38; IGST 3% = 2,912.6214 → 2,912.62; total 1,00,000.00 → not > 1,00,000 → B2CS.
    doc: { kind: 'sales', date: '2025-07-08', number: 'G304', party: 'urKA', rows: [{ item: 'gold', qty: '1', rate: 97087.38 }] },
    expect: { lines: [{ taxable: 97087.38, rate: 3, igst: 2912.62 }], roundOff: 0, total: 100000, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'B2C-05', title: 'Just above ₹1,00,000 is B2CL',
    // Gold 1 × 97,088.35; IGST 3% = 2,912.6505 → 2,912.65; total 1,00,001.00 → B2CL, POS 29.
    doc: { kind: 'sales', date: '2025-07-09', number: 'G305', party: 'urKA', rows: [{ item: 'gold', qty: '1', rate: 97088.35 }] },
    expect: { lines: [{ taxable: 97088.35, rate: 3, igst: 2912.65 }], roundOff: 0, total: 100001, gstr1: 'b2cl', einvoice: false }
  },
  {
    id: 'B2C-06', title: 'A large intra-state B2C bill is still B2CS',
    // 1 × 2,00,000 → 18,000 + 18,000 → 2,36,000. B2CL is inter-state only → B2CS INTRA.
    doc: { kind: 'sales', date: '2025-07-10', number: 'G306', party: 'urMH', rows: [{ item: 'widget', qty: '1', rate: 200000 }] },
    expect: { lines: [{ taxable: 200000, rate: 18, cgst: 18000, sgst: 18000 }], roundOff: 0, total: 236000, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'B2C-07', title: 'B2CS with two rates, half rupee rounds up',
    // Widget 1 × 500 → 45 + 45. Rice 4 kg × 62.50 = 250 → 6.25 + 6.25.
    // Taxable 750; CGST 51.25; SGST 51.25; 852.50 → 853.00, +0.50. B2CS: one row per rate.
    doc: { kind: 'sales', date: '2025-07-11', number: 'G307', party: 'urMH', rows: [{ item: 'widget', qty: '1', rate: 500 }, { item: 'rice', qty: '4', rate: 62.5 }] },
    expect: {
      lines: [{ taxable: 500, rate: 18, cgst: 45, sgst: 45 }, { taxable: 250, rate: 5, cgst: 6.25, sgst: 6.25 }],
      roundOff: 0.5, total: 853, gstr1: 'b2cs', einvoice: false
    }
  },
  {
    id: 'B2C-08', title: 'B2CS inter-state with cess',
    // Cola 10 × 30 = 300 to Tamil Nadu (33). IGST 28% = 84; cess 12% = 36. Total 420.
    // 3B 3.2: POS 33, 300 / 84.
    doc: { kind: 'sales', date: '2025-07-14', number: 'G308', party: 'urTN', rows: [{ item: 'cola', qty: '10', rate: 30 }] },
    expect: { lines: [{ taxable: 300, rate: 28, igst: 84, cess: 36, cessRate: 12 }], roundOff: 0, total: 420, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'B2C-09', title: 'B2CL with cess',
    // Cola 3,000 × 30 = 90,000 to Karnataka. IGST 28% = 25,200; cess 12% = 10,800. Total 1,26,000 > 1 lakh → B2CL.
    doc: { kind: 'sales', date: '2025-07-15', number: 'G309', party: 'urKA', rows: [{ item: 'cola', qty: '3000', rate: 30 }] },
    expect: { lines: [{ taxable: 90000, rate: 28, igst: 25200, cess: 10800, cessRate: 12 }], roundOff: 0, total: 126000, gstr1: 'b2cl', einvoice: false }
  },
  {
    id: 'NIL-01', title: 'Only nil-rated goods to a registered buyer',
    // Milk 20 L × 55 = 1,100 at 0%. Total 1,100. GSTR-1 Table 8 INTRAB2B 1,100; 3B 3.1(c) 1,100.
    // A bill of supply of nil-rated goods needs no e-invoice (no taxable supply).
    doc: { kind: 'sales', date: '2025-07-16', number: 'G310', party: 'regMH', rows: [{ item: 'milk', qty: '20', rate: 55 }] },
    expect: { lines: [{ taxable: 1100, rate: 0 }], roundOff: 0, total: 1100, gstr1: 'none', einvoice: false }
  },
  {
    id: 'NIL-02', title: 'Nil-rated goods to an unregistered buyer in another state',
    // Milk 20 L × 55 = 1,100 at 0% → Table 8 INTRB2C 1,100.
    doc: { kind: 'sales', date: '2025-07-17', number: 'G311', party: 'urKA', rows: [{ item: 'milk', qty: '20', rate: 55 }] },
    expect: { lines: [{ taxable: 1100, rate: 0 }], roundOff: 0, total: 1100, gstr1: 'none', einvoice: false }
  },

  // ───────────────────────── SEZ and exports ─────────────────────────
  {
    id: 'SEZ-01', title: 'SEZ with payment, unit in our own state',
    // 10 × 1,000 = 10,000. A supply to an SEZ is inter-state (s.7(5)(b) IGST Act) even inside
    // Maharashtra → IGST 18% = 1,800, never CGST / SGST. Total 11,800. GSTR-1 6B: b2b inv_typ SEWP,
    // POS 27. 3B 3.1(b) 10,000 / 1,800. e-invoice SupTyp SEZWP.
    doc: { kind: 'sales', date: '2025-08-01', number: 'G401', party: 'sezMH', rows: [{ item: 'widget', qty: '10', rate: 1000 }] },
    expect: { lines: [{ taxable: 10000, rate: 18, igst: 1800 }], roundOff: 0, total: 11800, gstr1: 'b2b', einvoice: true },
    knownBug: { in: ['invoice'], reason: 'The invoice editor charges CGST + SGST to an SEZ unit in our own state (returns and e-invoice report IGST) — supplies to an SEZ are inter-state (s.7(5)(b) IGST Act)' }
  },
  {
    id: 'SEZ-02', title: 'SEZ with payment, unit in another state',
    // 10 × 1,000 = 10,000; IGST 1,800; total 11,800. b2b SEWP, POS 29.
    doc: { kind: 'sales', date: '2025-08-04', number: 'G402', party: 'sezKA', rows: [{ item: 'widget', qty: '10', rate: 1000 }] },
    expect: { lines: [{ taxable: 10000, rate: 18, igst: 1800 }], roundOff: 0, total: 11800, gstr1: 'b2b', einvoice: true }
  },
  {
    id: 'SEZ-03', title: 'SEZ without payment (LUT)',
    // 10 × 1,000 = 10,000 under LUT: no IGST. Total 10,000. b2b SEWOP rt 18 iamt 0; 3B 3.1(b) 10,000 / 0;
    // e-invoice SEZWOP, GstRt 18, IgstAmt 0.
    doc: { kind: 'sales', date: '2025-08-05', number: 'G403', party: 'sezDL', rows: [{ item: 'widget', qty: '10', rate: 1000 }] },
    expect: { lines: [{ taxable: 10000, rate: 18 }], roundOff: 0, total: 10000, gstr1: 'b2b', einvoice: true },
    knownBug: { in: ['invoice', 'gstr1', 'einvoice'], reason: 'The invoice editor charges IGST on a supply under LUT (without payment): the bill total includes 18% the returns / e-invoice do not report' }
  },
  {
    id: 'EXP-01', title: 'Export with payment of IGST',
    // 20 × 750 = 15,000; IGST 18% = 2,700; total 17,700. GSTR-1 6A WPAY; 3B 3.1(b) 15,000 / 2,700;
    // e-invoice EXPWP, buyer URP / 96 / PIN 999999.
    doc: { kind: 'sales', date: '2025-08-06', number: 'G404', party: 'expWP', rows: [{ item: 'widget', qty: '20', rate: 750 }], shippingBill: { num: '1234567', date: '2025-08-07' } },
    expect: { lines: [{ taxable: 15000, rate: 18, igst: 2700 }], roundOff: 0, total: 17700, gstr1: 'exp', einvoice: true }
  },
  {
    id: 'EXP-02', title: 'Export without payment (LUT)',
    // 20 × 750 = 15,000, no IGST under LUT; total 15,000. 6A WOPAY rt 18 iamt 0; 3B 3.1(b) 15,000 / 0.
    doc: { kind: 'sales', date: '2025-08-07', number: 'G405', party: 'expWOP', rows: [{ item: 'widget', qty: '20', rate: 750 }] },
    expect: { lines: [{ taxable: 15000, rate: 18 }], roundOff: 0, total: 15000, gstr1: 'exp', einvoice: true },
    knownBug: { in: ['invoice', 'gstr1', 'einvoice'], reason: 'The invoice editor charges IGST on a supply under LUT (without payment): the bill total includes 18% the returns / e-invoice do not report' }
  },
  {
    id: 'EXP-03', title: 'Export with payment, cess paid too',
    // Cola 100 × 30 = 3,000. IGST 28% = 840; cess 12% = 360. Total 4,200. 6A WPAY iamt 840 csamt 360.
    doc: { kind: 'sales', date: '2025-08-08', number: 'G406', party: 'expWP', rows: [{ item: 'cola', qty: '100', rate: 30 }] },
    expect: { lines: [{ taxable: 3000, rate: 28, igst: 840, cess: 360, cessRate: 12 }], roundOff: 0, total: 4200, gstr1: 'exp', einvoice: true }
  },

  // ───────────────────────── credit / debit notes ─────────────────────────
  {
    id: 'CN-01', title: 'Credit note for returned goods, registered buyer (CDNR)',
    before: [{ kind: 'sales', date: '2025-04-10', number: 'G501', party: 'regMH', rows: [{ item: 'widget', qty: '10', rate: 1000 }] }],
    // 2 widgets back at the bill's 1,000: 2,000 → 180 + 180 → 2,360. 9B CDNR ntty C; 3B 3.1(a) −2,000 / −180 / −180.
    // e-invoice CRN, preceding document G501 of 10/04/2025.
    doc: { kind: 'credit_note', date: '2025-05-06', number: 'CN501', party: 'regMH', reference: 'G501', rows: [{ item: 'widget', qty: '2', rate: 1000 }] },
    expect: { lines: [{ taxable: 2000, rate: 18, cgst: 180, sgst: 180 }], roundOff: 0, total: 2360, gstr1: 'cdnr', einvoice: true }
  },
  {
    id: 'CN-02', title: 'Credit note, inter-state registered buyer',
    before: [{ kind: 'sales', date: '2025-04-11', number: 'G502', party: 'regKA', rows: [{ item: 'widget', qty: '5', rate: 2400 }] }],
    // 1 × 2,400 → IGST 432 → 2,832.
    doc: { kind: 'credit_note', date: '2025-05-07', number: 'CN502', party: 'regKA', reference: 'G502', rows: [{ item: 'widget', qty: '1', rate: 2400 }] },
    expect: { lines: [{ taxable: 2400, rate: 18, igst: 432 }], roundOff: 0, total: 2832, gstr1: 'cdnr', einvoice: true }
  },
  {
    id: 'CN-03', title: 'Credit note for a discount after the sale (ledger lines)',
    before: [{
      kind: 'sales', date: '2025-04-14', number: 'G503', party: 'regMH',
      lines: [{ ledger: 'party', side: 'dr', amount: 11800 }, { ledger: 'consulting', side: 'cr', amount: 10000 }, { ledger: 'cgstOut', side: 'cr', amount: 900 }, { ledger: 'sgstOut', side: 'cr', amount: 900 }]
    }],
    // Consulting Fees 1,000 back; CGST 90; SGST 90; party 1,180.
    doc: {
      kind: 'credit_note', date: '2025-05-08', number: 'CN503', party: 'regMH', reference: 'G503',
      lines: [{ ledger: 'consulting', side: 'dr', amount: 1000 }, { ledger: 'cgstOut', side: 'dr', amount: 90 }, { ledger: 'sgstOut', side: 'dr', amount: 90 }, { ledger: 'party', side: 'cr', amount: 1180 }]
    },
    expect: { lines: [{ taxable: 1000, rate: 18, cgst: 90, sgst: 90 }], roundOff: 0, total: 1180, gstr1: 'cdnr', einvoice: true }
  },
  {
    id: 'DN-01', title: 'Debit note to a customer for a price increase',
    before: [{ kind: 'sales', date: '2025-04-15', number: 'G504', party: 'regMH', rows: [{ item: 'widget', qty: '10', rate: 1000 }] }],
    // Service Income (no rate) 1,000 more; CGST 90; SGST 90; party 1,180. Implied 18%. 9B CDNR ntty D; 3B +1,000 / +90 / +90.
    doc: {
      kind: 'debit_note', date: '2025-05-09', number: 'DN504', party: 'regMH', reference: 'G504',
      lines: [{ ledger: 'party', side: 'dr', amount: 1180 }, { ledger: 'serviceIncome', side: 'cr', amount: 1000 }, { ledger: 'cgstOut', side: 'cr', amount: 90 }, { ledger: 'sgstOut', side: 'cr', amount: 90 }]
    },
    expect: { lines: [{ taxable: 1000, rate: 18, cgst: 90, sgst: 90 }], roundOff: 0, total: 1180, gstr1: 'cdnr', einvoice: true }
  },
  {
    id: 'CN-04', title: 'CDNUR follows its B2CL original even when the note is small',
    before: [{ kind: 'sales', date: '2025-04-16', number: 'G505', party: 'urKA', rows: [{ item: 'widget', qty: '10', rate: 15000 }] }],
    // Original: 10 × 15,000 = 1,50,000 + IGST 27,000 = 1,77,000 > 1 lakh, inter-state, unregistered → B2CL.
    // Note: 1 × 15,000 → IGST 2,700 → 17,700. Its original was B2CL → 9B CDNUR typ B2CL, POS 29.
    // 3B 3.1(a) −15,000 / −2,700; 3.2 POS 29 −15,000 / −2,700.
    doc: { kind: 'credit_note', date: '2025-05-12', number: 'CN505', party: 'urKA', reference: 'G505', rows: [{ item: 'widget', qty: '1', rate: 15000 }] },
    expect: { lines: [{ taxable: 15000, rate: 18, igst: 2700 }], roundOff: 0, total: 17700, gstr1: 'cdnur', cdnurTyp: 'B2CL', einvoice: false }
  },
  {
    id: 'CN-05', title: 'Note on a small B2C bill nets into B2CS',
    before: [{ kind: 'sales', date: '2025-04-17', number: 'G506', party: 'urKA', rows: [{ item: 'widget', qty: '2', rate: 15000 }] }],
    // Original 30,000 + 5,400 = 35,400 → B2CS. Note 1 × 15,000 → IGST 2,700 → 17,700.
    // B2CS INTER POS 29 rt 18: −15,000 / −2,700.
    doc: { kind: 'credit_note', date: '2025-05-13', number: 'CN506', party: 'urKA', reference: 'G506', rows: [{ item: 'widget', qty: '1', rate: 15000 }] },
    expect: { lines: [{ taxable: 15000, rate: 18, igst: 2700 }], roundOff: 0, total: 17700, gstr1: 'b2cs', einvoice: false }
  },
  {
    id: 'CN-06', title: 'Credit note on an export (CDNUR EXPWP)',
    before: [{ kind: 'sales', date: '2025-04-18', number: 'G507', party: 'expWP', rows: [{ item: 'widget', qty: '20', rate: 750 }] }],
    // 4 × 750 = 3,000 → IGST 540 → 3,540. 9B CDNUR typ EXPWP, POS 96; 3B 3.1(b) −3,000 / −540; e-invoice CRN EXPWP.
    doc: { kind: 'credit_note', date: '2025-05-14', number: 'CN507', party: 'expWP', reference: 'G507', rows: [{ item: 'widget', qty: '4', rate: 750 }] },
    expect: { lines: [{ taxable: 3000, rate: 18, igst: 540 }], roundOff: 0, total: 3540, gstr1: 'cdnur', cdnurTyp: 'EXPWP', einvoice: true }
  },
  {
    id: 'CN-07', title: 'Credit note on an SEZ supply with payment',
    before: [{ kind: 'sales', date: '2025-04-21', number: 'G508', party: 'sezKA', rows: [{ item: 'widget', qty: '10', rate: 1000 }] }],
    // 2 × 1,000 = 2,000 → IGST 360 → 2,360. 9B CDNR inv_typ SEWP; 3B 3.1(b) −2,000 / −360; e-invoice CRN SEZWP.
    doc: { kind: 'credit_note', date: '2025-05-15', number: 'CN508', party: 'sezKA', reference: 'G508', rows: [{ item: 'widget', qty: '2', rate: 1000 }] },
    expect: { lines: [{ taxable: 2000, rate: 18, igst: 360 }], roundOff: 0, total: 2360, gstr1: 'cdnr', einvoice: true }
  },
  {
    id: 'CN-08', title: 'Note on an intra-state B2C bill nets into B2CS INTRA',
    before: [{ kind: 'sales', date: '2025-04-22', number: 'G509', party: 'urMH', rows: [{ item: 'widget', qty: '2', rate: 1000 }] }],
    // 1 × 1,000 → 90 + 90 → 1,180. B2CS INTRA POS 27 rt 18: −1,000 / −90 / −90.
    doc: { kind: 'credit_note', date: '2025-05-16', number: 'CN509', party: 'urMH', reference: 'G509', rows: [{ item: 'widget', qty: '1', rate: 1000 }] },
    expect: { lines: [{ taxable: 1000, rate: 18, cgst: 90, sgst: 90 }], roundOff: 0, total: 1180, gstr1: 'b2cs', einvoice: false }
  },

  // ───────────────────────── purchases, ITC, reverse charge ─────────────────────────
  {
    id: 'PUR-01', title: 'Intra-state purchase, ITC',
    // 10 × 600 = 6,000 → CGST 540, SGST 540 → 7,080. 3B 4(A)(5) 540 / 540; net ITC 540 / 540.
    doc: { kind: 'purchase', date: '2025-08-11', number: 'P601', party: 'vendorMH', rows: [{ item: 'widget', qty: '10', rate: 600 }] },
    expect: { lines: [{ taxable: 6000, rate: 18, cgst: 540, sgst: 540 }], roundOff: 0, total: 7080, gstr1: 'none', einvoice: false }
  },
  {
    id: 'PUR-02', title: 'Inter-state purchase, ITC',
    // Rice 100 kg × 50 = 5,000 from Gujarat → IGST 5% = 250 → 5,250. 3B 4(A)(5) IGST 250.
    doc: { kind: 'purchase', date: '2025-08-12', number: 'P602', party: 'vendorGJ', rows: [{ item: 'rice', qty: '100', rate: 50 }] },
    expect: { lines: [{ taxable: 5000, rate: 5, igst: 250 }], roundOff: 0, total: 5250, gstr1: 'none', einvoice: false }
  },
  {
    id: 'PUR-03', title: 'Purchase with cess',
    // Cola 200 × 20 = 4,000 → CGST 14% 560, SGST 560, cess 12% 480 → 5,600. 3B ITC 560 / 560 / cess 480.
    doc: { kind: 'purchase', date: '2025-08-13', number: 'P603', party: 'vendorMH', rows: [{ item: 'cola', qty: '200', rate: 20 }] },
    expect: { lines: [{ taxable: 4000, rate: 28, cgst: 560, sgst: 560, cess: 480, cessRate: 12 }], roundOff: 0, total: 5600, gstr1: 'none', einvoice: false }
  },
  {
    id: 'PUR-04', title: 'Purchase, tiny round off',
    // 3 × 333.33 = 999.99 → 9% = 89.9991 → 90.00 each → 1,179.99 → 1,180.00, +0.01. ITC 90 / 90.
    doc: { kind: 'purchase', date: '2025-08-14', number: 'P604', party: 'vendorMH', rows: [{ item: 'widget', qty: '3', rate: 333.33 }] },
    expect: { lines: [{ taxable: 999.99, rate: 18, cgst: 90, sgst: 90 }], roundOff: 0.01, total: 1180, gstr1: 'none', einvoice: false }
  },
  {
    id: 'PUR-05', title: 'Purchase return (debit note to the supplier)',
    before: [{ kind: 'purchase', date: '2025-07-21', number: 'P605', party: 'vendorMH', rows: [{ item: 'widget', qty: '10', rate: 600 }] }],
    // 2 × 600 = 1,200 → 108 + 108 → 1,416 back. ITC for the month: −108 / −108. Not in GSTR-1.
    doc: { kind: 'debit_note', date: '2025-08-15', number: 'D605', party: 'vendorMH', reference: 'P605', rows: [{ item: 'widget', qty: '2', rate: 600 }] },
    expect: { lines: [{ taxable: 1200, rate: 18, cgst: 108, sgst: 108 }], roundOff: 0, total: 1416, gstr1: 'none', einvoice: false }
  },
  {
    id: 'RCM-01', title: 'Reverse charge: goods transport agency (5%)',
    // Freight Inward (5%, SAC 996511) 10,000 from an unregistered GTA; no tax on the bill.
    // We pay CGST 2.5% = 250, SGST 250 under reverse charge: 3B 3.1(d) 10,000 / 250 / 250 and the
    // same credit in 4(A)(3); net ITC 250 / 250.
    doc: {
      kind: 'purchase', date: '2025-08-18', number: 'P606', party: 'gta',
      lines: [{ ledger: 'freight', side: 'dr', amount: 10000 }, { ledger: 'party', side: 'cr', amount: 10000 }]
    },
    expect: { lines: [{ taxable: 10000, rate: 5, cgst: 250, sgst: 250 }], roundOff: 0, total: 10000, gstr1: 'none', einvoice: false }
  },
  {
    id: 'RCM-02', title: 'Reverse charge: advocate (18%)',
    // Legal Fees (18%) 25,000 → RCM CGST 2,250 + SGST 2,250. 3B 3.1(d) 25,000 / 2,250 / 2,250; 4(A)(3) same.
    doc: {
      kind: 'purchase', date: '2025-08-19', number: 'P607', party: 'lawyer',
      lines: [{ ledger: 'legal', side: 'dr', amount: 25000 }, { ledger: 'party', side: 'cr', amount: 25000 }]
    },
    expect: { lines: [{ taxable: 25000, rate: 18, cgst: 2250, sgst: 2250 }], roundOff: 0, total: 25000, gstr1: 'none', einvoice: false }
  },
  {
    id: 'RCM-03', title: 'Reverse charge, GTA in another state',
    // Freight 8,000 from a Gujarat GTA → RCM IGST 5% = 400. 3B 3.1(d) 8,000 / IGST 400; 4(A)(3) IGST 400.
    doc: {
      kind: 'purchase', date: '2025-08-20', number: 'P608', party: 'gtaGJ',
      lines: [{ ledger: 'freight', side: 'dr', amount: 8000 }, { ledger: 'party', side: 'cr', amount: 8000 }]
    },
    expect: { lines: [{ taxable: 8000, rate: 5, igst: 400 }], roundOff: 0, total: 8000, gstr1: 'none', einvoice: false }
  },
  {
    id: 'IMP-01', title: 'Import of goods (IGST paid at customs)',
    // Purchases 10,000 + IGST 18% 1,800 from a foreign supplier (state 96) → 3B 4(A)(1) IMPG IGST 1,800.
    doc: {
      kind: 'purchase', date: '2025-08-21', number: 'P609', party: 'importer',
      lines: [{ ledger: 'purchases', side: 'dr', amount: 10000 }, { ledger: 'igstIn', side: 'dr', amount: 1800 }, { ledger: 'party', side: 'cr', amount: 11800 }]
    },
    expect: { lines: [{ taxable: 10000, rate: 18, igst: 1800 }], roundOff: 0, total: 11800, gstr1: 'none', einvoice: false, gstr3b: { itc_avl: { IMPG: { iamt: 1800 } }, itc_net: { iamt: 1800 } } }
  },
  {
    id: 'BLK-01', title: 'Blocked credit (s.17(5) food) — Circular 170 presentation',
    // Purchases 3,000 + IGST 18% 540 from a Tamil Nadu caterer marked blocked → 3,540.
    // Circular 170/02/2022: availed in 4(A)(5) 540, reversed in 4(B)(1) 540, net ITC 0.
    doc: {
      kind: 'purchase', date: '2025-08-22', number: 'P610', party: 'caterer',
      lines: [{ ledger: 'purchases', side: 'dr', amount: 3000 }, { ledger: 'igstIn', side: 'dr', amount: 540 }, { ledger: 'party', side: 'cr', amount: 3540 }]
    },
    expect: {
      lines: [{ taxable: 3000, rate: 18, igst: 540 }], roundOff: 0, total: 3540, gstr1: 'none', einvoice: false,
      gstr3b: { itc_avl: { OTH: { iamt: 540 } }, itc_rev_rul: { iamt: 540 }, itc_net: {} }
    }
  },

  // ───────────────────────── composition / unregistered businesses ─────────────────────────
  {
    id: 'CMP-01', title: 'Composition dealer sells to a consumer: no GST',
    company: 'composition',
    // A composition dealer charges no tax (bill of supply): 2 × 1,000 = 2,000; total 2,000.
    // Files no GSTR-1; no tax on any return; no e-invoice.
    doc: { kind: 'sales', date: '2025-09-01', number: 'C701', party: 'urMH', rows: [{ item: 'widget', qty: '2', rate: 1000 }] },
    expect: { lines: [{ taxable: 2000, rate: 0 }], roundOff: 0, total: 2000, gstr1: 'not-filed', einvoice: false }
  },
  {
    id: 'CMP-02', title: 'Composition dealer sells to a registered buyer: still no GST',
    company: 'composition',
    // 3 × 1,000 = 3,000; total 3,000.
    doc: { kind: 'sales', date: '2025-09-02', number: 'C702', party: 'regMH', rows: [{ item: 'widget', qty: '3', rate: 1000 }] },
    expect: { lines: [{ taxable: 3000, rate: 0 }], roundOff: 0, total: 3000, gstr1: 'not-filed', einvoice: false }
  },
  {
    id: 'UNR-01', title: 'Unregistered business: no GST',
    company: 'unregistered',
    // 3 × 1,000 = 3,000 to a registered buyer in another state; total 3,000.
    doc: { kind: 'sales', date: '2025-09-03', number: 'U703', party: 'regKA', rows: [{ item: 'widget', qty: '3', rate: 1000 }] },
    expect: { lines: [{ taxable: 3000, rate: 0 }], roundOff: 0, total: 3000, gstr1: 'not-filed', einvoice: false }
  },

  // ───────────────────────── advances (services) ─────────────────────────
  {
    id: 'ADV-01', title: 'Advance received for a service (Table 11A)',
    // ₹11,800 received in advance from a customer for consulting (18%), no invoice yet.
    // Rule 35: value = 11,800 × 100 ÷ 118 = 10,000; tax = 1,800 → CGST 900, SGST 900.
    // GSTR-1 11A: POS 27 INTRA rt 18 ad_amt 10,000 camt 900 samt 900.
    // 3B: tax on an advance for services is due when received (s.13(2)); GSTN's auto-drafted 3B
    // puts 11A into 3.1(a) → 10,000 / 900 / 900.
    doc: { kind: 'receipt', date: '2025-09-04', number: 'R801', party: 'advMH', billRefs: [{ kind: 'new', name: 'ADV-801', amount: 11800 }], lines: [{ ledger: 'bank', side: 'dr', amount: 11800 }, { ledger: 'party', side: 'cr', amount: 11800 }] },
    expect: {
      lines: [], roundOff: 0, total: 11800, gstr1: 'none', einvoice: false,
      gstr1Tables: { at: [{ pos: '27', sply_ty: 'INTRA', itms: [{ rt: 18, ad_amt: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 }] }] },
      gstr3b: { osup_det: { txval: 10000, camt: 900, samt: 900 } }
    },
    knownBug: { in: ['gstr3b'], reason: 'GSTR-3B leaves the tax on advances (GSTR-1 11A / 11B) out of 3.1(a); GSTN auto-population adds them (UNVERIFIED: ask the CA)' }
  },
  {
    id: 'ADV-02', title: 'Invoice adjusting an earlier advance (Table 11B)',
    before: [{ kind: 'receipt', date: '2025-09-04', number: 'R802', party: 'advMH', billRefs: [{ kind: 'new', name: 'ADV-802', amount: 11800 }], lines: [{ ledger: 'bank', side: 'dr', amount: 11800 }, { ledger: 'party', side: 'cr', amount: 11800 }] }],
    // Consulting 10,000 + 900 + 900 = 11,800 invoiced in October, set against the advance.
    // GSTR-1: 4A 10,000 / 900 / 900 and 11B POS 27 rt 18 ad_amt 10,000 camt 900 samt 900.
    // 3B: invoice 10,000 / 900 / 900 less the advance already taxed in September → 0.
    doc: {
      kind: 'sales', date: '2025-10-06', number: 'G802', party: 'advMH', billRefs: [{ kind: 'against', name: 'ADV-802', amount: 11800 }],
      lines: [{ ledger: 'party', side: 'dr', amount: 11800 }, { ledger: 'consulting', side: 'cr', amount: 10000 }, { ledger: 'cgstOut', side: 'cr', amount: 900 }, { ledger: 'sgstOut', side: 'cr', amount: 900 }]
    },
    expect: {
      lines: [{ taxable: 10000, rate: 18, cgst: 900, sgst: 900 }], roundOff: 0, total: 11800, gstr1: 'b2b', einvoice: true,
      gstr1Tables: { txpd: [{ pos: '27', sply_ty: 'INTRA', itms: [{ rt: 18, ad_amt: 10000, iamt: 0, camt: 900, samt: 900, csamt: 0 }] }] },
      gstr3b: { osup_det: {} }
    },
    knownBug: { in: ['gstr3b'], reason: 'GSTR-3B leaves the tax on advances (GSTR-1 11A / 11B) out of 3.1(a); GSTN auto-population adds them (UNVERIFIED: ask the CA)' }
  }
]
