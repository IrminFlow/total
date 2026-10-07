// Typed client for banking depth (WP 4.1) — the channels in src/main/ipcBanking.ts.
import { call } from './client'
import type { ImportProfile } from '@shared/bankFormats/types'
import type { PaymentTemplate } from '@shared/bulkPayments'
import type { MatchOptions } from '@shared/bankMatch'
import type {
  BankDetails, BeneficiaryRow, BounceInput, BounceResult, ChequeBook, ChequeBookInput, ChequeRegisterRow, ChequeStatusInput, CommitResult,
  CreateFromLineInput, CreateResult, ExportBatchInput, ExportBatchResult, ImportSummary, LearnedRuleEdit, LearnedRuleRecord, MatchGroupInput,
  PaymentBatchRow, PaymentCandidate, PaymentTemplateRecord, PdcRegisterRow, StatementPreview, StatementSource, Workspace
} from '@shared/bankTypes'

export type * from '@shared/bankTypes'

export const bankingApi = {
  import: {
    pickFile: () => call<{ fileName: string; base64: string } | null>('bankImport:pickFile'),
    preview: (bankLedgerId: number, source: StatementSource) => call<StatementPreview>('bankImport:preview', { bankLedgerId, source }),
    commit: (bankLedgerId: number, source: StatementSource, saveProfile = true) =>
      call<CommitResult>('bankImport:commit', { bankLedgerId, source, saveProfile }),
    profile: (bankLedgerId: number, format: 'csv' | 'xlsx') => call<ImportProfile | null>('bankImport:profile', { bankLedgerId, format }),
    saveProfile: (bankLedgerId: number, format: 'csv' | 'xlsx', profile: ImportProfile) =>
      call<ImportProfile>('bankImport:saveProfile', { bankLedgerId, format, profile }),
    workspace: (bankLedgerId: number, q: { importId?: number; includeDone?: boolean; options?: Partial<MatchOptions>; minSuggestScore?: number } = {}) =>
      call<Workspace>('bankImport:workspace', { bankLedgerId, ...q }),
    imports: (bankLedgerId: number) => call<ImportSummary[]>('bankImport:imports', { bankLedgerId }),
    confirm: (bankLedgerId: number, groups: MatchGroupInput[], tolerance = 0) =>
      call<{ confirmed: number }>('bankImport:confirm', { bankLedgerId, groups, tolerance }),
    unmatch: (bankLedgerId: number, lineId: number) => call<null>('bankImport:unmatch', { bankLedgerId, lineId }),
    ignore: (bankLedgerId: number, lineId: number, ignored: boolean) => call<null>('bankImport:ignore', { bankLedgerId, lineId, ignored }),
    createVouchers: (bankLedgerId: number, items: CreateFromLineInput[]) => call<CreateResult>('bankImport:createVouchers', { bankLedgerId, items }),
    undo: (bankLedgerId: number, importId: number) =>
      call<{ binned: number; unmatched: number; removedLines: number }>('bankImport:undo', { bankLedgerId, importId })
  },
  learned: {
    list: () => call<LearnedRuleRecord[]>('bankLearned:list'),
    update: (id: number, data: LearnedRuleEdit) => call<LearnedRuleRecord>('bankLearned:update', { id, data }),
    remove: (id: number) => call<null>('bankLearned:delete', { id })
  },
  cheques: {
    books: (bankLedgerId?: number) => call<ChequeBook[]>('cheques:books', { bankLedgerId }),
    saveBook: (data: ChequeBookInput, id?: number) => call<ChequeBook>('cheques:saveBook', { id, data }),
    deleteBook: (id: number) => call<null>('cheques:deleteBook', { id }),
    register: (bankLedgerId: number, includeAvailable = true) => call<ChequeRegisterRow[]>('cheques:register', { bankLedgerId, includeAvailable }),
    next: (bankLedgerId: number) => call<{ bookId: number; leaf: number; label: string } | null>('cheques:next', { bankLedgerId }),
    setStatus: (input: ChequeStatusInput) => call<ChequeRegisterRow>('cheques:setStatus', input),
    print: (voucherId: number, bankLedgerId: number, number?: string | null) =>
      call<{ path: string; cheque: ChequeRegisterRow }>('cheques:print', { voucherId, bankLedgerId, number })
  },
  pdc: {
    register: (today?: string) => call<PdcRegisterRow[]>('pdc:register', { today }),
    bounce: (input: BounceInput) => call<BounceResult>('pdc:bounce', input)
  },
  bulk: {
    beneficiaries: () => call<BeneficiaryRow[]>('bulkPay:beneficiaries'),
    setBankDetails: (ledgerId: number, data: BankDetails) => call<BeneficiaryRow>('bulkPay:setBankDetails', { ledgerId, data }),
    templates: () => call<PaymentTemplateRecord[]>('bulkPay:templates'),
    saveTemplate: (data: PaymentTemplate, id?: number) => call<PaymentTemplateRecord>('bulkPay:saveTemplate', { id, data }),
    deleteTemplate: (id: number) => call<null>('bulkPay:deleteTemplate', { id }),
    candidates: (bankLedgerId: number, from: string, to: string) => call<PaymentCandidate[]>('bulkPay:candidates', { bankLedgerId, from, to }),
    batches: (bankLedgerId: number) => call<PaymentBatchRow[]>('bulkPay:batches', { bankLedgerId }),
    export: (input: ExportBatchInput) => call<ExportBatchResult & { path: string }>('bulkPay:export', input)
  }
}
