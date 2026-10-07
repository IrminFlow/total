/** Shapes returned by the WP 4.1 banking channels (src/main/ipcBanking.ts) — shared so the
 *  renderer's typed client and the main-process services agree. Pure types. */
import type { BankFormatId, ImportProfile, StatementLine } from './bankFormats/types'
import type { LearnedRule, LearnedStatus, MatchOptions, MatchProposal, Side } from './bankMatch'
import type { ChequeBookRange, ChequeStatus } from './chequeRegister'
import type { PaymentTemplate } from './bulkPayments'

export interface PreviewLine extends StatementLine {
  lineNo: number
  hash: string
  /** Already imported for this bank account (by import_hash). */
  duplicate: boolean
}

export interface StatementPreview {
  fileName: string
  format: BankFormatId
  profile: ImportProfile | null
  /** Where the profile came from: the one saved for this bank, the payload's, or detection. */
  profileSource: 'saved' | 'given' | 'detected' | null
  /** First rows of a tabular file for the mapping UI (null for MT940 / CAMT / pasted). */
  grid: string[][] | null
  lines: PreviewLine[]
  newCount: number
  duplicateCount: number
  warnings: string[]
  account: string | null
  openingBalance: number | null
  closingBalance: number | null
}

export interface CommitResult {
  importId: number | null
  inserted: number
  duplicates: number
}

export interface ImportSummary {
  id: number
  importedAt: string
  fileName: string
  format: string
  lineCount: number
  duplicateCount: number
  matched: number
  created: number
}

export interface WorkspaceEntry {
  voucherId: number
  lineId: number
  number: string
  voucherType: string
  date: string
  amount: number
  particulars: string
  particularsLedgerId: number | null
}

export interface LineSuggestion {
  source: 'learned' | 'rule'
  /** bank_learned_rules.id or bank_rules.id */
  ruleId: number
  ledgerId: number
  ledgerName: string
  partyLedgerId: number | null
  voucherKind: string
  narration: string
  confidence: number
  /** Confirmed matches / vouchers it was learned from (+ uses). */
  evidence: number
  status: LearnedStatus | 'manual'
}

export interface WorkspaceLine {
  id: number
  importId: number
  date: string
  valueDate: string | null
  description: string
  reference: string
  side: Side
  amount: number
  balance: number | null
  status: 'open' | 'matched' | 'ignored'
  /** Confirmed match: vouchers it is matched to (created = made from this line). */
  matched: (WorkspaceEntry & { created: boolean })[]
  /** Proposed match (open lines). Group proposals carry the other statement lines too. */
  proposal: (Omit<MatchProposal, 'entryIds'> & { entries: WorkspaceEntry[] }) | null
  suggestion: LineSuggestion | null
}

export interface Workspace {
  lines: WorkspaceLine[]
  imports: ImportSummary[]
  openEntries: WorkspaceEntry[]
}

export interface LearnedRuleRecord extends LearnedRule {
  ledgerName: string
  partyName: string | null
  confidence: number
  createdAt: string
  updatedAt: string
}

export interface CreateResult {
  created: { lineId: number; voucherId: number; number: string }[]
  failed: { lineId: number; error: string }[]
}

export interface LearnedRuleEdit {
  status?: LearnedStatus
  ledgerId?: number
  partyLedgerId?: number | null
  voucherKind?: 'payment' | 'receipt' | 'contra' | 'journal'
  narrationTemplate?: string | null
  tokens?: string[]
}

export interface CreateFromLineInput {
  lineId: number
  ledgerId: number
  partyLedgerId?: number | null
  voucherKind?: 'payment' | 'receipt' | 'contra'
  narration?: string | null
  /** The suggestion that was used (for the hit / applied counters). */
  source?: { kind: 'learned' | 'rule'; ruleId: number } | null
}

export interface MatchGroupInput {
  lineIds: number[]
  voucherIds: number[]
}

export interface WorkspaceQuery {
  importId?: number
  /** Include matched and ignored lines (default: open lines only). */
  includeDone?: boolean
  options?: Partial<MatchOptions>
  /** Minimum learned-rule score to suggest (0..1). */
  minSuggestScore?: number
}

