/**
 * The filing register's shapes.
 *
 * Kept in `shared` rather than in the service because both sides need them and the renderer
 * cannot import a main-process module. The register is half computed and half stored, and these
 * types are the seam: `Deadline` is what the calendar says is owed, `FilingRecord` is what the
 * portal was told, and `FilingRow` is the two joined.
 */

import type { Deadline } from '../compliance'
import type { LateCharge } from './lateFee'

export interface FilingRecord {
  form: string
  period: string
  /** ISO date the return was filed, or null while it is outstanding. */
  filedAt: string | null
  /** Acknowledgement Reference Number from the portal — the proof it was filed. */
  arn: string | null
  taxPaid: number
  lateFee: number
  interest: number
  notes: string | null
}

/**
 * Where an obligation stands.
 *
 * 'upcoming' covers a period that has not ended yet, which is distinct from 'due': there is
 * nothing to file for a month still running, and calling that overdue would be a false alarm
 * every single month.
 */
export type FilingStatus = 'filed' | 'due' | 'overdue' | 'upcoming'

export interface FilingRow extends Deadline {
  record: FilingRecord | null
  status: FilingStatus
  /**
   * Late fee and interest — from the recorded filing date when there is one, or projected to
   * today when there is not. The projection is the point: it turns a due date into a rupee
   * figure, which is what makes the choice between filing today and filing next week concrete.
   */
  charge: LateCharge
  /** True when `charge` is a projection rather than what a filing actually cost. */
  projected: boolean
}

export interface FilingUpsert {
  form: string
  period: string
  dueDate: string
  /** Null clears the filing, returning the row to outstanding. */
  filedAt: string | null
  arn: string | null
  taxPaid: number
  notes: string | null
}
