import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useCanSetMode } from '../lib/mode'
import { useToasts } from '../state/stores'
import { Button } from '../components/ui'

const UPDATES_KEY = ['appUpdates'] // i18n-technical

/**
 * Settings → How Total looks (simple shell): "Check for updates automatically" (app-wide, default on,
 * owner only where the business has users) and "Check now". Same app-level setting as the full app's
 * Settings → About.
 */
export function UpdatesSetting(): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const canSet = useCanSetMode()
  const { data } = useQuery({ queryKey: UPDATES_KEY, queryFn: api.app.updates })
  const [busy, setBusy] = useState(false)
  const autoCheck = data?.settings.autoCheck ?? true

  const toggle = async (next: boolean): Promise<void> => {
    setBusy(true)
    try {
      await api.app.setAutoCheck(next)
      await queryClient.invalidateQueries({ queryKey: UPDATES_KEY })
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const checkNow = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.app.checkUpdates()
      if (r.status === 'dev') toast.push('info', t('simple.updates.dev'))
      else if (r.status === 'up-to-date') toast.push('success', t('simple.updates.upToDate', { version: r.current }))
      else if (r.status === 'available') toast.push('info', t('simple.updates.available', { version: (r.latest ?? '').replace(/^v/, '') }))
      else toast.push('error', t('simple.updates.failed'))
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-line/70 px-panel py-3 last:border-b-0" data-testid="updates-setting">
      <p className="text-detail font-medium text-ink">{t('simple.updates.title')}</p>
      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          className="mt-1"
          checked={autoCheck}
          disabled={!canSet || busy || !data}
          onChange={(e) => void toggle(e.target.checked)}
          data-testid="chk-update-auto"
        />
        <span>
          <span className="block text-detail text-ink">{t('simple.updates.auto')}</span>
          <span className="block text-hint text-muted">{t('simple.updates.autoHint')}</span>
          {!canSet && <span className="block text-hint text-muted">{t('simple.updates.ownerOnly')}</span>}
        </span>
      </label>
      <div className="mt-2">
        <Button disabled={busy} onClick={() => void checkNow()} data-testid="btn-update-check">
          {t('simple.updates.checkNow')}
        </Button>
      </div>
    </div>
  )
}
