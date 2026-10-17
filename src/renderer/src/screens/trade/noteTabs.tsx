// The tabs shared by the challan / GRN list screens (WP 2.5b lists) and the pending-line reports
// (Pending challans / Pending GRNs): the lists are reached from here, not from the sidebar (the
// accountant sidebar stays 0.10's — accountantSidebar.test.tsx). Tab ids keep the pending report's
// testids (`tab-trade-pending-delivery_note` …).
import { TabBar } from '../../components/TabBar'
import { useNav } from '../../state/stores'

export type NoteTab = 'challans' | 'delivery_note' | 'grns' | 'receipt_note'

const TABS: readonly { id: NoteTab; label: string }[] = [
  { id: 'challans', label: 'Challans' },
  { id: 'delivery_note', label: 'Challans not invoiced' },
  { id: 'grns', label: 'GRNs' },
  { id: 'receipt_note', label: 'GRNs not billed' }
]

const SCREEN_OF = { challans: 'challans', delivery_note: 'pending-challans', grns: 'grns', receipt_note: 'pending-grns' } as const

export function NoteTabs({ active }: { active: NoteTab }): React.JSX.Element {
  const nav = useNav()
  return <TabBar screen="trade-pending" tabs={TABS} active={active} onSelect={(t) => nav.go({ name: SCREEN_OF[t] })} label="Challans and GRNs" />
}
