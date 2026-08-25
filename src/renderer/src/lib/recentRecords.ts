import type { SearchHit } from '@shared/search'

export interface RecentRecord extends SearchHit { openedAt: number }

function key(slug: string): string { return `total-recent-records-${slug}` }

export function readRecentRecords(slug: string | null): RecentRecord[] {
  if (!slug) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(key(slug)) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is RecentRecord => {
      if (!item || typeof item !== 'object') return false
      const row = item as Partial<RecentRecord>
      return ['ledger', 'item', 'voucher'].includes(row.kind ?? '') && Number.isInteger(row.id) && typeof row.label === 'string' && typeof row.sub === 'string' && typeof row.openedAt === 'number'
    }).slice(0, 12)
  } catch {
    return []
  }
}

export function rememberRecentRecord(slug: string | null, record: SearchHit, now = Date.now()): RecentRecord[] {
  if (!slug) return []
  const prior = readRecentRecords(slug)
  const existing = prior.find((item) => item.kind === record.kind && item.id === record.id)
  const generic = /^(Voucher|Ledger|Item) #\d+$/.test(record.label)
  const next: RecentRecord = { ...(generic && existing ? existing : record), openedAt: now }
  const list = [next, ...prior.filter((item) => item.kind !== record.kind || item.id !== record.id)].slice(0, 12)
  localStorage.setItem(key(slug), JSON.stringify(list))
  return list
}
