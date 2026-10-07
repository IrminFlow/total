// The TCS screen (WP 3.3): the TDS screen's shell and tabs with kind 'tcs' — TCS ledger summary
// card, Eligible (sales that should carry TCS, Move to TCS), Collected (edit / delete), Challans
// (deposit due dates per rule 37CA / Income-tax Rules 2026 rule 218(2)), Returns (Form 27EQ /
// Form 143 data + CSV, Form 27D / Form 133 data PDF) and Sections (s.206C / s.394 rates, buyers,
// s.206C(9) certificates).
import { WithholdingScreen } from './Tds'

export function TcsScreen(): React.JSX.Element {
  return <WithholdingScreen kind="tcs" />
}
