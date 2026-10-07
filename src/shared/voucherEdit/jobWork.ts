// Job-work send / return mode (WP 2.4): the godown-transfer form with the job worker's godown
// fixed on one side of every row — "send" moves stock from our godowns INTO it, "return" brings
// unprocessed material back OUT of it — plus the ITC-04 header facts saved in job_work_challans.
// The posting is exactly a transfer (./stockJournal buildTransferPayload), so the engine's
// 'transfer' rule values it at cost; this file only adds the challan side and the round trip.

import type { Voucher } from '../domain'
import type { JobWorkChallan } from '../jobWork'
import { buildTransferPayload, transferRepresentation, type TransferFormState } from './stockJournal'
import type { Representation, VoucherPayload } from './payload'

export interface JobWorkChallanState {
  kind: 'send' | 'return'
  /** The job worker's godown. */
  godownId: number | null
  natureOfProcessing: string
  goodsType: 'inputs' | 'capital_goods'
  /** Return only: the job worker's challan for the material coming back. */
  challanNo: string
  challanDate: string | null
  originalChallanVoucherId: number | null
}

export interface JobWorkSendFormState {
  transfer: TransferFormState
  challan: JobWorkChallanState
}

export const emptyJobWorkChallan = (kind: 'send' | 'return' = 'send'): JobWorkChallanState => ({
  kind, godownId: null, natureOfProcessing: '', goodsType: 'inputs', challanNo: '', challanDate: null, originalChallanVoucherId: null
})

/** The transfer state with the job worker's godown put on the fixed side of every row. */
export function withJobWorker(state: TransferFormState, challan: JobWorkChallanState): TransferFormState {
  return {
    ...state,
    rows: state.rows.map((r) => (challan.kind === 'send' ? { ...r, toGodownId: challan.godownId } : { ...r, fromGodownId: challan.godownId }))
  }
}

/** What jobWork:saveChallan receives. */
export interface JobWorkChallanPayload {
  voucher: VoucherPayload
  challan: {
    kind: 'send' | 'return'
    godownId: number
    natureOfProcessing: string | null
    goodsType: 'inputs' | 'capital_goods'
    challanNo: string | null
    challanDate: string | null
    originalChallanVoucherId: number | null
  }
}

export function buildJobWorkChallan(
  state: JobWorkSendFormState,
  opts: { voucherTypeId: number; costs: readonly number[]; itemName?: (id: number) => string }
): { ok: true; payload: JobWorkChallanPayload } | { ok: false; error: string } {
  const c = state.challan
  if (c.godownId == null) return { ok: false, error: 'Pick the job worker' }
  const built = buildTransferPayload(withJobWorker(state.transfer, c), opts)
  if (!built.ok) return built
  return {
    ok: true,
    payload: {
      voucher: built.payload,
      challan: {
        kind: c.kind,
        godownId: c.godownId,
        natureOfProcessing: c.natureOfProcessing.trim() || null,
        goodsType: c.goodsType,
        challanNo: c.kind === 'return' ? c.challanNo.trim() || null : null,
        challanDate: c.kind === 'return' ? c.challanDate : null,
        originalChallanVoucherId: c.originalChallanVoucherId
      }
    }
  }
}

/** A saved send / return challan reopens in this form only when its transfer round-trips. */
export function jobWorkSendRepresentation(v: Voucher, c: JobWorkChallan): Representation<JobWorkSendFormState> {
  if (c.kind === 'receive') return { ok: false, reason: 'it is a job-work receipt (a manufacture)' }
  const t = transferRepresentation(v)
  if (!t.ok) return t
  const fixedSideOk = t.state.rows.every((r) => (c.kind === 'send' ? r.toGodownId === c.godownId : r.fromGodownId === c.godownId))
  if (!fixedSideOk) return { ok: false, reason: 'a row does not involve the job worker’s godown' }
  return {
    ok: true,
    state: {
      transfer: t.state,
      challan: {
        kind: c.kind,
        godownId: c.godownId,
        natureOfProcessing: c.natureOfProcessing ?? '',
        goodsType: c.goodsType,
        challanNo: c.challanNo ?? '',
        challanDate: c.challanDate,
        originalChallanVoucherId: c.originalChallanVoucherId
      }
    }
  }
}
