import { useMemo, useState } from 'react'
import { LANGUAGES, type Language, type MessageKey } from '@shared/i18n'
import { toPlainDate } from '@shared/dates'
import { reminderMessage, reminderSms, whatsappLink, whatsappNumber, type PersonReminder, type PersonView, type ReminderVia } from '@shared/simple/people'
import type { ReminderBucket } from '@shared/receivables/config'
import { api } from '../../lib/client'
import { useT } from '../../lib/i18n'
import { useToasts } from '../../state/stores'
import { Button, Segmented, Textarea } from '../../components/ui'

const STEP_TEXT: Record<ReminderBucket, MessageKey> = {
  gentle: 'simple.people.reminder.step.gentle',
  firm: 'simple.people.reminder.step.firm',
  final: 'simple.people.reminder.step.final'
}
const WHATSAPP: ReminderVia = 'whatsapp' // i18n-technical
const COPIED = 'copied' as const // i18n-technical
const SMS = 'sms' as const // i18n-technical
const LANG_TEXT: Record<Language, MessageKey> = { en: 'simple.people.lang.en', hi: 'simple.people.lang.hi', hinglish: 'simple.people.lang.hinglish' }

/**
 * WP 9.8 — "Send a reminder" on a customer's page: the WP 4.2 reminder letter's facts (the late
 * bills, the gentle / firm / final step by the oldest one's days) as a short message in English,
 * Hindi or Hinglish (the catalogue's text; amounts and dates as money.ts / dates.ts write them).
 * Copy, Open in WhatsApp (a wa.me link the OS browser opens — the app sends nothing itself) and
 * Copy for SMS (the same message without the bill list). Each one is logged as a reminder sent
 * today (reminder_log, like the letter); the "don't remind again within N days" setting is said,
 * not enforced.
 */
export function ReminderPanel({ person, reminder, startLang, onSent }: { person: PersonView; reminder: PersonReminder; startLang: Language; onSent: () => void }): React.JSX.Element {
  const t = useT()
  const lbl = (k: MessageKey): string => t(k) // i18n-technical: keys from the typed tables above
  const toast = useToasts()
  const [lang, setLang] = useState<Language>(startLang)
  const [note, setNote] = useState<string | null>(null)
  const facts = useMemo(() => ({ company: person.company, party: person.name, bucket: reminder.bucket, bills: reminder.bills }), [person, reminder])
  const text = useMemo(() => reminderMessage(facts, lang), [facts, lang])
  const sms = useMemo(() => reminderSms(facts, lang), [facts, lang])
  const number = person.whatsapp ?? person.phone

  const copy = async (value: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      return false
    }
  }
  const logged = async (via: ReminderVia, said: string): Promise<void> => {
    try {
      await api.simplePeople.reminded(person.ledgerId, via, person.today)
      setNote(said)
      onSent()
    } catch (e) {
      toast.push('error', (e as Error).message)
    }
  }
  const onCopy = async (via: 'copied' | 'sms'): Promise<void> => {
    if (!(await copy(via === 'sms' ? sms : text))) {
      setNote(t('simple.people.reminder.noCopy'))
      return
    }
    await logged(via, t('simple.people.reminder.copied'))
  }
  const onWhatsapp = async (): Promise<void> => {
    window.open(whatsappLink(number, text))
    await logged(WHATSAPP, t('simple.people.reminder.opened'))
  }

  return (
    <section className="mt-4 rounded-lg border border-line bg-panel p-panel shadow-elev-1" data-testid="person-reminder" data-bucket={reminder.bucket}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-subtitle font-semibold text-ink">{t('simple.people.reminder.title', { name: person.name })}</h2>
          <p className="mt-0.5 text-detail text-muted">{lbl(STEP_TEXT[reminder.bucket])}</p>
        </div>
        <Segmented
          label={t('simple.people.reminder.language')}
          size="sm"
          testId="reminder-lang"
          options={LANGUAGES.map((l) => ({ value: l, label: lbl(LANG_TEXT[l]) }))}
          value={lang}
          onChange={setLang}
        />
      </div>
      {reminder.lastSent && (
        <p className="mt-2 text-detail text-muted" data-testid="reminder-last">
          {reminder.lastSent === person.today ? (
            t('simple.people.reminder.sentToday')
          ) : (
            <>
              {t('simple.people.reminder.last', { date: toPlainDate(reminder.lastSent) })}
              {!reminder.allowed && reminder.nextAllowed && ` ${t('simple.people.reminder.wait', { date: toPlainDate(reminder.nextAllowed) })}`}
            </>
          )}
        </p>
      )}
      <Textarea className="mt-3 font-sans" rows={11} readOnly value={text} data-testid="reminder-text" aria-label={t('simple.people.reminder.title', { name: person.name })} />
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" data-testid="btn-reminder-whatsapp" onClick={() => void onWhatsapp()}>
          {t('simple.people.reminder.whatsapp')}
        </Button>
        <Button data-testid="btn-reminder-copy" onClick={() => void onCopy(COPIED)}>
          {t('simple.people.reminder.copy')}
        </Button>
        <Button data-testid="btn-reminder-sms" onClick={() => void onCopy(SMS)}>
          {t('simple.people.reminder.sms')}
        </Button>
      </div>
      {!whatsappNumber(number) && <p className="mt-2 text-detail text-muted" data-testid="reminder-no-phone">{t('simple.people.reminder.noPhone')}</p>}
      {note && (
        <p className="mt-2 text-detail text-ink" role="status" data-testid="reminder-note">
          {note}
        </p>
      )}
    </section>
  )
}
