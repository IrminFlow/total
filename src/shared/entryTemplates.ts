import type { VoucherKind } from './domain'
import type { VoucherDraftMode } from './voucherDrafts'

export interface VoucherEntryTemplate {
  id: number
  name: string
  voucherTypeId: number
  voucherTypeName: string
  kind: VoucherKind
  mode: VoucherDraftMode
  payloadVersion: number
  payload: Record<string, unknown>
  createdBy: string
  createdAt: string
  updatedAt: string
}
