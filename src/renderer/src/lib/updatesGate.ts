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
