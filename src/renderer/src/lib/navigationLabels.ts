import type { Screen } from '../state/stores'
import { screenDef } from './screens'

function humanize(value: string): string {
  return value.replaceAll('-', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function navigationLabel(screen: Screen): { title: string; detail: string | null } {
  const title = screenDef(screen.name)?.title ?? humanize(screen.name)
  switch (screen.name) {
    case 'voucher-entry':
      return screen.voucherId
        ? { title: `Voucher #${screen.voucherId}`, detail: 'Voucher entry' }
        : { title: screen.kindHint ? `New ${humanize(screen.kindHint)}` : 'New voucher', detail: 'Voucher entry' }
    case 'ledger-statement':
      return { title: `Ledger #${screen.ledgerId}`, detail: 'Ledger statement' }
    case 'daybook':
      return { title, detail: screen.periodLabel ?? (screen.from && screen.to ? `${screen.from} to ${screen.to}` : null) }
    case 'masters':
      return { title, detail: screen.tab ? humanize(screen.tab) : null }
    case 'settings':
      return { title, detail: screen.tab ? humanize(screen.tab) : null }
    case 'task-inbox':
      return { title: screen.compose ? 'New task' : title, detail: screen.linkType && screen.linkType !== 'none' ? `Linked to ${humanize(screen.linkType)}` : null }
    default:
      return { title, detail: null }
  }
}
