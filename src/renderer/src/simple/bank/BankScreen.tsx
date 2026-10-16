import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { Ledger } from '@shared/domain'
import type { MessageKey } from '@shared/i18n'
import { mapError, type CaughtError } from '@shared/errors'
import { toPlainDate } from '@shared/dates'
import { CATEGORIES } from '@shared/simple/categories'
import {
  bankSentence, becauseFor, choiceForAccount, type BankAcceptItem, type BankChoice, type BankLineView, type BankSetup, type BankSuggestion
} from '@shared/simple/bank'
import { api } from '../../lib/client'
import { captureApi } from '../../lib/captureClient'
import { useAiAffordances } from '../../lib/explain'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { Button, Field, Page, Select } from '../../components/ui'
import { useGroups } from '../../components/pickers'
import { NewAccountDialog } from '../NewAccountDialog'
import { StatementDrop } from './StatementDrop'
import { LineCard, canSave, categoryFor, type LineProblem } from './LineCard'
import { DoneLines } from './DoneLines'
import { SkippedLines } from './SkippedLines'
import { lineKey, useSkippedLines } from './skipped'
import { EmptyTeach } from '../help/EmptyTeach'
import { useAccountantView } from '../../lib/handoff'
import { AccountantViewButton } from '../AccountantViewButton'
import { useCanSave, ViewerNote } from '../ViewerNote'

const BRS_TAB = 'brs' as const // i18n-technical
const IMPORT_TAB = 'import' as const // i18n-technical
const LINE_FIELDS = ['party', 'to', 'from', 'choice'] as const // i18n-technical: fields a line shows
const BANK_CONTEXT = { field: 'line', voucherKind: 'receipt', drCr: 'dr' } as const // i18n-technical: money in → a bank
const CONTRA_CONTEXT = { field: 'line', voucherKind: 'contra', drCr: 'dr' } as const // i18n-technical
const REFRESH = ['simpleBankLines', 'simpleBankSetup', 'ledgers', 'bankWorkspace', 'brs', 'dashboard', 'simpleHome'] // i18n-technical: query keys

type Creating = { what: 'customer' | 'supplier' | 'account' | 'bank'; name: string; lineId: number | null }

/**
 * WP 9.6 — Money → Bank (plan §3 "Bank"): pick the bank account (or add one), add a statement file
 * (the existing WP 4.1 parsers through the existing import channels), then for each line the bank
 * shows that is not in the books yet "What is this?" — the matcher's / categoriser's suggestion
 * pre-selected with its "because …" (no key needed; the assistant is asked only when AI is ready
 * and the user presses the button). Saving a line goes through simple:bank:accept (an intent via
 * simple:post's service, then the line is tied to the entry by the existing reconcile) — one line
 * or every suggestion at once, each on its own. The top sentence is the BRS in one line; "see
 * them" opens the full Banking → BRS on this account. Done lines stay listed as "Done".
 */
