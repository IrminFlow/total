import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { DataFolderPick, DataFolderProblem } from '@shared/dataFolder'
import type { MessageKey } from '@shared/i18n/catalogues/en'
import { mapError } from '@shared/errors'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useCanSetMode } from '../lib/mode'
import { useNav, useSession } from '../state/stores'
import { Button } from '../components/ui'

const DATA_ROOT_KEY = ['appDataRoot'] // i18n-technical: query key

const PROBLEM_KEYS: Record<DataFolderProblem, MessageKey> = {
  same: 'errors.dataFolder.same',
  inside_current: 'errors.dataFolder.insideCurrent',
  contains_current: 'errors.dataFolder.containsCurrent',
  not_empty: 'errors.dataFolder.notEmpty',
  not_a_folder: 'errors.dataFolder.notAFolder',
  not_writable: 'errors.dataFolder.notWritable',
  no_space: 'errors.dataFolder.noSpace'
}

/** "12.4 MB" — a size for the confirm sentence (digits and a unit, the same in every language). */
function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB` // i18n-technical
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB` // i18n-technical
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB` // i18n-technical
}

/**
 * "Where Total keeps your books" — the data folder in use, a plain OneDrive / cloud-sync warning,
 * and "Move to another folder…": main picks the folder, copies the books there, checks the copy,
 * remembers it and restarts Total (ipcDataRoot.ts). Shown in Settings → About (full app) and
 * Settings → Backups (simple). Owner only where the business has sign-ins.
 */
export function DataFolderSetting(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const clearCompany = useSession((s) => s.clearCompany)
  const canSet = useCanSetMode()
  const { data } = useQuery({ queryKey: DATA_ROOT_KEY, queryFn: api.app.dataRoot })
  const [pick, setPick] = useState<DataFolderPick | null>(null)
  const [busy, setBusy] = useState(false)
  const [state, setState] = useState<'idle' | 'moving' | 'moved'>('idle') // i18n-technical
  const [error, setError] = useState<{ text: string; detail: string } | null>(null)

  const choose = async (): Promise<void> => {
    setError(null)
    setBusy(true)
    try {
      setPick(await api.app.pickDataRoot())
    } catch (err) {
      setError({ text: mapError(err as Error, { simple: true, t }).general ?? t('simple.dataFolder.failed'), detail: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const move = async (): Promise<void> => {
    if (!pick?.ok) return
    setError(null)
    setState('moving') // i18n-technical
    try {
      await api.app.moveDataRoot(pick.path)
      setState('moved') // i18n-technical
    } catch (err) {
      setState('idle') // i18n-technical
      setPick(null)
      setError({ text: mapError(err as Error, { simple: true, t }).general ?? t('simple.dataFolder.failed'), detail: (err as Error).message })
      // A copy that failed after the business was closed: back to the list of businesses.
      const current = await api.company.current().catch(() => null)
      if (!current) {
        clearCompany()
        nav.home()
      }
    }
  }

  if (!data) return <div data-testid="data-folder-setting" data-loading="true" />

  return (
    <section className="mt-4 rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="data-folder-setting">
      <h2 className="text-subtitle font-semibold text-ink">{t('simple.dataFolder.title')}</h2>
      <p className="mt-1 text-detail text-muted">{t('simple.dataFolder.current')}</p>
      <p className="mt-1 break-all font-mono text-detail text-ink" data-testid="data-folder-path">
        {data.path}
      </p>
      <p className="mt-1 text-small text-muted" data-testid="data-folder-source" data-source={data.source}>
        {data.source === 'env' ? t('simple.dataFolder.env') : data.source === 'pointer' ? t('simple.dataFolder.chosen') : t('simple.dataFolder.usual')}
      </p>
      {data.missingPointer && (
        <p role="alert" className="mt-2 text-detail text-cr" data-testid="data-folder-missing">
          {t('simple.dataFolder.missing', { path: data.missingPointer })}
        </p>
      )}
      {(data.oneDrive || data.synced) && (
        <p role="note" className="mt-2 rounded-md border border-line bg-panel2 px-3 py-2 text-detail text-ink" data-testid="data-folder-synced" data-onedrive={data.oneDrive ? 'true' : 'false'}>
          {data.oneDrive ? t('simple.dataFolder.oneDrive') : t('simple.dataFolder.synced')}
        </p>
      )}
      {data.source !== 'env' && state === 'idle' && !pick?.ok && (
        <div className="mt-3">
          <Button disabled={!canSet || busy} onClick={() => void choose()} data-testid="btn-data-folder-move">
            {t('simple.dataFolder.move')}
          </Button>
          {!canSet && <p className="mt-1 text-hint text-muted">{t('simple.updates.ownerOnly')}</p>}
        </div>
      )}
      {pick && !pick.ok && pick.problem && (
        <p role="alert" className="mt-2 text-detail text-cr" data-testid="data-folder-problem" data-problem={pick.problem}>
          {t(PROBLEM_KEYS[pick.problem]) /* i18n-technical: a registry key */}
        </p>
      )}
      {pick?.ok && state === 'idle' && (
        <div className="mt-3 rounded-md border border-line px-3 py-3" data-testid="data-folder-confirm" data-kind={pick.kind}>
          <p className="text-detail font-medium text-ink">{t('simple.dataFolder.confirmTitle')}</p>
          <p className="mt-1 break-all font-mono text-detail text-ink">{pick.path}</p>
          <p className="mt-1 text-detail text-muted">
            {pick.kind === 'total' ? t('simple.dataFolder.confirmUse') : t('simple.dataFolder.confirmCopy', { size: sizeLabel(pick.bytes ?? 0) })}
          </p>
          {(pick.oneDrive || pick.synced) && <p className="mt-1 text-detail text-cr">{t('simple.dataFolder.pickSynced')}</p>}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" onClick={() => void move()} data-testid="btn-data-folder-confirm">
              {pick.kind === 'total' ? t('simple.dataFolder.useNow') : t('simple.dataFolder.moveNow')}
            </Button>
            <Button onClick={() => setPick(null)} data-testid="btn-data-folder-cancel">
              {t('common.cancel')}
            </Button>
          </div>
        </div>
      )}
      {state === 'moving' && (
        <p role="status" className="mt-3 text-detail text-ink" data-testid="data-folder-moving">
          {t('simple.dataFolder.moving')}
        </p>
      )}
      {state === 'moved' && (
        <p role="status" className="mt-3 text-detail text-ink" data-testid="data-folder-moved">
          {t('simple.dataFolder.moved')}
        </p>
      )}
      {error && (
        <div role="alert" className="mt-2" data-testid="data-folder-error">
          <p className="text-detail text-cr">{error.text}</p>
          <details className="mt-1 text-small text-muted">
            <summary>{t('common.details')}</summary>
            {error.detail}
          </details>
        </div>
      )}
      <p className="mt-3 text-small text-muted">{t('simple.dataFolder.hint')}</p>
    </section>
  )
}
