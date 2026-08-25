import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useSession, useToasts } from '../../state/stores'
import { Button, Panel, Select, SectionTitle } from '../../components/ui'
import { AUDITOR_DURATIONS_HOURS } from '@shared/auditorSession'
import { formatPaise } from '@shared/money'
import { digestHeadline } from '@shared/digest'
import { addDays, todayISO, toDisplayDate } from '@shared/dates'

/**
 * Handing the books to someone for an afternoon, and reading what happened while you were out.
 *
 * Both on one screen because they are the same question from two sides: who saw the books, and
 * what did they do.
 */
export function AuditorSection(): React.JSX.Element {
  return (
    <div>
      <SectionTitle>Auditor and the day&rsquo;s digest</SectionTitle>
      <AuditorMode />
      <Digest />
    </div>
  )
}

function AuditorMode(): React.JSX.Element {
  const toast = useToasts()
  const qc = useQueryClient()
  const { setUser } = useSession()
  // Same reason as ApprovalsSection: the live role, not the one the store happens to remember.
  const { data: user } = useQuery({ queryKey: ['authCurrent'], queryFn: () => api.auth.current() })
  const [hours, setHours] = useState<number>(4)
  const { data } = useQuery({
    queryKey: ['auditorStatus'],
    queryFn: () => api.auditor.status(),
    // The banner counts down, so this has to age. A minute is fine: the session ends on the
    // server's clock, not on this one, so a stale label can be wrong for a moment but nothing
    // can be *permitted* for a moment longer than it was granted.
    refetchInterval: 60_000
  })

  const begin = async (): Promise<void> => {
    try {
      const status = await api.auditor.begin(hours)
      // Beginning signs the owner out, so the renderer's own idea of the session has to follow —
      // the whole point is that the machine is now the auditor's.
      setUser({ id: 0, name: 'Auditor', role: 'viewer', denied: [] })
      void qc.invalidateQueries({ queryKey: ['auditorStatus'] })
      toast.push('success', `Auditor session open — ${status.timeLeft}. It ends by itself.`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  const end = async (): Promise<void> => {
    try {
      await api.auditor.end()
      setUser(null)
      void qc.invalidateQueries({ queryKey: ['auditorStatus'] })
      toast.push('success', 'Auditor session ended. Sign back in.')
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }

  if (data?.active) {
    return (
      <Panel className="p-4" data-testid="auditor-active">
        <p className="text-detail font-medium text-accent">Auditor session is open — {data.timeLeft}.</p>
        <p className="mt-1 max-w-prose text-body-sm text-muted">
          Read, print and export only. Everything this session touches is recorded as
          &ldquo;Auditor&rdquo;{data.grantedBy ? `, let in by ${data.grantedBy}` : ''}. It ends by itself, and
          it does not survive quitting the app.
        </p>
        <Button variant="ghost" className="mt-3" data-testid="btn-auditor-end" onClick={() => void end()}>
          End it now
        </Button>
      </Panel>
    )
  }

  return (
    <Panel className="p-4" data-testid="auditor-idle">
      <p className="text-detail font-medium">Hand the books to an auditor</p>
      <p className="mt-1 max-w-prose text-body-sm text-muted">
        A read-only session that ends by itself. What happens otherwise is that the auditor is given the
        owner&rsquo;s PIN — which is never taken back, and which makes the trail unable to tell the two of you
        apart. Starting one signs you out.
      </p>
      <div className="mt-3 flex items-center gap-3">
        <Select
          data-testid="select-auditor-hours"
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          disabled={user?.role !== 'owner'}
        >
          {AUDITOR_DURATIONS_HOURS.map((h) => (
            <option key={h} value={h}>
              {h} hour{h > 1 ? 's' : ''}
            </option>
          ))}
        </Select>
        <Button
          variant="primary"
          data-testid="btn-auditor-begin"
          disabled={user?.role !== 'owner'}
          onClick={() => void begin()}
        >
          Start an auditor session
        </Button>
      </div>
      {user?.role !== 'owner' && <p className="mt-2 text-hint text-muted">Only the owner can let an auditor in.</p>}
    </Panel>
  )
}

/** What changed on a day, for the owner who was not there (roadmap V #390). */
function Digest(): React.JSX.Element {
  const yesterday = addDays(todayISO(), -1)
  const [date, setDate] = useState(yesterday)
  const { data } = useQuery({ queryKey: ['digest', date], queryFn: () => api.audit.digest(date) })

  return (
    <Panel className="mt-4 p-4" data-testid="daily-digest">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-detail font-medium">What changed on {toDisplayDate(date)}</p>
        <div className="flex items-center gap-2">
          <Button variant="ghost" data-testid="btn-digest-prev" onClick={() => setDate((d) => addDays(d, -1))}>
            ← Day before
          </Button>
          <Button
            variant="ghost"
            data-testid="btn-digest-next"
            disabled={date >= todayISO()}
            onClick={() => setDate((d) => addDays(d, 1))}
          >
            Day after →
          </Button>
        </div>
      </div>

      {!data ? (
        <p className="mt-2 text-body-sm text-muted">Reading the trail…</p>
      ) : (
        <>
          <p className="mt-1 text-body-sm text-muted" data-testid="digest-headline">
            {digestHeadline(data, formatPaise)}
          </p>
          {data.people.length > 0 && (
            <p className="mt-1 text-body-sm text-muted">
              {data.people.map((p) => `${p.userName} (${p.events})`).join(' · ')}
            </p>
          )}
          {data.sections.map((section) => (
            <div key={section.key} className="mt-3">
              <p className="text-body-sm font-medium">
                {section.label} <span className="num text-muted">{section.count}</span>
              </p>
              <ul className="mt-1 flex flex-col gap-0.5 text-body-sm text-muted">
                {section.items.map((item, i) => (
                  <li key={`${section.key}-${item.entity}-${item.entityId}-${i}`}>
                    <span className="num">{item.time}</span> {item.label}
                    {item.amount ? <span className="num text-ink"> {formatPaise(item.amount)}</span> : null}
                    {item.userName ? <span> · {item.userName}</span> : null}
                  </li>
                ))}
                {section.count > section.items.length && (
                  <li className="text-hint">…and {section.count - section.items.length} more</li>
                )}
              </ul>
            </div>
          ))}
        </>
      )}
    </Panel>
  )
}
