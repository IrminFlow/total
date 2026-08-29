import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Bank, CheckCircle, CloudCheck, FileText, LockKey, ShieldCheck, WarningCircle } from '@phosphor-icons/react'
import { api } from '../lib/client'
import { useNav, useSession, useToasts, type Screen } from '../state/stores'
import { Button, Money, Panel, SectionTitle, TextInput } from '../components/ui'
import { confirmDialog } from '../lib/dialogs'
import { toDisplayDate, todayISO } from '@shared/dates'
import type { MonthCloseGate, MonthCloseGateId } from '@shared/monthClose'

function monthBounds(month: string): { from: string; to: string } {
  const [year, monthNumber] = month.split('-').map(Number)
  const last = new Date(Date.UTC(year!, monthNumber!, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

const gateIcons = {
  bank: Bank,
  gst: FileText,
  books: ShieldCheck,
  backup: CloudCheck,
  lock: LockKey
} as const

const destinations: Partial<Record<MonthCloseGateId, Screen>> = {
  bank: { name: 'banking' },
  gst: { name: 'gstr1' },
  books: { name: 'exceptions' },
  backup: { name: 'settings', tab: 'backups' }
}

function GateRow({ gate, onOpen }: { gate: MonthCloseGate; onOpen?: () => void }): React.JSX.Element {
  const Icon = gateIcons[gate.id]
  const clear = gate.status !== 'attention'
  return (
    <div className="group grid min-h-[78px] grid-cols-[36px_1fr_auto] items-center gap-3 border-b border-line px-4 py-3 last:border-0">
      <div className={`grid size-9 place-items-center rounded-full ${clear ? 'bg-dr/10 text-dr' : 'bg-amber/12 text-amber'}`}>
        <Icon size={18} weight="duotone" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-[13.5px] font-semibold">{gate.title}</p>
          {clear ? <CheckCircle size={14} weight="fill" className="text-dr" /> : <WarningCircle size={14} weight="fill" className="text-amber" />}
        </div>
        <p className="mt-0.5 text-[12px] leading-5 text-muted">{gate.detail}</p>
      </div>
      {onOpen && (
        <button onClick={onOpen} className="flex min-h-8 items-center gap-1.5 rounded-md px-2 text-[12px] font-medium text-muted transition-colors hover:bg-panel2 hover:text-ink">
          Review <ArrowRight size={13} />
        </button>
      )}
    </div>
  )
}

export function MonthCloseScreen(): React.JSX.Element {
  const nav = useNav()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const [month, setMonth] = useState(todayISO().slice(0, 7))
  const [working, setWorking] = useState<'backup' | 'lock' | null>(null)
  const period = useMemo(() => monthBounds(month), [month])
  const query = useQuery({
    queryKey: ['monthClose', period.from, period.to],
    queryFn: () => api.monthClose.status(period.from, period.to)
  })
  const status = query.data
  const owner = !user || user.role === 'owner'

  const refresh = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['monthClose'] })
  }
  const backup = async (): Promise<void> => {
    setWorking('backup')
    try {
      await api.backups.run()
      await refresh()
      toast.push('success', 'Verified backup created')
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setWorking(null)
    }
  }
  const lock = async (): Promise<void> => {
    if (!status?.canLock) return
    const confirmed = await confirmDialog({
      title: `Close ${new Date(`${period.from}T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}`,
      message: `Lock books through ${toDisplayDate(period.to)}? Existing entries in this period can no longer be changed unless an owner removes the lock.`,
      confirmLabel: 'Lock month',
      cancelLabel: 'Keep open'
    })
    if (!confirmed) return
    setWorking('lock')
    try {
      await api.company.lockSet(period.to)
      await refresh()
      toast.push('success', `Books locked through ${toDisplayDate(period.to)}`)
    } catch (error) {
      toast.push('error', (error as Error).message)
    } finally {
      setWorking(null)
    }
  }

  const progress = status ? Math.round((status.readyCount / status.totalGates) * 100) : 0
  return (
    <div className="mx-auto max-w-5xl" data-testid="month-close-screen">
      <SectionTitle right={<TextInput aria-label="Month to close" type="month" value={month} max={todayISO().slice(0, 7)} onChange={(event) => setMonth(event.target.value)} className="w-40 num" />}>
        Month close
      </SectionTitle>

      <div className="mb-4 grid gap-3 lg:grid-cols-[1.35fr_0.65fr]">
        <Panel className="relative overflow-hidden !bg-ink px-5 py-5">
          <div className="relative z-[1] text-[var(--t-panel)]">
          <div className="absolute -right-12 -top-16 size-44 rounded-full border border-panel/10" aria-hidden="true" />
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-panel/55">Close readiness</p>
          <div className="mt-2 flex items-end justify-between gap-6">
            <div>
              <p className="font-serif text-[31px] font-semibold tracking-[-0.025em]">
                {status?.readyCount ?? 0}<span className="text-panel/35">/{status?.totalGates ?? 5}</span> gates
              </p>
              <p className="mt-1 text-[12px] text-panel/60">{toDisplayDate(period.from)} — {toDisplayDate(period.to)}</p>
            </div>
            <span className="num text-[24px] font-semibold text-panel/80">{progress}%</span>
          </div>
          <div className="mt-5 h-1.5 overflow-hidden rounded-full bg-panel/15">
            <div className="h-full rounded-full bg-amberbar transition-all duration-500" style={{ width: `${progress}%` }} />
          </div>
          </div>
        </Panel>

        <Panel className="p-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Close controls</p>
          <p className="mt-2 text-[12px] leading-5 text-muted">Take a fresh recovery point, then lock only after every preparation gate is clear.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button data-testid="btn-month-close-backup" onClick={() => void backup()} disabled={working !== null}>{working === 'backup' ? 'Backing up…' : 'Back up now'}</Button>
            <Button data-testid="btn-month-close-lock" variant="primary" onClick={() => void lock()} disabled={!owner || !status?.canLock || working !== null} disabledTitle={!owner ? 'Only an owner can lock a period' : !status?.canLock ? 'Resolve the preparation gates first' : undefined}>
              {status?.lockedThrough && status.lockedThrough >= period.to ? 'Month locked' : working === 'lock' ? 'Locking…' : 'Lock month'}
            </Button>
          </div>
        </Panel>
      </div>

      <Panel>
        {query.isLoading && <div className="px-4 py-10 text-center text-[12px] text-muted">Running close checks…</div>}
        {query.isError && <div className="px-4 py-10 text-center text-[12px] text-cr">{(query.error as Error).message}</div>}
        {status?.gates.map((gate) => {
          const destination = destinations[gate.id]
          return <GateRow key={gate.id} gate={gate} onOpen={destination ? () => nav.go(destination) : undefined} />
        })}
      </Panel>

      {status && (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Metric label="Unreconciled" value={String(status.metrics.unreconciledBankLines)} />
          <Metric label="GST blockers" value={String(status.metrics.gstBlocking)} />
          <Metric label="Book exceptions" value={String(status.metrics.bookExceptions)} />
          <Metric label="Suspense" value={<Money paise={Math.abs(status.metrics.suspenseBalance)} />} />
        </div>
      )}
    </div>
  )
}

function Metric({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return <div className="rounded-md border border-line bg-panel2 px-3 py-2"><p className="text-[10.5px] uppercase tracking-[0.08em] text-muted">{label}</p><p className="mt-1 text-[13px] font-semibold">{value}</p></div>
}
