import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toPlainDate } from '@shared/dates'
import { mapError, type CaughtError } from '@shared/errors'
import type { GstFiledEntry, GstForm } from '@shared/simple/taxes'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useSession, useToasts } from '../../state/stores'
import { Button, DateInput, Field, TextInput } from '../../components/ui'

/**
 * WP 9.9 — step 5, one return: "I've filed" with the acknowledgement number (ARN) and the day it
 * was filed (simple:taxes:filed → meta gstFiled, audited). Errors sit under their field (arn /
 * date); anything else shows above the button. A viewer sees the mark but can't change it.
 */
export function FiledForm({ form, period, periodEnd, today, filed }: { form: GstForm; period: string; periodEnd: string; today: string; filed: GstFiledEntry | null }): React.JSX.Element {
  const t = useT()
  const queryClient = useQueryClient()
  const push = useToasts((s) => s.push)
  const viewer = useSession((s) => s.user?.role === 'viewer')
  const [editing, setEditing] = useState(!filed)
  const [arn, setArn] = useState(filed?.arn ?? '')
  const [date, setDate] = useState(filed?.date ?? (today > periodEnd ? today : ''))
  const [errors, setErrors] = useState<{ arn?: string; date?: string; general?: string }>({})
  const [saving, setSaving] = useState(false)
  const name = form === 'gstr1' ? t('simple.taxes.form.gstr1') : t('simple.taxes.form.gstr3b')

  const save = async (clear: boolean): Promise<void> => {
    setSaving(true)
    setErrors({})
    try {
      await api.simpleTaxes.setFiled(clear ? { period, form, arn: null } : { period, form, arn, ...(date ? { date } : {}) })
      push('success', t('simple.taxes.step5.saved'))
      if (clear) {
        setArn('')
        setEditing(true)
      } else setEditing(false)
      await queryClient.invalidateQueries({ queryKey: ['simpleTaxes'] }) // i18n-technical
    } catch (err) {
      const m = mapError(err as CaughtError, { simple: true, t, fields: ['arn', 'date'] }) // i18n-technical
      setErrors({ arn: m.fields.arn, date: m.fields.date, general: m.general ?? undefined })
    } finally {
      setSaving(false)
    }
  }

  if (filed && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-md border border-success/50 bg-success-soft px-3 py-2" data-testid={`taxes-filed-${form}`} data-arn={filed.arn}>
        <span className="text-detail font-medium text-ink">{name}</span>
        <span className="text-detail text-ink">{t('simple.taxes.step5.filed', { date: toPlainDate(filed.date, t.lang), arn: filed.arn })}</span>
        {!viewer && (
          <span className="ml-auto flex gap-2">
            <Button size="sm" data-testid={`taxes-filed-change-${form}`} onClick={() => setEditing(true)}>
              {t('simple.taxes.step5.change')}
            </Button>
            <Button size="sm" variant="ghost" loading={saving} data-testid={`taxes-filed-remove-${form}`} onClick={() => void save(true)}>
              {t('simple.taxes.step5.remove')}
            </Button>
          </span>
        )}
      </div>
    )
  }
  if (viewer) {
    return (
      <p className="text-detail text-muted" data-testid={`taxes-filed-readonly-${form}`}>
        {name} · {t('simple.taxes.step5.readOnly')}
      </p>
    )
  }
  return (
    <div className="rounded-md border border-line bg-panel2 px-3 py-2" data-testid={`taxes-filed-form-${form}`}>
      <p className="text-detail font-medium text-ink">{name}</p>
      <div className="mt-1 flex flex-wrap items-start gap-3">
        <Field label={t('simple.taxes.gst.arn')} name="arn" error={errors.arn ?? null}>
          <TextInput
            data-testid={`taxes-arn-${form}`}
            value={arn}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setArn(e.target.value)
              if (errors.arn) setErrors((x) => ({ ...x, arn: undefined }))
            }}
          />
        </Field>
        <Field label={t('simple.taxes.step5.date')} name="date" error={errors.date ?? null}>
          <DateInput
            testId={`taxes-filed-date-${form}`}
            allowEmpty
            value={date}
            context={today}
            format={((d: string) => toPlainDate(d, t.lang))}
            onChange={(v) => {
              setDate(v)
              if (errors.date) setErrors((x) => ({ ...x, date: undefined }))
            }}
          />
        </Field>
        <Button className="mt-6" variant="primary" loading={saving} data-testid={`taxes-filed-save-${form}`} onClick={() => void save(false)}>
          {t('simple.taxes.step5.save')}
        </Button>
        {filed && (
          <Button className="mt-6" variant="ghost" onClick={() => setEditing(false)}>
            {t('common.cancel')}
          </Button>
        )}
      </div>
      {errors.general && (
        <p className="mt-1 text-detail text-danger" role="alert">
          {errors.general}
        </p>
      )}
    </div>
  )
}
