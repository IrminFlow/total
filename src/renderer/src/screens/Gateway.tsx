import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useNav, useSession, type Screen } from '../state/stores'
import { Money, Panel } from '../components/ui'
import { toDisplayDate, todayISO } from '@shared/dates'
import { useFeatures } from '../lib/useFeatures'
import type { CompanyFeatures } from '@shared/features'

const CARDS: { label: string; sub: string; screen: Screen; key: string; feature?: keyof CompanyFeatures }[] = [
  { label: 'Voucher entry', sub: 'Sales, purchase, payment…', screen: { name: 'voucher-entry' }, key: 'V' },
  { label: 'Day book', sub: 'Every entry, in order', screen: { name: 'daybook' }, key: 'D' },
  { label: 'Masters', sub: 'Ledgers, items, groups', screen: { name: 'masters' }, key: 'M' },
  { label: 'Trial balance', sub: 'All closing balances', screen: { name: 'trial-balance' }, key: 'T' },
  { label: 'Profit & Loss', sub: 'Trading + P&L account', screen: { name: 'profit-loss' }, key: 'P' },
  { label: 'Balance sheet', sub: 'Assets and liabilities', screen: { name: 'balance-sheet' }, key: 'B' },
  { label: 'Stock summary', sub: 'Quantities and value', screen: { name: 'stock-summary' }, key: 'S', feature: 'inventory' },
  { label: 'GSTR-1', sub: 'Outward supplies return', screen: { name: 'gstr1' }, key: '1' },
  { label: 'GSTR-3B', sub: 'Summary return + ITC', screen: { name: 'gstr3b' }, key: '3' }
]

export function Gateway(): React.JSX.Element {
  const nav = useNav()
  const { from } = useSession()
  const today = todayISO()
  const features = useFeatures()
  const cards = useMemo(() => CARDS.filter((c) => !c.feature || features[c.feature]), [features])
  const { data } = useQuery({
    queryKey: ['dashboard', today, from],
    queryFn: () => api.reports.dashboard(today, from)
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return
      const card = cards.find((c) => c.key.toLowerCase() === e.key.toLowerCase())
      if (card) nav.go(card.screen)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nav, cards])

  const tiles = [
    { label: 'Cash in hand', value: data?.cashBalance ?? 0 },
    { label: 'Bank balance', value: data?.bankBalance ?? 0 },
    { label: 'Receivables', value: data?.receivables ?? 0 },
    { label: 'Payables', value: data?.payables ?? 0 },
    { label: 'Sales this month', value: data?.monthSales ?? 0 },
    { label: 'GST payable', value: data?.gstPayable ?? 0 }
  ]

  return (
    <div className="mx-auto max-w-5xl">
      <div className="grid grid-cols-3 gap-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <Panel key={t.label} className="px-4 py-3">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">{t.label}</p>
            <p className="num mt-1.5 text-[16px] font-medium">
              <Money paise={t.value} />
            </p>
          </Panel>
        ))}
      </div>

      <div className="mt-6 grid grid-cols-3 gap-3">
        {cards.map((c) => (
          <button
            key={c.label}
            onClick={() => nav.go(c.screen)}
            className="group rounded-lg border border-line bg-panel px-5 py-4 text-left transition-colors hover:border-amber/50"
          >
            <div className="flex items-center justify-between">
              <span className="text-[14.5px] font-medium">{c.label}</span>
              <span className="rounded border border-line px-1.5 text-[10.5px] text-muted group-hover:border-amber/50 group-hover:text-amber">
                {c.key}
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted">{c.sub}</p>
          </button>
        ))}
      </div>

      {data && data.recentVouchers.length > 0 && (
        <Panel className="mt-6">
          <p className="border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            Recent entries
          </p>
          <div>
            {data.recentVouchers.map((v) => (
              <button
                key={v.voucherId}
                className="flex w-full items-center gap-4 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
                onClick={() => nav.go({ name: 'voucher-entry', voucherId: v.voucherId })}
              >
                <span className="num w-20 text-[12px] text-muted">{toDisplayDate(v.date)}</span>
                <span className="w-24 text-[12.5px] text-muted">{v.voucherType}</span>
                <span className="num w-14 text-[12px] text-muted">{v.number}</span>
                <span className="flex-1 truncate text-[13px]">{v.account}</span>
                <Money paise={v.debit} className="text-[13px]" />
              </button>
            ))}
          </div>
        </Panel>
      )}
    </div>
  )
}
