import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useNav, useSession, useToasts } from '../../state/stores'
import { Button, Checkbox, Panel, SectionTitle, TextInput } from '../../components/ui'
import { MIN_AUDIT_KEEP_DAYS, statutoryRetentionFloor } from '@shared/auditRetention'
import { todayISO, toDisplayDate } from '@shared/dates'
import { ChainBanner, useAuditVerification } from '../audit/ChainBanner'

/**
 * Settings → Audit trail (WP 3.8). The trail itself cannot be turned off and has no edit or
 * delete; this section only shows the chain check and the owner-only retention settings, and
 * links to the edit-log report.
 */
export function AuditSection(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  // A company without users has no roles at all (the main-process gate is open too).
  const isOwner = user == null || user.role === 'owner'
  const verification = useAuditVerification()
  const { data: settings } = useQuery({ queryKey: ['audit', 'settings'], queryFn: api.audit.settings })
  const [years, setYears] = useState('')
  const [busy, setBusy] = useState(false)
  const floor = statutoryRetentionFloor(todayISO())
  const minYears = Math.ceil(MIN_AUDIT_KEEP_DAYS / 365.25)

  const run = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      await queryClient.invalidateQueries({ queryKey: ['audit'] })
      toast.push('success', ok)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const required = settings?.trailRequired ?? true
  const keepYears = settings?.keepDays ? Math.round(settings.keepDays / 365.25) : null

  return (
    <div>
      <SectionTitle>Audit trail</SectionTitle>
      <p className="mb-4 text-body-sm text-muted">
        Every change to the books is recorded with who made it, when, and exactly what changed — the edit log required by the
        Companies (Accounts) Rules 2014, rule 3(1). It cannot be disabled, and no one can edit or delete an entry from the app.
      </p>
      <div className="mb-4">
        <ChainBanner verification={verification.data} busy={verification.isFetching} onVerify={verification.refetch} />
      </div>
      <Panel className="mb-4 px-5 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-semibold text-ink">Edit log report</p>
            <p className="text-hint text-muted">Filter by period, entity, action, user or voucher; export CSV or PDF for your auditor.</p>
          </div>
          <Button variant="primary" data-testid="btn-open-edit-log" onClick={() => nav.go({ name: 'audit-trail' })}>
            Open edit log
          </Button>
        </div>
      </Panel>

      <Panel className="divide-y divide-line" testId="audit-retention">
        <div className="px-5 py-4">
          <Checkbox
            label="Audit trail required (company under the Companies Act)"
            hint={
              <>
                Rule 3(1) requires the trail to be kept; Companies Act s.128(5) keeps books for the current year and the eight before
                it (today: everything from {toDisplayDate(floor)}). While this is on — the default — nothing is ever removed.
              </>
            }
            checked={required}
            disabled={!isOwner || busy}
            testId="input-audit-required"
            onChange={(v) => void run(() => api.audit.setRequired(v), v ? 'Audit trail kept in full' : 'Retention can now be set')}
          />
        </div>
        <div className="px-5 py-4">
          <p className="font-semibold text-ink">Retention</p>
          <p className="text-hint text-muted" data-testid="audit-retention-status">
            {required || !settings?.keepDays
              ? 'Keep every entry forever.'
              : `Entries older than ${keepYears} years are removed when the company opens — never anything from ${toDisplayDate(floor)} on, never migration records, and every removal is itself logged.`}
          </p>
          {!required && isOwner && (
            <div className="mt-3 flex items-end gap-2">
              <div>
                <span className="mb-1 block text-caption font-semibold tracking-[0.08em] text-muted uppercase">Keep (years)</span>
                <TextInput
                  data-testid="input-audit-keep-years"
                  className="w-24"
                  inputMode="numeric"
                  placeholder={String(minYears)}
                  value={years}
                  onChange={(e) => setYears(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                disabled={busy || !/^\d+$/.test(years) || Number(years) < minYears}
                data-testid="btn-audit-keep-save"
                onClick={() => void run(() => api.audit.retentionSet(Math.round(Number(years) * 365.25)), 'Retention saved')}
              >
                Save
              </Button>
              {settings?.keepDays && (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => api.audit.retentionSet(null), 'Keeping every entry')}>
                  Keep forever
                </Button>
              )}
              <span className="text-hint text-muted">minimum {minYears} years</span>
            </div>
          )}
          {!isOwner && <p className="mt-2 text-hint text-muted">Only an owner can change retention.</p>}
        </div>
      </Panel>
    </div>
  )
}
