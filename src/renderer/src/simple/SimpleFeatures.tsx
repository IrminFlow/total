import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useCanSetMode } from '../lib/mode'
import { useToasts } from '../state/stores'
import { Button, Page } from '../components/ui'
import type { MessageKey } from '@shared/i18n'
import { DEFAULT_FEATURES, effectiveFeatures, type CompanyFeatures } from '@shared/features'

/**
 * WP 8.3 (plan §4.3): Settings → Features in the simple shell — one "Turn on" card per module with
 * a plain name and one line on who needs it (no accounting terms; the accountant view is
 * Settings → Features in the full app). Owner only, like `config:features:set`; saved at once.
 */
type Key = keyof CompanyFeatures
interface Card {
  key: Key
  name: MessageKey
  who: MessageKey
  needsStock?: boolean
}

// i18n-technical: feature keys and message keys only.
const CARDS: Card[] = [
  { key: 'inventory', name: 'simple.features.label.inventory', who: 'simple.features.inventory' }, // i18n-technical
  { key: 'manufacturing', name: 'simple.features.label.manufacturing', who: 'simple.features.manufacture', needsStock: true }, // i18n-technical
  { key: 'orders', name: 'simple.features.label.orders', who: 'simple.features.orders', needsStock: true }, // i18n-technical
  { key: 'tds', name: 'simple.features.label.tds', who: 'simple.features.tds' }, // i18n-technical
  { key: 'tcs', name: 'simple.features.label.tcs', who: 'simple.features.tcs' }, // i18n-technical
  { key: 'payroll', name: 'simple.features.label.payroll', who: 'simple.features.payroll' }, // i18n-technical
  { key: 'multiCurrency', name: 'simple.features.label.multiCurrency', who: 'simple.features.multiCurrency' }, // i18n-technical
  { key: 'costCentres', name: 'simple.features.label.costCentres', who: 'simple.features.costCentres' }, // i18n-technical
  { key: 'billWise', name: 'simple.features.label.billWise', who: 'simple.features.billWise' } // i18n-technical
]

export function SimpleFeatures(): React.JSX.Element {
  const t = useT()
  const say = (k: MessageKey, vars?: Record<string, string>): string => t(k, vars) // i18n-technical: keys from CARDS
  const toast = useToasts()
  const queryClient = useQueryClient()
  const canEdit = useCanSetMode()
  const { data } = useQuery({ queryKey: ['features'], queryFn: api.config.features.get }) // i18n-technical
  const stored = data ?? DEFAULT_FEATURES
  const value = effectiveFeatures(stored)
  const [busy, setBusy] = useState<Key | null>(null)

  const flip = async (c: Card): Promise<void> => {
    const next: CompanyFeatures = { ...stored, [c.key]: !value[c.key] }
    if (next[c.key] && c.needsStock) next.inventory = true
    setBusy(c.key)
    try {
      await api.config.features.set(next)
      await queryClient.invalidateQueries({ queryKey: ['features'] }) // i18n-technical
      toast.push('success', next[c.key] ? t('simple.features.turnedOn', { name: say(c.name) }) : t('simple.features.turnedOff', { name: say(c.name) }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Page width="narrow">
      <div data-testid="simple-features">
        <h1 className="mb-1 font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.settings.features')}</h1>
        <p className="mb-5 text-small text-muted">{t('simple.features.intro')}</p>
        <div className="divide-y divide-line rounded-lg border border-line bg-panel shadow-elev-1" data-testid="features-cards">
          {CARDS.map((c) => {
            const on = !!value[c.key]
            return (
              <div key={c.key} className="flex items-start justify-between gap-4 px-panel py-3.5" data-testid={`feature-card-${c.key}`} data-on={on ? 'true' : 'false'}>
                <div className="min-w-0">
                  <p className="text-body font-medium text-ink">
                    {say(c.name)}{' '}
                    <span className={`ml-1 rounded px-1.5 py-0.5 text-hint ${on ? 'bg-amberbar/20 text-ink' : 'bg-panel2 text-muted'}`}>
                      {on ? t('simple.features.on') : t('simple.features.off')}
                    </span>
                  </p>
                  <p className="mt-0.5 text-small text-muted">{say(c.who)}</p>
                </div>
                {canEdit && (
                  <Button variant={on ? 'ghost' : 'primary'} disabled={busy !== null} data-testid={`btn-feature-${c.key}`} onClick={() => void flip(c)}>
                    {busy === c.key ? t('simple.features.saving') : on ? t('simple.features.turnOff') : t('simple.features.turnOn')}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
        {!canEdit && <p className="mt-3 text-small text-muted">{t('simple.settings.mode.ownerOnly')}</p>}
      </div>
    </Page>
  )
}
