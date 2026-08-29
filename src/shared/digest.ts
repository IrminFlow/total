/**
 * The daily digest: what changed in the books yesterday, for the owner who was not there.
 *
 * The audit log has recorded every one of these events since the app existed and shows them to
 * nobody unless asked. An owner does not go looking; they want the day's changes to arrive as a
 * short paragraph they can read standing up, and to be able to tell at a glance whether it is
 * the ordinary shape of a day or not.
 *
 * Pure: takes audit rows in, returns the digest. The service does the SQL, this decides what a
 * day looked like.
 */

export interface DigestAuditRow {
  entity: string
  entityId: number
  action: string
  /** 'YYYY-MM-DD HH:MM:SS' as SQLite writes it. */
  at: string
  userName: string | null
  beforeJson: string | null
  afterJson: string | null
}

export interface DigestItem {
  /** 'Sales INV-104', 'Ledger: Kumar Traders', … */
  label: string
  /** Paise, when the event had an amount worth naming. */
  amount: number | null
  entityId: number
  entity: string
  userName: string | null
  /** 'HH:MM'. */
  time: string
}

export interface DigestSection {
  key: 'entered' | 'altered' | 'binned' | 'restored' | 'masters' | 'imports' | 'exports' | 'signIns'
  label: string
  count: number
  /** Capped — the digest is a glance, not a register. */
  items: DigestItem[]
}

export interface DailyDigest {
  /** The day covered, 'YYYY-MM-DD'. */
  date: string
  totalEvents: number
  /** Total value of vouchers entered that day, paise. The one number an owner asks for first. */
  enteredValue: number
  sections: DigestSection[]
  people: { userName: string; events: number }[]
  /** Nothing happened. Said plainly rather than shown as eight empty sections. */
  quiet: boolean
}

/** Items shown per section. Beyond this the count still tells the truth. */
export const DIGEST_ITEM_CAP = 12

function parse(json: string | null): Record<string, unknown> | null {
  if (!json) return null
  try {
    const value = JSON.parse(json) as unknown
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
  } catch {
    // A row whose JSON we can't read still counts as an event — it just can't be described.
    return null
  }
}

/** Debit total of a voucher snapshot, paise. Audit snapshots carry the whole voucher. */
function voucherAmount(snapshot: Record<string, unknown> | null): number | null {
  if (!snapshot) return null
  const lines = snapshot.lines
  if (!Array.isArray(lines)) return null
  let total = 0
  for (const line of lines as Record<string, unknown>[]) {
    if (line && line.drCr === 'dr' && typeof line.amount === 'number') total += line.amount
  }
  return total
}

function labelFor(entity: string, snapshot: Record<string, unknown> | null, entityId: number): string {
  const name = snapshot && typeof snapshot.name === 'string' ? snapshot.name : null
  const number = snapshot && typeof snapshot.number === 'string' ? snapshot.number : null
  if (entity === 'voucher') return number ? `Voucher ${number}` : `Voucher #${entityId}`
  if (name) return `${entity}: ${name}`
  return `${entity} #${entityId}`
}

const SECTION_LABELS: Record<DigestSection['key'], string> = {
  entered: 'Entered',
  altered: 'Altered',
  binned: 'Moved to the bin',
  restored: 'Restored from the bin',
  masters: 'Masters changed',
  imports: 'Imports',
  exports: 'Exports',
  signIns: 'Sign-ins'
}

/**
 * Which bucket an audit row belongs in.
 *
 * A voucher and a master are separated deliberately: "three entries and a new supplier" is a
 * normal morning, while "no entries and four suppliers edited" is worth a second look, and a
 * single 'updated 7 records' line hides the difference.
 */
