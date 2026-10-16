// WP 4.2: a restore from the bin or a PDC maturing early can run into the party's credit hold
// (`credit_hold`, the same refusal a new save gets). An owner (or anyone in a company without
// users) is asked for a reason and the call is retried with it — main audits it as
// 'credit_override'. Anyone else sees the refusal.
import { promptDialog } from './dialogs'

export async function withCreditHoldOverride<T>(
  run: (override?: { reason: string }) => Promise<T>,
  opts: { canOverride: boolean; what: string }
): Promise<T | null> {
  try {
    return await run()
  } catch (err) {
    if ((err as { code?: string }).code !== 'credit_hold' || !opts.canOverride) throw err
    const reason = await promptDialog({
      title: 'Override the credit hold',
      message: `${(err as Error).message}. ${opts.what} will go ahead; your reason is recorded in the audit trail.`,
      placeholder: 'Reason, e.g. advance received',
      confirmLabel: 'Override'
    })
    if (reason == null) return null
    if (reason.trim().length < 3) throw new Error('Give a reason for the override')
    return run({ reason: reason.trim() })
  }
}
