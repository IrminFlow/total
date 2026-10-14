import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { MessageKey } from '@shared/i18n'
import { formatPaise } from '@shared/money'
import { toPlainDate } from '@shared/dates'
import { balanceWords, billTiming, parseCreditDays, personErrors, type PersonBill, type PersonView as PersonData } from '@shared/simple/people'
import { api } from '../../lib/client'
import { receivablesApi } from '../../lib/receivablesClient'
import { openLedgerEdit } from '../../lib/drill'
import { useLanguage, useT } from '../../lib/i18n'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, Field, Page, TextInput, useFormErrors } from '../../components/ui'
import { DataTable, defineColumns } from '../../components/table'
import { moneyInScreen, moneyOutScreen } from '../money/moneyLinks'
import { Pill } from './Pill'
import { ReminderPanel } from './ReminderPanel'
import { HoldPanel } from './HoldPanel'

type ContactField = 'phone' | 'whatsapp' | 'creditDays'
type Panel = 'reminder' | 'hold'
const F = { phone: 'phone', whatsapp: 'whatsapp', creditDays: 'creditDays' } as const satisfies Record<ContactField, ContactField> // i18n-technical: form field paths
const REMINDER: Panel = 'reminder' // i18n-technical
const HOLD: Panel = 'hold' // i18n-technical
const NO_MAX = 'none' // i18n-technical: DataTable maxHeight
const KIND_TEXT: Record<PersonData['side'], MessageKey> = { customer: 'simple.people.kind.customer', supplier: 'simple.people.kind.supplier' }
const historyScreen = (ledgerId: number): { name: 'ledger-statement'; ledgerId: number } => ({ name: 'ledger-statement', ledgerId }) // i18n-technical
const sellScreen = (party: number): { name: 'simple-sell'; party: number } => ({ name: 'simple-sell', party }) // i18n-technical
const buyScreen = (party: number): { name: 'simple-buy'; party: number } => ({ name: 'simple-buy', party }) // i18n-technical

/**
 * WP 9.8 — one person's page (plan §2 People): where they stand as on today (the Outstandings
 * allocation, simple:people:person) with their open bills oldest first, how late each is in words;
 * phone / WhatsApp / days to pay editable here (saved through the full app's account write,
 * audited); Record money in / out and Make a bill / Record a purchase for them; Statement (the
 * WP 4.2 statement print, saved as a PDF); Send a reminder (ReminderPanel — the reminder letter's
 * facts as a short message to copy, open in WhatsApp or copy for an SMS; each one logged); Put
 * on hold (the owner only, customers); Edit in the full app; History (their statement screen in
 * the full app).
 */
export function PersonView({ id }: { id: number }): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const workingDate = useSession((s) => s.workingDate)
  const { data: p, isLoading } = useQuery({ queryKey: ['simplePerson', id, workingDate], queryFn: () => api.simplePeople.person(id, workingDate) }) // i18n-technical
  if (isLoading) return <Page data-testid="simple-person">{null}</Page>
  if (!p) {
    return (
      <Page data-testid="simple-person">
        <button type="button" className="mb-3 text-detail text-blue hover:underline" onClick={() => nav.back()}>
          {t('simple.people.back')}
        </button>
        <p className="text-detail text-muted" data-testid="simple-person-missing">{t('simple.people.missing')}</p>
      </Page>
    )
  }
  return <Person p={p} />
}

