/**
 * TDS and TCS share one set of tables (migration 027, WP 3.3): sections / rate rows /
 * certificates / challans / entries / "not applicable" marks carry a `kind` ('tds' | 'tcs') —
 * directly (tds_sections, tds_certificates, tds_challans, tds_exemptions) or through their
 * section (rates, entries). What differs per kind on the ledger side is a column name; this is
 * the one place those names live, so the shared services in tds.ts / tdsWorkbench.ts take a
 * `kind` instead of being copied.
 */
import type { WithholdingKind } from '@shared/tdsTypes'

export type { WithholdingKind }

export interface KindSpec {
  kind: WithholdingKind
  /** "TDS" / "TCS". */
  name: string
  /** ledgers column tagging a ledger as a section's payable ledger (the mirror of tax_type). */
  payableCol: 'tds_payable_section_id' | 'tcs_payable_section_id'
  /** ledgers column flagging a party (deductee / collectee) for a section. */
  partyCol: 'tds_section_id' | 'tcs_section_id'
  /** ledgers column: default section of an expense (TDS) / sales (TCS) ledger. */
  defaultCol: 'tds_default_section_id' | 'tcs_default_section_id'
  /** Name a section's payable ledger is created with. */
  payableName: (code: string) => string
  /** Default no-PAN rate for a new rate row: 20% (s.206AA) / 5% (s.206CC; twice the rate when
   *  higher is applied by the engine). */
  defaultNoPanBp: number
}

export const KIND: Record<WithholdingKind, KindSpec> = {
  tds: {
    kind: 'tds', name: 'TDS', payableCol: 'tds_payable_section_id', partyCol: 'tds_section_id', defaultCol: 'tds_default_section_id',
    payableName: (code) => `TDS Payable ${code}`, defaultNoPanBp: 2000
  },
  tcs: {
    kind: 'tcs', name: 'TCS', payableCol: 'tcs_payable_section_id', partyCol: 'tcs_section_id', defaultCol: 'tcs_default_section_id',
    payableName: (code) => `TCS Payable ${code}`, defaultNoPanBp: 500
  }
}
