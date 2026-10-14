import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import { emptyMoveForm, moveErrors, moveIntentFrom, type MoveField, type MoveForm } from '@shared/simple/money'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useNav, useSession } from '../../state/stores'
import { AmountInput, DateInput, Field, Page, Select, TextInput, useFormErrors } from '../../components/ui'
import { SaveCard } from '../SaveCard'
import { Card, MoneyFooter, MoneyHeader } from './MoneyParts'
import { useMoneyFlow } from './useMoneyFlow'

const CONTRA = 'contra' as const // i18n-technical: voucher kind for the accountant editor
const F = { date: 'date', amount: 'amount', from: 'from', to: 'to' } as const // i18n-technical: form field paths
const T_FROM = 'select-move-from' // i18n-technical: test ids
const T_TO = 'select-move-to' // i18n-technical

const isDirty = (f: MoveForm): boolean => f.amount != null || f.fromId != null || f.toId != null || f.note.trim() !== ''

/**
 * WP 9.4 — Move money (plan §3): from one of your cash / bank accounts to another, how much,
 * when (today by default). A `move_money` intent saved by simple:post (the editor's own entry for
 * money between accounts); "Accountant view" opens that editor.
 */
export function MoveMoney(): React.JSX.Element {
  const t = useT()
  const nav = useNav()
  const workingDate = useSession((s) => s.workingDate)
  const { data: setup } = useQuery({ queryKey: ['simpleMoneySetup'], queryFn: api.simpleMoney.setup }) // i18n-technical
  const accounts = setup?.moneyAccounts ?? []
  const blank = (): MoveForm => emptyMoveForm(workingDate)
  const [form, setForm] = useState<MoveForm>(blank)
  const update = (patch: Partial<MoveForm>): void => setForm((f) => ({ ...f, ...patch }))
  const clientErrors = useMemo(() => moveErrors(form), [form])
  const intent = useMemo(() => moveIntentFrom(form), [form])
  const errors = useFormErrors<MoveField>({ date: form.date, amount: form.amount, from: form.fromId, to: `${form.fromId}|${form.toId}` }, { simple: true, t })
  const flow = useMoneyFlow<MoveField>({ intent, clientErrors, errors, dirty: isDirty(form), onStartNew: () => setForm(blank()) })

  const accountantView = (): void => {
    if (flow.savedIds) nav.go({ name: 'voucher-entry', voucherId: flow.savedIds[0]! }) // i18n-technical
    else nav.go({ name: 'voucher-entry', kindHint: CONTRA }) // i18n-technical
  }
  const pick = (value: number | null, onPick: (id: number | null) => void, testId: string, exclude: number | null): React.JSX.Element => (
    <Select value={value ?? ''} onChange={(e) => onPick(e.target.value ? Number(e.target.value) : null)} data-testid={testId}>
      <option value="">{t('simple.money.movePick')}</option>
      {accounts
        .filter((a) => a.id !== exclude)
        .map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
    </Select>
  )

  return (
    <Page data-testid="simple-move-money">
      <MoneyHeader title={t('simple.money.move.title')} sub={t('simple.money.move.sub')} onAccountant={accountantView} />
      {flow.savedIds ? (
        <SaveCard voucherIds={flow.savedIds} onNew={flow.startNew} onEdit={(id) => nav.go({ name: 'voucher-entry', voucherId: id })} /> // i18n-technical
      ) : (
        <div className="flex flex-col gap-4">
          <Card title={t('simple.money.move.title')} testId="money-move">
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <Field label={t('simple.money.moveFrom')} name={F.from} error={errors.get(F.from)}>
                {pick(form.fromId, (id) => update({ fromId: id }), T_FROM, null)}
              </Field>
              <Field label={t('simple.money.moveTo')} name={F.to} error={errors.get(F.to)}>
                {pick(form.toId, (id) => update({ toId: id }), T_TO, form.fromId)}
              </Field>
              <Field label={t('simple.money.amount')} name={F.amount} error={errors.get(F.amount)}>
                <AmountInput paise={form.amount} onPaise={(p) => update({ amount: p })} testId="input-money-amount" />
              </Field>
              <Field label={t('simple.money.date')} name={F.date} error={errors.get(F.date)}>
                <DateInput value={form.date} context={workingDate} onChange={(d) => update({ date: d })} format={toPlainDate} testId="input-money-date" />
              </Field>
              <Field label={t('simple.money.reference')}>
                <TextInput value={form.reference} placeholder={t('simple.money.referencePlaceholder')} onChange={(e) => update({ reference: e.target.value })} data-testid="input-money-reference" />
              </Field>
              <Field label={t('simple.money.note')}>
                <TextInput value={form.note} placeholder={t('simple.money.notePlaceholder')} onChange={(e) => update({ note: e.target.value })} data-testid="input-money-note" />
              </Field>
            </div>
          </Card>
          <MoneyFooter
            preview={flow.preview}
            previewing={flow.previewing}
            ready={Object.keys(clientErrors).length === 0}
            general={flow.general}
            saving={flow.saving}
            canSave={!!setup}
            dirty={isDirty(form)}
            onSave={() => void flow.save()}
            onStartAgain={() => void flow.askDiscard().then((ok) => ok && flow.startNew())}
          />
        </div>
      )}
    </Page>
  )
}
