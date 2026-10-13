import { useState } from 'react'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useCanSetMode, useMode } from '../lib/mode'
import { useNav, useScreen, useSession, useToasts, type Screen } from '../state/stores'
import { screenDef } from '../lib/screens'
import { UI_MODES, type UiMode } from '@shared/simple/uiMode'

/**
 * WP 8.1: Settings → "How Total looks" → the company's mode. Owner only (everyone in a company
 * without users) — `ui:mode:set` refuses anyone else; others see the choice read-only. One plain line
 * explains each mode. Switching writes meta `ui` (audited) and the shell follows at once.
 */
const LOOKS: Screen = { name: 'simple-looks' }

export function ModeSetting(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const screen = useScreen()
  const mode = useMode()
  const canSet = useCanSetMode()
  const setUi = useSession((s) => s.setUi)
  const toast = useToasts()
  const [busy, setBusy] = useState(false)

  const choose = async (next: UiMode): Promise<void> => {
    if (next === mode || !canSet) return
    setBusy(true)
    try {
      const ui = await api.ui.set({ mode: next })
      setUi(ui)
      // Switched to simple on the full Settings (which has no simple view yet): land on the same
      // control in the simple shell, so the switch is visible at once.
      if (ui.mode === 'simple' && !screenDef(screen.name)?.modes.includes('simple')) nav.replace(LOOKS)
      toast.push('success', t('simple.settings.mode.switched', { mode: ui.mode }))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <fieldset className="border-b border-line/70 px-panel py-3" data-testid="mode-setting" disabled={busy}>
      <legend className="sr-only">{t('simple.settings.mode')}</legend>
      <p className="text-detail font-medium text-ink" aria-hidden="true">
        {t('simple.settings.mode')}
      </p>
      <div className="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2" role="radiogroup" aria-label={t('simple.settings.mode')}>
        {UI_MODES.map((m) => {
          const on = m === mode
          const label = m === 'simple' ? t('simple.settings.mode.simple') : t('simple.settings.mode.accountant')
          const hint = m === 'simple' ? t('simple.settings.mode.simpleHint') : t('simple.settings.mode.accountantHint')
          return (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!canSet}
              data-testid={`btn-mode-${m}`}
              onClick={() => void choose(m)}
              className={`rounded-lg border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed ${
                on ? 'border-amber bg-amberbar/15' : 'border-line bg-panel hover:border-amber/60 disabled:hover:border-line'
              }`}
            >
              <span className="block text-detail font-semibold text-ink">{label}</span>
              <span className="mt-0.5 block text-hint text-muted">{hint}</span>
            </button>
          )
        })}
      </div>
      <p className="mt-2 text-hint text-muted">{canSet ? t('simple.settings.mode.everyone') : t('simple.settings.mode.ownerOnly')}</p>
    </fieldset>
  )
}
