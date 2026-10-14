import { useRef, useState } from 'react'
import type { StatementPreview, StatementSource } from '@shared/bankTypes'
import { mapError, type CaughtError } from '@shared/errors'
import { toPlainDate } from '@shared/dates'
import { STATEMENT_EXTENSIONS, STATEMENT_MAX_BYTES } from '@shared/simple/bank'
import { bankingApi } from '../../lib/bankingClient'
import { fileToBase64 } from '../../lib/captureClient'
import { useT } from '../../lib/i18n'
import { useNav } from '../../state/stores'
import { Button } from '../../components/ui'

const IMPORT_TAB = 'import' as const // i18n-technical
const ACCEPT = STATEMENT_EXTENSIONS.map((e) => `.${e}`).join(',') // i18n-technical: file input filter

/**
 * WP 9.6 — "Add a bank statement": drop the file (its bytes are read here and sent; no path leaves
 * the renderer; "Choose a file" opens the same file input), then the existing WP 4.1
 * preview says how many new lines it found (lines added before are left out) and "Add these
 * lines" commits them. The formats are explained in plain words; a file the parsers can't read
 * without a column mapping is sent to the full app's import, once, never guessed.
 */
export function StatementDrop({ bankLedgerId, onAdded }: { bankLedgerId: number; onAdded: (inserted: number, fileName: string) => void }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const [source, setSource] = useState<StatementSource | null>(null)
  const [preview, setPreview] = useState<StatementPreview | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [unreadable, setUnreadable] = useState(false)
  const [busy, setBusy] = useState(false)
  const [over, setOver] = useState(false)

  const reset = (): void => {
    setSource(null)
    setPreview(null)
    setProblem(null)
    setUnreadable(false)
  }

  const plain = (err: unknown): string => {
    const m = mapError(err as CaughtError, { simple: true, t })
    return [m.general, ...Object.values(m.fields)].filter(Boolean).join(' ') || (err as Error).message
  }

  const run = async (src: StatementSource): Promise<void> => {
    reset()
    setSource(src)
    setBusy(true)
    try {
      const p = await bankingApi.import.preview(bankLedgerId, src)
      setPreview(p)
      setUnreadable(p.lines.length === 0)
    } catch (err) {
      setUnreadable(true)
      setProblem(plain(err))
    } finally {
      setBusy(false)
    }
  }

  const fromFile = async (file: File): Promise<void> => {
    if (file.size > STATEMENT_MAX_BYTES) {
      reset()
      setProblem(t('simple.bank.tooBig'))
      return
    }
    await run({ fileName: file.name, base64: await fileToBase64(file) })
  }

  const inputRef = useRef<HTMLInputElement>(null)

  const commit = async (): Promise<void> => {
    if (!source || !preview) return
    setBusy(true)
    try {
      const r = await bankingApi.import.commit(bankLedgerId, source)
      onAdded(r.inserted, source.fileName)
      reset()
    } catch (err) {
      setProblem(t('simple.bank.fileProblem', { reason: plain(err) }))
    } finally {
      setBusy(false)
    }
  }

  const newLines = preview ? preview.lines.filter((l) => !l.duplicate) : []
  const dates = newLines.map((l) => l.date).sort()

  return (
    <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1" aria-label={t('simple.bank.import')} data-testid="bank-statement">
      <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.bank.import')}</h2>
      {!preview && (
        <div
          className={`flex flex-col items-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center ${over ? 'border-amber bg-amberbar/10' : 'border-line bg-panel2'}`}
          data-testid="bank-drop"
          onDragOver={(e) => {
            e.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            const f = e.dataTransfer.files[0]
            if (f) void fromFile(f)
          }}
        >
          <p className="text-body text-ink">{t('simple.bank.drop')}</p>
          <p className="text-small text-muted">{t('simple.bank.or')}</p>
          <Button variant="primary" disabled={busy} data-testid="btn-bank-choose" onClick={() => inputRef.current?.click()}>
            {t('simple.bank.choose')}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="input-bank-file"
            onChange={(e) => {
              const f = e.target.files?.[0]
              e.target.value = ''
              if (f) void fromFile(f)
            }}
          />
        </div>
      )}
      <p className="mt-2 text-small text-muted">{t('simple.bank.formats')}</p>
      {busy && <p className="mt-2 text-detail text-muted">{t('simple.bank.reading')}</p>}

      {preview && !unreadable && source && (
        <div className="mt-3 flex flex-col gap-2" data-testid="bank-preview">
          <p className="text-body text-ink" data-testid="bank-preview-found" data-count={newLines.length}>
            {newLines.length
              ? t('simple.bank.found', { file: source.fileName, count: newLines.length, from: toPlainDate(dates[0]!), to: toPlainDate(dates.at(-1)!) })
              : t('simple.bank.foundNone', { file: source.fileName })}
          </p>
          {preview.duplicateCount > 0 && <p className="text-small text-muted">{t('simple.bank.already', { count: preview.duplicateCount })}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" disabled={busy || newLines.length === 0} data-testid="btn-bank-add-lines" onClick={() => void commit()}>
              {t('simple.bank.addLines')}
            </Button>
            <Button disabled={busy} data-testid="btn-bank-other-file" onClick={reset}>
              {t('simple.bank.cancelFile')}
            </Button>
          </div>
        </div>
      )}

      {(unreadable || problem) && (
        <div role="alert" className="mt-3 rounded-md border border-warning/50 bg-warning/10 px-3 py-2 text-detail text-ink" data-testid="bank-file-problem">
          {unreadable && <p>{t('simple.bank.unreadable')}</p>}
          {problem && <p className="mt-1 text-muted">{problem}</p>}
          <div className="mt-2 flex flex-wrap gap-3">
            {unreadable && (
              <button type="button" className="text-detail text-blue hover:underline" data-testid="btn-bank-set-up-once" onClick={() => nav.go({ name: 'banking', tab: IMPORT_TAB, ledgerId: bankLedgerId })} // i18n-technical
              >
                {t('simple.bank.setUpOnce')}
              </button>
            )}
            <button type="button" className="text-detail text-blue hover:underline" data-testid="btn-bank-try-again" onClick={reset}>
              {t('simple.bank.cancelFile')}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
