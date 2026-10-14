import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type UserRow } from '../lib/client'
import { useT } from '../lib/i18n'
import { useNav, useToasts } from '../state/stores'
import { useCanSetMode } from '../lib/mode'
import { Button } from '../components/ui'
import { NarrowPage, Plain } from './SecuritySettings'
import type { MessageKey } from '@shared/i18n'
import { CAPABILITIES, effectiveCapabilities, type Capability } from '@shared/capabilities'

/**
 * WP 7.2: Settings → People & roles in the simple shell — each person's role and what they may do,
 * as plain switches (shared/capabilities.ts; a switch left where the role puts it stores nothing).
 * The owner can always do everything, so the owner's row has no switches. Owner only (users:list
 * and users:save are); adding people and their PINs stays in the full app's Settings → Users.
 */
const CAP_LABEL: Record<Capability, MessageKey> = {
  canPost: 'simple.roles.cap.canPost', // i18n-technical
  canSeeProfit: 'simple.roles.cap.canSeeProfit', // i18n-technical
  canExport: 'simple.roles.cap.canExport', // i18n-technical
  canManageAi: 'simple.roles.cap.canManageAi' // i18n-technical
}
const ROLE_LABEL: Record<UserRow['role'], MessageKey> = {
  owner: 'simple.roles.role.owner', // i18n-technical
  accountant: 'simple.roles.role.accountant', // i18n-technical
  viewer: 'simple.roles.role.viewer' // i18n-technical
}
const USERS_KEY = ['users'] as const // i18n-technical
const USERS_TAB = { name: 'settings', tab: 'users' } as const // i18n-technical

export function PeopleRoles({ embedded = false }: { embedded?: boolean }): React.JSX.Element {
  const t = useT()
  const say = (k: MessageKey, vars?: Record<string, string>): string => t(k, vars) // i18n-technical: keys from the maps above
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const canEdit = useCanSetMode()
  const { data: users } = useQuery({ queryKey: USERS_KEY, queryFn: api.users.list, enabled: canEdit })
  const [busy, setBusy] = useState<string | null>(null)

  const flip = async (u: UserRow, cap: Capability, value: boolean): Promise<void> => {
    setBusy(`${u.id}:${cap}`)
    try {
      await api.users.save({ name: u.name, role: u.role, active: u.active, capabilities: { ...(u.capabilities ?? {}), [cap]: value } }, u.id)
      await queryClient.invalidateQueries({ queryKey: USERS_KEY })
      toast.push('success', t('simple.roles.saved', { name: u.name }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const Wrap = embedded ? Plain : NarrowPage
  return (
    <Wrap>
      <div data-testid="simple-people-roles" className={embedded ? 'mt-6' : ''}>
        <h1 className="mb-1 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.settings.peopleRoles')}</h1>
        <p className="mb-5 text-small text-muted">{t('simple.roles.intro')}</p>
        {!canEdit ? (
          <p className="text-small text-muted">{t('simple.roles.ownerOnly')}</p>
        ) : !users || users.length === 0 ? (
          <p className="text-detail text-ink" data-testid="roles-none">
            {t('simple.roles.none')}
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-panel shadow-elev-1">
            {users.map((u) => {
              const can = effectiveCapabilities(u.role, u.capabilities)
              return (
                <li key={u.id} className="px-panel py-3.5" data-testid={`roles-user-${u.id}`}>
                  <p className="text-body font-medium text-ink">
                    {u.name} <span className="ml-1 text-small font-normal text-muted">{say(ROLE_LABEL[u.role])}</span>
                    {!u.active && <span className="ml-1 text-small font-normal text-muted">{t('simple.roles.inactive')}</span>}
                  </p>
                  {u.role === 'owner' ? (
                    <p className="mt-0.5 text-small text-muted">{t('simple.roles.ownerAll')}</p>
                  ) : (
                    <div className="mt-2 flex flex-col gap-1.5">
                      {CAPABILITIES.map((cap) => (
                        <label key={cap} className="flex cursor-pointer items-center justify-between gap-3 text-detail text-ink">
                          <span>{say(CAP_LABEL[cap])}</span>
                          <input
                            type="checkbox"
                            role="switch"
                            aria-checked={can[cap]}
                            checked={can[cap]}
                            disabled={busy !== null}
                            onChange={(e) => void flip(u, cap, e.target.checked)}
                            data-testid={`roles-${u.id}-${cap}`}
                            className="h-4 w-4"
                          />
                        </label>
                      ))}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
        {canEdit && (
          <Button className="mt-4" variant="secondary" onClick={() => nav.go(USERS_TAB)} data-testid="btn-roles-manage">
            {t('simple.roles.manage')}
          </Button>
        )}
      </div>
    </Wrap>
  )
}