function sectionOf(
  row: DigestAuditRow,
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null
): DigestSection['key'] | null {
  if (row.action === 'login' || row.action === 'login_failed') return 'signIns'
  if (row.action === 'import') return 'imports'
  if (row.action === 'export') return 'exports'
  if (row.entity === 'voucher') {
    if (row.action === 'create') return 'entered'
    if (row.action === 'delete') return 'binned'
    if (row.action === 'update') {
      // A restore is written as an update (services/vouchers.ts restoreVoucher) — the only
      // difference is that the deletion timestamp went away. Worth its own line: something
      // coming BACK out of the bin is a different fact from something being edited, and it is
      // the one an owner would want to ask about.
      const wasDeleted = before?.deletedAt != null
      const isDeleted = after?.deletedAt != null
      return wasDeleted && !isDeleted ? 'restored' : 'altered'
    }
    return null
  }
  if (row.action === 'create' || row.action === 'update' || row.action === 'delete') return 'masters'
  return null
}

/** Build the digest for `date` from that day's audit rows (any order). */
export function buildDigest(date: string, rows: DigestAuditRow[]): DailyDigest {
  const buckets = new Map<DigestSection['key'], DigestItem[]>()
  const counts = new Map<DigestSection['key'], number>()
  const people = new Map<string, number>()
  let enteredValue = 0

  const ordered = rows.slice().sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  for (const row of ordered) {
    const after = parse(row.afterJson)
    const before = parse(row.beforeJson)
    const key = sectionOf(row, before, after)
    if (!key) continue
    const snapshot = after ?? before
    const amount = row.entity === 'voucher' ? voucherAmount(snapshot) : null
    if (key === 'entered' && amount) enteredValue += amount

    counts.set(key, (counts.get(key) ?? 0) + 1)
    const list = buckets.get(key) ?? []
    if (list.length < DIGEST_ITEM_CAP) {
      list.push({
        label:
          key === 'signIns'
            ? `${row.userName ?? 'someone'}${row.action === 'login_failed' ? ' — wrong PIN' : ''}`
            : labelFor(row.entity, snapshot, row.entityId),
        amount,
        entityId: row.entityId,
        entity: row.entity,
        userName: row.userName,
        // SQLite writes 'YYYY-MM-DD HH:MM:SS'; anything else shows as-is rather than being mangled.
        time: row.at.length >= 16 ? row.at.slice(11, 16) : row.at
      })
    }
    buckets.set(key, list)

    const who = row.userName ?? 'Not signed in'
    people.set(who, (people.get(who) ?? 0) + 1)
  }

  const order: DigestSection['key'][] = [
    'entered', 'altered', 'binned', 'restored', 'masters', 'imports', 'exports', 'signIns'
  ]
  const sections = order
    .filter((key) => (counts.get(key) ?? 0) > 0)
    .map((key) => ({
      key,
      label: SECTION_LABELS[key],
      count: counts.get(key) ?? 0,
      items: buckets.get(key) ?? []
    }))

  const totalEvents = sections.reduce((sum, s) => sum + s.count, 0)
  return {
    date,
    totalEvents,
    enteredValue,
    sections,
    people: [...people.entries()]
      .map(([userName, events]) => ({ userName, events }))
      .sort((a, b) => b.events - a.events || a.userName.localeCompare(b.userName)),
    quiet: totalEvents === 0
  }
}

/** One-line summary for a notification or a heading. */
export function digestHeadline(digest: DailyDigest, formatMoney: (paise: number) => string): string {
  if (digest.quiet) return 'Nothing was entered or changed.'
  const entered = digest.sections.find((s) => s.key === 'entered')?.count ?? 0
  const altered = digest.sections.find((s) => s.key === 'altered')?.count ?? 0
  const binned = digest.sections.find((s) => s.key === 'binned')?.count ?? 0
  const parts: string[] = []
  if (entered) parts.push(`${entered} entered (${formatMoney(digest.enteredValue)})`)
  if (altered) parts.push(`${altered} altered`)
  if (binned) parts.push(`${binned} binned`)
  if (parts.length === 0) parts.push(`${digest.totalEvents} changes`)
  return parts.join(' · ')
}