function Person({ p }: { p: PersonData }): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { from, user } = useSession()
  // The message starts in the user's own language (they can pick another for the customer).
  const [reminderLang] = useLanguage()
  const canEdit = user == null || user.role !== 'viewer' // i18n-technical
  const isOwner = user == null || user.role === 'owner' // i18n-technical
  const money = (x: number): string => formatPaise(x, { symbol: true })
  const name = p.walkIn ? t('simple.sales.cashCustomer') : p.name
  const customer = p.side === 'customer' // i18n-technical
  const [panel, setPanel] = useState<Panel | null>(null)
  const toggle = (which: Panel): void => setPanel((cur) => (cur === which ? null : which))
  const reveal = (path: string): Promise<void> => receivablesApi.reveal(path).then(() => undefined, (e: Error) => toast.push('error', e.message)) // i18n-technical
  const [statement, setStatement] = useState<{ path: string } | null>(null)
  const [busy, setBusy] = useState(false)

  // ---------- contact and days to pay ----------
  const [phone, setPhone] = useState(p.phone ?? '')
  const [whatsapp, setWhatsapp] = useState(p.whatsapp ?? '')
  const [days, setDays] = useState(p.creditDays != null ? String(p.creditDays) : '')
  const errors = useFormErrors<ContactField>({ phone, whatsapp, creditDays: days }, { simple: true, t })
  const changed = phone !== (p.phone ?? '') || whatsapp !== (p.whatsapp ?? '') || days !== (p.creditDays != null ? String(p.creditDays) : '')
  const refresh = (): void => {
    for (const k of ['simplePerson', 'simplePeople', 'simpleBillsToPay', 'ledgers']) void queryClient.invalidateQueries({ queryKey: [k] }) // i18n-technical
  }
  const saveContact = async (): Promise<void> => {
    const problems = personErrors({ phone, whatsapp, creditDays: days })
    const keys = Object.entries(problems) as [ContactField, MessageKey][]
    if (keys.length) {
      for (const [f, key] of keys) errors.set(f, lbl(key))
      return
    }
    setBusy(true)
    try {
      await api.simplePeople.update({ id: p.ledgerId, phone: phone.trim(), whatsapp: whatsapp.trim(), creditDays: parseCreditDays(days) ?? null })
      toast.push('success', t('simple.people.saved'))
      refresh()
    } catch (e) {
      const mapped = errors.apply(e)
      if (mapped.general) toast.push('error', mapped.general)
    } finally {
      setBusy(false)
    }
  }

  // ---------- statement ----------
  const makeStatement = async (): Promise<void> => {
    setBusy(true)
    try {
      const to = p.today
      const r = await receivablesApi.statementPdf(p.ledgerId, from <= to ? from : to, to)
      setStatement({ path: r.path })
    } catch (e) {
      toast.push('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const billColumns = useMemo(
    () =>
      defineColumns<PersonBill>([
        { id: 'bill', header: t('simple.people.col.bill'), kind: 'text', width: 110, groupable: false, value: (b) => b.name }, // i18n-technical
        { id: 'date', header: t('simple.people.col.date'), kind: 'date', width: 120, groupable: false, value: (b) => b.date, text: (b) => toPlainDate(b.date) }, // i18n-technical
        { id: 'due', header: t('simple.people.col.due'), kind: 'date', width: 120, groupable: false, value: (b) => b.dueDate ?? b.date, text: (b) => toPlainDate(b.dueDate ?? b.date) }, // i18n-technical
        { id: 'pending', header: t('simple.people.col.pending'), kind: 'money', value: (b) => b.pending, aggregate: 'sum', explainable: false }, // i18n-technical
        {
          id: 'when', header: t('simple.people.col.when'), kind: 'text', groupable: false, filterable: false, // i18n-technical
          value: (b) => billTiming(b, p.today, t),
          cell: (b) => (
            <Pill tone={b.overdueDays > 0 ? 'danger' : 'neutral'} testId="bill-when" data={String(b.overdueDays)}>
              {billTiming(b, p.today, t)}
            </Pill>
          )
        }
      ]),
    [t, p.today]
  )

  return (
    <Page data-testid="simple-person" data-person={p.ledgerId} data-side={p.side}>
      <button type="button" className="mb-3 text-detail text-blue hover:underline" data-testid="btn-person-back" onClick={() => nav.back()}>
        {t('simple.people.back')}
      </button>

      <section className="rounded-lg border border-line bg-panel p-panel shadow-elev-1">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="font-serif text-heading font-semibold tracking-tight text-ink" data-testid="person-name">{name}</h1>
            <p className="mt-1 text-detail text-muted">
              {lbl(KIND_TEXT[p.side])} · {p.creditDays != null ? t('simple.people.terms', { days: p.creditDays }) : t('simple.people.noTerms')}
            </p>
          </div>
          {p.onHold && (
            <Pill tone="amber" testId="person-hold">
              {p.holdReason ? t('simple.people.hold.on', { reason: p.holdReason }) : t('simple.people.chip.hold')}
            </Pill>
          )}
        </div>
        <p className="mt-4 text-lead font-semibold text-ink" data-testid="person-balance" data-open={p.open} data-ahead={p.ahead}>
          {balanceWords(p, t)}
        </p>
        {p.late > 0 && (
          <p className="mt-1 text-body text-danger" data-testid="person-late" data-paise={p.late}>
            {t('simple.people.lateLine', { amount: money(p.late) })}
          </p>
        )}

        <div className="mt-5 flex flex-wrap gap-2">
          {canEdit && customer && (
            <>
              <Button variant="primary" data-testid="btn-person-money-in" onClick={() => nav.go(moneyInScreen({ party: p.ledgerId }))}>
                {t('simple.people.moneyIn')}
              </Button>
              <Button data-testid="btn-person-make-bill" onClick={() => nav.go(sellScreen(p.ledgerId))}>
                {t('simple.people.makeBill')}
              </Button>
            </>
          )}
          {canEdit && !customer && (
            <>
              <Button variant="primary" data-testid="btn-person-money-out" onClick={() => nav.go(moneyOutScreen({ party: p.ledgerId }))}>
                {t('simple.people.moneyOut')}
              </Button>
              <Button data-testid="btn-person-purchase" onClick={() => nav.go(buyScreen(p.ledgerId))}>
                {t('simple.people.recordPurchase')}
              </Button>
            </>
          )}
          {canEdit && customer && p.reminder && (
            <Button data-testid="btn-person-remind" onClick={() => toggle(REMINDER)}>
              {t('simple.people.remind')}
            </Button>
          )}
          {canEdit && (
            <Button data-testid="btn-person-statement" title={t('simple.people.statementHint')} disabled={busy} onClick={() => void makeStatement()}>
              {t('simple.people.statement')}
            </Button>
          )}
          {isOwner && customer && !p.walkIn && (
            <Button data-testid="btn-person-hold" onClick={() => toggle(HOLD)}>
              {p.onHold ? t('simple.people.unhold') : t('simple.people.hold')}
            </Button>
          )}
          <Button variant="ghost" data-testid="btn-person-history" title={t('simple.people.historyHint')} onClick={() => nav.go(historyScreen(p.ledgerId))}>
            {t('simple.people.history')}
          </Button>
          {canEdit && (
            <Button variant="ghost" data-testid="btn-person-edit" onClick={() => openLedgerEdit(p.ledgerId)}>
              {t('simple.people.edit')}
            </Button>
          )}
        </div>
        {statement && (
          <p className="mt-3 text-detail text-ink" data-testid="person-statement-saved">
            {t('simple.people.statementSaved')}{' '}
            <button type="button" className="text-blue hover:underline" data-testid="btn-person-statement-show" onClick={() => void reveal(statement.path)}>
              {t('simple.people.statementShow')}
            </button>
          </p>
        )}
      </section>

      {panel === REMINDER && p.reminder && <ReminderPanel person={p} reminder={p.reminder} startLang={reminderLang} onSent={refresh} />}
      {panel === HOLD && <HoldPanel person={p} onDone={() => { setPanel(null); refresh() }} />}

      <section className="mt-4 rounded-lg border border-line bg-panel shadow-elev-1">
        <h2 className="px-panel pt-panel text-subtitle font-semibold text-ink">{t('simple.people.bills.title')}</h2>
        <DataTable
          testId="person-bills"
          columns={billColumns}
          rows={p.bills}
          rowKey={(b) => `${b.voucherId ?? 0}|${b.name}`}
          rowAttrs={(b) => ({ 'data-bill': b.name, 'data-pending': b.pending, 'data-late': b.overdueDays })}
          toolbar={false}
          maxHeight={NO_MAX}
          empty={{ title: t('simple.people.bills.none') }}
          totalsLabel={t('simple.sales.col.total')}
          trailing={
            canEdit
              ? (b) => (
                  <button
                    type="button"
                    className="text-small font-medium text-blue hover:underline"
                    data-testid={customer ? 'btn-person-bill-paid' : 'btn-person-bill-pay'}
                    onClick={() => nav.go((customer ? moneyInScreen : moneyOutScreen)({ party: p.ledgerId, amount: b.pending, bill: b.name, billId: b.voucherId }))}
                  >
                    {customer ? t('simple.bill.recordPayment') : t('simple.people.pay')}
                  </button>
                )
              : undefined
          }
          trailingWidth={130}
        />
      </section>

      <section className="mt-4 rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="person-contact">
        <h2 className="mb-3 text-subtitle font-semibold text-ink">{t('simple.people.contact')}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label={t('simple.people.phone')} name={F.phone} error={errors.get(F.phone)}>
            <TextInput value={phone} readOnly={!canEdit} inputMode="tel" data-testid="input-person-phone" onChange={(e) => setPhone(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && changed && void saveContact()} />
          </Field>
          <Field label={t('simple.people.whatsapp')} name={F.whatsapp} error={errors.get(F.whatsapp)} hint={t('simple.people.whatsappHint')}>
            <TextInput value={whatsapp} readOnly={!canEdit} inputMode="tel" data-testid="input-person-whatsapp" onChange={(e) => setWhatsapp(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && changed && void saveContact()} />
          </Field>
          <Field label={t('simple.people.creditDays')} name={F.creditDays} error={errors.get(F.creditDays)} hint={t('simple.people.creditDaysHint')}>
            <TextInput value={days} readOnly={!canEdit} inputMode="numeric" data-testid="input-person-days" onChange={(e) => setDays(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && changed && void saveContact()} />
          </Field>
        </div>
        {canEdit && (
          <div className="mt-3">
            <Button variant="primary" data-testid="btn-person-save" disabled={!changed || busy} onClick={() => void saveContact()}>
              {t('simple.people.saveContact')}
            </Button>
          </div>
        )}
      </section>
    </Page>
  )
}