export function BankScreen({ bankId }: { bankId?: number }): React.JSX.Element {
  const t = useT()
  const mayWrite = useCanSave()
  const nav = useNav()
  const openFull = useAccountantView('simple-bank') // i18n-technical: screen name
  const queryClient = useQueryClient()
  const workingDate = useSession((s) => s.workingDate)
  const slug = useSession((s) => s.slug)
  const groups = useGroups()
  const aiReady = useAiAffordances()
  const { data: setup } = useQuery({ queryKey: ['simpleBankSetup'], queryFn: api.simpleBank.setup }) // i18n-technical
  const [bankLedgerId, setBankLedgerId] = useState<number | null>(bankId ?? null)
  useEffect(() => {
    if (bankLedgerId == null && setup?.banks.length) setBankLedgerId(setup.banks[0]!.id)
  }, [setup, bankLedgerId])
  const { data: view, isLoading } = useQuery({
    queryKey: ['simpleBankLines', bankLedgerId, workingDate], // i18n-technical
    queryFn: () => api.simpleBank.lines(bankLedgerId!, workingDate),
    enabled: bankLedgerId != null
  })

  const [answers, setAnswers] = useState<Record<number, BankChoice>>({})
  const [aiSugs, setAiSugs] = useState<Record<number, BankSuggestion>>({})
  const [problems, setProblems] = useState<Record<number, LineProblem>>({})
  const [busy, setBusy] = useState<Set<number>>(new Set())
  const [clientIds, setClientIds] = useState<Record<number, { sig: string; id: string }>>({})
  const [creating, setCreating] = useState<Creating | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [askNote, setAskNote] = useState<string | null>(null)

  // A new bank account: start afresh.
  useEffect(() => {
    setAnswers({})
    setAiSugs({})
    setProblems({})
    setNote(null)
    setAskNote(null)
  }, [bankLedgerId])

  const lines = view?.lines ?? []
  // "Skip for now" is remembered on this computer (skipped.ts): those lines wait in their own group.
  const { skipped, skip, bringBack } = useSkippedLines(slug, bankLedgerId)
  const allOpen = lines.filter((l) => l.status === 'open')
  const open = allOpen.filter((l) => !skipped.has(lineKey(l)))
  const skippedLines = allOpen.filter((l) => skipped.has(lineKey(l)))
  const settled = lines.filter((l) => l.status !== 'open')
  const suggestionOf = (l: BankLineView): BankSuggestion | null => l.suggestion ?? aiSugs[l.id] ?? null
  const choiceOf = (l: BankLineView): BankChoice | null => answers[l.id] ?? suggestionOf(l)?.choice ?? null
  const ready = open.filter((l) => canSave(choiceOf(l)))
  const residual = open.filter((l) => !suggestionOf(l) && !l.repeat) // a repeated row is the user's call, never the model's

  const refresh = async (): Promise<void> => {
    for (const k of REFRESH) await queryClient.invalidateQueries({ queryKey: [k] })
  }

  /** The category account a shortcut uses — added (with its category, as the presets do) when missing. */
  // `added` is the save's own list of accounts it added: two lines of one "Save all" that both need
  // the same new account (two interest credits) share it, never create it twice (a name clash
  // that would fail every line).
  const ensureCategory = async (choice: BankChoice, l: BankLineView, s: BankSetup, added: Map<string, number>): Promise<BankChoice> => {
    if ((choice.kind !== 'owner' && choice.kind !== 'charges') || choice.accountId) return choice
    const key = categoryFor(choice.kind, l.side)
    const def = CATEGORIES[key]
    const found = s.accounts.find((a) => a.category === key) ?? s.accounts.find((a) => a.name.toLowerCase() === def.name.toLowerCase())
    if (found) return { ...choice, accountId: found.id }
    const already = added.get(key)
    if (already != null) return { ...choice, accountId: already }
    const groupId = groups.find((g) => g.name === def.group)?.id
    if (groupId == null) return choice
    const created = await api.ledgers.create({
      name: def.name, groupId, openingBalance: 0, gstin: null, stateCode: null, address: null, taxType: null, gstRate: null, hsn: null,
      tdsSectionId: null, pan: null, creditDays: null, exportType: null, simpleCategory: key
    })
    added.set(key, created.id)
    return { ...choice, accountId: created.id }
  }

  const clientIdFor = (lineId: number, choice: BankChoice): string => {
    const sig = JSON.stringify(choice)
    const prior = clientIds[lineId]
    if (prior && prior.sig === sig) return prior.id
    const id = `bank-${lineId}-${crypto.randomUUID()}` // i18n-technical: idempotency key
    setClientIds((m) => ({ ...m, [lineId]: { sig, id } }))
    return id
  }

  const save = async (targets: BankLineView[]): Promise<void> => {
    if (!setup || bankLedgerId == null || targets.length === 0) return
    setNote(null)
    setBusy(new Set(targets.map((l) => l.id)))
    setProblems((p) => {
      const n = { ...p }
      for (const l of targets) delete n[l.id]
      return n
    })
    try {
      const items: BankAcceptItem[] = []
      const added = new Map<string, number>()
      for (const l of targets) {
        const c = choiceOf(l)
        if (!c || c.kind === 'skip') continue
        const choice = await ensureCategory(c, l, setup, added)
        if (choice.kind === 'skip') continue
        items.push({ lineId: l.id, clientId: clientIdFor(l.id, choice), choice })
      }
      if (!items.length) return
      const r = await api.simpleBank.accept(bankLedgerId, items, workingDate)
      const failed: Record<number, LineProblem> = {}
      for (const f of r.failed) {
        const m = mapError(f.error as CaughtError, { simple: true, t, fields: LINE_FIELDS })
        failed[f.lineId] = { fields: m.fields, general: m.general ?? (Object.keys(m.fields).length ? null : t('simple.bank.lineProblem')), details: m.details }
      }
      setProblems((p) => ({ ...p, ...failed }))
      if (targets.length > 1 || r.failed.length === 0) {
        setNote(
          [r.done.length ? t('simple.bank.acceptedSome', { done: r.done.length }) : '', r.failed.length ? t('simple.bank.acceptedFailed', { failed: r.failed.length }) : '']
            .filter(Boolean)
            .join(' ')
        )
      }
      await refresh()
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t, fields: LINE_FIELDS })
      const problem: LineProblem = { fields: m.fields, general: m.general ?? t('simple.bank.lineProblem'), details: m.details }
      setProblems((p) => ({ ...p, ...Object.fromEntries(targets.map((l) => [l.id, problem])) }))
    } finally {
      setBusy(new Set())
    }
  }

  const ask = async (): Promise<void> => {
    if (!setup || bankLedgerId == null) return
    setAsking(true)
    setAskNote(null)
    try {
      const r = await captureApi.categorise(bankLedgerId, true)
      const byId = new Map(setup.accounts.map((a) => [a.id, a]))
      const want = new Set(residual.map((l) => l.id))
      const next: Record<number, BankSuggestion> = {}
      for (const row of r.rows) {
        if (row.source !== 'ai' || !row.ledgerId || !want.has(row.lineId)) continue
        const acc = byId.get(row.ledgerId)
        const choice = choiceForAccount(acc, row.side, bankLedgerId)
        if (acc && choice) next[row.lineId] = { choice, source: 'ai', because: becauseFor('ai', { name: acc.name }) } // i18n-technical
      }
      setAiSugs((m) => ({ ...m, ...next }))
      if (!Object.keys(next).length) setAskNote(t('simple.bank.askNone'))
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t })
      setAskNote(t('simple.bank.askProblem', { reason: m.general ?? m.details }))
    } finally {
      setAsking(false)
    }
  }

  const sentence = view ? bankSentence(view.sentence) : null
  const sentenceText = sentence ? t(sentence.key as MessageKey, { ...sentence.vars, ...(sentence.tone === 'agree' || sentence.tone === 'balance' ? { date: toPlainDate(String(sentence.vars.date), t.lang) } : {}) }) : '' // i18n-technical: key from bankSentence
  const seeThem = (): void => {
    if (bankLedgerId == null || !view?.sentence.asOn) return
    nav.go({ name: 'banking', tab: BRS_TAB, ledgerId: bankLedgerId, asOn: view.sentence.asOn }) // i18n-technical
  }

  const created = (l: Ledger): void => {
    const c = creating
    setCreating(null)
    void queryClient.invalidateQueries({ queryKey: ['simpleBankSetup'] }) // i18n-technical
    if (!c) return
    if (c.what === 'bank') {
      setBankLedgerId(l.id)
      return
    }
    if (c.lineId == null) return
    const choice: BankChoice = c.what === 'customer' ? { kind: 'customer', partyId: l.id } : c.what === 'supplier' ? { kind: 'supplier', partyId: l.id } : { kind: 'transfer', accountId: l.id } // i18n-technical
    setAnswers((a) => ({ ...a, [c.lineId!]: choice }))
  }

  const banks = setup?.banks ?? []

  return (
    <Page data-testid="simple-bank">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-heading font-semibold tracking-tight text-ink">{t('simple.bank.title')}</h1>
          <p className="mt-1 text-detail text-muted">{t('simple.bank.subtitle')}</p>
        </div>
        <AccountantViewButton
          testId="btn-bank-accountant-view"
          title={t('simple.bank.accountantHint')}
          onOpen={(always) => void openFull({ intent: null, always, fallback: { name: 'banking', tab: IMPORT_TAB, ...(bankLedgerId != null ? { ledgerId: bankLedgerId } : {}) } })} // i18n-technical
        />
      </div>

      {setup && banks.length === 0 ? (
        <EmptyTeach
          testId="bank-no-bank"
          purpose={t('simple.empty.bank')}
          action={{ label: t('simple.bank.addBank'), testId: 'btn-bank-add-bank', onClick: () => setCreating({ what: 'bank', name: '', lineId: null }) }} // i18n-technical
          help="bank-statement" // i18n-technical
        />
      ) : (
        <div className="flex flex-col gap-4">
          <section className="flex flex-wrap items-end gap-4">
            <div className="w-72">
              <Field label={t('simple.bank.whichAccount')}>
                <Select value={bankLedgerId ?? ''} onChange={(e) => setBankLedgerId(Number(e.target.value))} data-testid="select-bank-account">
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <button type="button" className="mb-2 text-detail text-blue hover:underline" data-testid="btn-bank-add-another" onClick={() => setCreating({ what: 'bank', name: '', lineId: null })} // i18n-technical
            >
              {t('simple.bank.addBank')}
            </button>
          </section>

          {sentence && (
            <section
              role="status"
              className={`rounded-lg border px-4 py-3 ${
                sentence.tone === 'agree' ? 'border-success/50 bg-success/10' : sentence.tone === 'differ' || sentence.tone === 'balance' ? 'border-amber/60 bg-amberbar/10' : 'border-line bg-panel2'
              }`}
              data-testid="bank-sentence"
              data-tone={sentence.tone}
              data-differ={view?.sentence.differ ?? 0}
              data-open={view?.sentence.open ?? 0}
            >
              {sentence.tone === 'differ' ? (
                <>
                  <button type="button" className="text-left text-body font-medium text-blue hover:underline" data-testid="btn-bank-see-them" onClick={seeThem}>
                    {sentenceText}
                  </button>
                  <p className="mt-1 text-small text-muted" data-testid="bank-differ-hint">
                    {t('simple.bank.differHint', { count: view!.sentence.differ, date: toPlainDate(view!.sentence.asOn!, t.lang) })}
                  </p>
                </>
              ) : (
                <p className="text-body font-medium text-ink">{sentenceText}</p>
              )}
            </section>
          )}

          {bankLedgerId != null && (
            <StatementDrop
              key={bankLedgerId}
              bankLedgerId={bankLedgerId}
              compact={lines.length > 0}
              onAdded={(count, file) => {
                setNote(t('simple.bank.added', { count, file }))
                void refresh()
              }}
            />
          )}

          {note && (
            <p role="status" className="text-detail text-ink" data-testid="bank-note">
              {note}
            </p>
          )}

          {isLoading && <p className="text-detail text-muted">{t('simple.bank.loading')}</p>}

          {view && open.length > 0 && (
            <section aria-label={t('simple.bank.toAnswer')} className="flex flex-col gap-3" data-testid="bank-open">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h2 className="text-subtitle font-semibold text-ink">
                  {t('simple.bank.toAnswer')} <span className="text-detail font-normal text-muted">{t('simple.bank.toAnswerCount', { count: open.length })}</span>
                </h2>
                {mayWrite ? (
                  <Button variant="primary" disabled={ready.length === 0 || busy.size > 0} data-testid="btn-bank-accept-all" onClick={() => void save(ready)}>
                    {t('simple.bank.acceptAllCount', { count: ready.length })}
                  </Button>
                ) : (
                  <ViewerNote />
                )}
              </div>
              {aiReady && residual.length > 0 && (
                <div className="rounded-lg border border-line bg-panel2 px-4 py-3" data-testid="bank-ask">
                  <p className="text-small text-muted">{t('simple.bank.askNote')}</p>
                  <Button className="mt-2" disabled={asking} data-testid="btn-bank-ask" onClick={() => void ask()}>
                    {asking ? t('simple.bank.asking') : t('simple.bank.ask', { count: residual.length })}
                  </Button>
                  {askNote && <p className="mt-2 text-small text-ink">{askNote}</p>}
                </div>
              )}
              {open.map((l) => (
                <LineCard
                  key={l.id}
                  line={l}
                  setup={setup!}
                  bankLedgerId={bankLedgerId!}
                  suggestion={suggestionOf(l)}
                  choice={choiceOf(l)}
                  onChoice={(c) => {
                    if (c.kind === 'skip') {
                      // Remembered, and moved under "Skipped for now" (nothing is saved).
                      skip(lineKey(l))
                      setAnswers((a) => {
                        const n = { ...a }
                        delete n[l.id]
                        return n
                      })
                      return
                    }
                    setAnswers((a) => ({ ...a, [l.id]: c }))
                    setProblems((p) => {
                      const n = { ...p }
                      delete n[l.id]
                      return n
                    })
                  }}
                  onSave={() => void save([l])}
                  onCreate={(what, name) => setCreating({ what, name, lineId: l.id })}
                  busy={busy.has(l.id)}
                  problem={problems[l.id] ?? null}
                />
              ))}
            </section>
          )}
          {view && open.length === 0 && lines.length > 0 && (
            <p className="text-detail text-muted" data-testid="bank-nothing-to-answer">
              {skippedLines.length > 0 ? t('simple.bank.restSkipped') : t('simple.bank.nothingToAnswer')}
            </p>
          )}

          {view && skippedLines.length > 0 && <SkippedLines lines={skippedLines} onBringBack={bringBack} />}

          {view && settled.length > 0 && <DoneLines lines={settled} />}
        </div>
      )}

      {creating && (
        <NewAccountDialog
          name={creating.name}
          context={
            creating.what === 'customer'
              ? { field: 'party', side: 'sales' } // i18n-technical
              : creating.what === 'supplier'
                ? { field: 'party', side: 'purchase' } // i18n-technical
                : creating.what === 'bank'
                  ? BANK_CONTEXT
                  : CONTRA_CONTEXT
          }
          onClose={() => setCreating(null)}
          onCreated={created}
        />
      )}
    </Page>
  )
}
