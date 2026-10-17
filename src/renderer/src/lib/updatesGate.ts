import { useQuery } from '@tanstack/react-query'
import { api } from './client'
import { useSession } from '../state/stores'
import type { UpdatesCanSet } from '@shared/updates'

export const UPDATES_CAN_SET_KEY = ['appUpdatesCanSet'] // i18n-technical

/** Who may change the app-wide update setting, asked of main BEFORE the click (the AI-key rule).
 *  While loading or if main can't answer, the old local rule (owner / no sign-in) applies and main
 *  still refuses the write itself. */
export function useUpdatesCanSet(): UpdatesCanSet {
  const user = useSession((s) => s.user)
  const slug = useSession((s) => s.slug)
  const local = !user || user.role === 'owner'
  const { data } = useQuery({ queryKey: [...UPDATES_CAN_SET_KEY, slug, user?.id ?? null], queryFn: api.app.updatesCanSet, retry: false })
  return data ?? { allowed: local, reason: local ? 'ok' : 'owner_only' }
}

const CONFIRM_CODE = 'updates_confirm_no_users' // i18n-technical

/** Run an update-setting write under the rule: ask first when the verdict says a confirmation is
 *  needed; and when main asks for one the verdict did not foresee (it was still loading, unreadable, or
 *  stale — e.g. the notice on the company-select screen clicked before canSet answered), ask then and
 *  send it once more with the confirmation. Resolves false when the user said no. */
export async function runUpdatesWrite(
  gate: UpdatesCanSet,
  ask: () => Promise<boolean>,
  write: (confirmNoUsers: boolean) => Promise<unknown>
): Promise<boolean> {
  if (gate.reason === 'needs_confirmation') {
    if (!(await ask())) return false
    await write(true)
    return true
  }
  try {
    await write(false)
  } catch (err) {
    if ((err as { code?: string }).code !== CONFIRM_CODE) throw err
    if (!(await ask())) return false
    await write(true)
  }
  return true
}