export interface StatementSource {
  fileName: string
  /** File content, base64 (binary-safe: XLSX). */
  base64?: string
  /** Pasted or inline text. */
  text?: string
  format?: BankFormatId
  profile?: ImportProfile | null
}

export interface ChequeBook extends ChequeBookRange {
  bankLedgerId: number
  bankLedgerName: string
  name: string
  receivedOn: string | null
  used: number
  leaves: number
}

export interface ChequeBookInput {
  bankLedgerId: number
  name: string
  fromNo: number
  toNo: number
  width: number
  receivedOn: string | null
  active: boolean
}

export interface ChequeRegisterRow {
  /** Stable row key: 'c<chequeId>' or 'l<bookId>-<leaf>' for an untouched leaf. */
  key: string
  chequeId: number | null
  bookId: number | null
  bookName: string | null
  number: string
  leaf: number | null
  status: ChequeStatus
  voucherId: number | null
  voucherNumber: string | null
  chequeDate: string | null
  payee: string | null
  amount: number | null
  bankDate: string | null
  note: string | null
  printedCount: number
}

export interface ChequeStatusInput {
  bankLedgerId: number
  /** The register entry, or a leaf number not yet in the register (cancel / stop a blank leaf). */
  chequeId?: number | null
  number?: string | null
  status: 'cancelled' | 'stopped' | 'issued'
  note?: string | null
}

export type PdcDirection = 'received' | 'issued'

export type PdcStatus = 'pending' | 'due' | 'matured' | 'bounced'

export interface PdcRegisterRow {
  voucherId: number
  number: string
  voucherTypeName: string
  /** Maturity date (the voucher date). */
  date: string
  direction: PdcDirection
  partyLedgerId: number | null
  partyName: string | null
  bankLedgerId: number | null
  bankLedgerName: string | null
  instrumentNo: string | null
  instrumentDate: string | null
  amount: number
  status: PdcStatus
  maturedAt: string | null
  bouncedOn: string | null
  bounceVoucherId: number | null
  bounceCharges: number | null
  bounceReason: string | null
}

export interface PdcDue {
  /** Inclusive window end (today + days). */
  until: string
  received: { count: number; amount: number }
  issued: { count: number; amount: number }
  /** Pending PDCs whose date has passed but which have not matured (books locked). */
  overdue: number
  items: Pick<PdcRegisterRow, 'voucherId' | 'number' | 'date' | 'direction' | 'partyName' | 'amount' | 'status'>[]
}

export interface BounceInput {
  voucherId: number
  /** Date the bank returned the cheque. */
  date: string
  /** Bank charges, paise (0 = none). */
  charges: number
  chargesLedgerId: number | null
  /** Received cheques: book the charges to the party (recover them) instead of an expense. */
  recoverChargesFromParty: boolean
  reason: string
}

export interface BounceResult {
  reversalVoucherId: number
  chargesVoucherId: number | null
}

export interface BankDetails {
  accountNo: string | null
  ifsc: string | null
  accountName: string | null
  email: string | null
}

export interface BeneficiaryRow extends BankDetails {
  ledgerId: number
  name: string
  groupName: string
  isBank: boolean
  problems: string[]
}

export interface PaymentTemplateRecord {
  /** User template id; null for a built-in starter. */
  id: number | null
  key: string
  builtin: boolean
  source: string | null
  spec: PaymentTemplate
}

export interface PaymentCandidate {
  voucherId: number
  number: string
  date: string
  amount: number
  payeeLedgerId: number | null
  payeeName: string | null
  narration: string | null
  accountNo: string | null
  ifsc: string | null
  accountName: string | null
  email: string | null
  problems: string[]
  postDated: boolean
  /** Earlier payment files that carried this voucher. */
  exportedIn: { batchId: number; fileName: string; createdAt: string }[]
  /** A cheque is in the register for this voucher (paying it twice is the risk). */
  chequeNo: string | null
}

export interface ExportBatchInput {
  bankLedgerId: number
  voucherIds: number[]
  templateKey: string
  date: string
  corporateId?: string | null
  remarks?: string | null
}

export interface ExportBatchResult {
  batchId: number
  fileName: string
  text: string
  count: number
  total: number
}

export interface PaymentBatchRow {
  id: number
  createdAt: string
  bankLedgerId: number
  templateName: string
  fileName: string
  voucherCount: number
  total: number
}
