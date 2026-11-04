import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useToasts } from '../state/stores'
import { Button } from '../components/ui'
import type { MessageKey } from '@shared/i18n'
import { moreFeatures, turnOffFeature, turnOnFeature, type CompanyFeatures, type HideableFeature } from '@shared/features'

/**
 * Review of #194 — the door to a feature hidden until used: Settings → Features (both shells)
 * ends with a collapsed "More features" list of the hidden ones (shared/features.ts
 * `moreFeatures`). Turning one on stores it in `features.turnedOn` (+ its flag and what it needs),
 * so its screens show without any data; turning it off hides it again while it has none. Owner
 * only, like `config:features:set`.
 */
// i18n-technical: feature keys and message keys only.
const NAMES: Record<HideableFeature, { name: MessageKey; who: MessageKey }> = {
  costCentres: { name: 'simple.features.label.costCentres', who: 'simple.features.costCentres' }, // i18n-technical
  cheques: { name: 'simple.features.label.cheques', who: 'simple.features.cheques' }, // i18n-technical
  interest: { name: 'simple.features.label.interest', who: 'simple.features.interest' }, // i18n-technical
  fixedAssets: { name: 'simple.features.label.fixedAssets', who: 'simple.features.fixedAssets' }, // i18n-technical
  tradeCycle: { name: 'simple.features.label.orders', who: 'simple.features.orders' }, // i18n-technical
  payrollStatutory: { name: 'simple.features.label.payrollStatutory', who: 'simple.features.payrollStatutory' } // i18n-technical
}

export function MoreFeatures({ stored, noData, canEdit }: { stored: CompanyFeatures; noData: ReadonlySet<HideableFeature>; canEdit: boolean }): React.JSX.Element | null {
  const t = useT()
  const say = (k: MessageKey): string => t(k) // i18n-technical: keys from NAMES
  const toast = useToasts()
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<HideableFeature | null>(null)
  const list = moreFeatures(noData, stored)
  if (list.length === 0) return null

  const flip = async (h: HideableFeature, on: boolean): Promise<void> => {
    const names = NAMES[h]
    setBusy(h)
    try {
      await api.config.features.set(on ? turnOffFeature(stored, h) : turnOnFeature(stored, h))
      await queryClient.invalidateQueries({ queryKey: ['features'] }) // i18n-technical
      toast.push('success', on ? t('simple.features.turnedOff', { name: say(names.name) }) : t('simple.features.turnedOn', { name: say(names.name) }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="mt-section" data-testid="features-more">
      <button
        type="button"
        className="flex items-center gap-2 text-body font-medium text-ink hover:underline"
        aria-expanded={open}
        aria-controls="features-more-list"
        data-testid="btn-features-more"
        onClick={() => setOpen((o) => !o)}
      >
        <span aria-hidden="true">{open ? '▾' : '▸'}</span>
        {t('simple.features.more')}
      </button>
      <div id="features-more-list" hidden={!open}>
        <p className="mb-3 mt-1 text-small text-muted">{t('simple.features.moreHint')}</p>
        <div className="divide-y divide-line rounded-lg border border-line bg-panel shadow-elev-1">
          {list.map(({ feature, on }) => {
            const names = NAMES[feature]
            return (
              <div key={feature} className="flex items-start justify-between gap-4 px-panel py-3.5" data-testid={`feature-more-card-${feature}`} data-on={on ? 'true' : 'false'}>
                <div className="min-w-0">
                  <p className="text-body font-medium text-ink">
                    {say(names.name)}{' '}
                    <span className={`ml-1 rounded px-1.5 py-0.5 text-hint ${on ? 'bg-amberbar/20 text-ink' : 'bg-panel2 text-muted'}`}>
                      {on ? t('simple.features.on') : t('simple.features.off')}
                    </span>
                  </p>
                  <p className="mt-0.5 text-small text-muted">{say(names.who)}</p>
                </div>
                {canEdit && (
                  <Button variant={on ? 'ghost' : 'primary'} disabled={busy !== null} data-testid={`btn-feature-more-${feature}`} onClick={() => void flip(feature, on)}>
                    {busy === feature ? t('simple.features.saving') : on ? t('simple.features.turnOff') : t('simple.features.turnOn')}
                  </Button>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </section>
  )
}
