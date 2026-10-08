// Payables (WP 4.3): payment planning by due date, batch payment vouchers, payment runs, MSME
// tracking (MSMED Act 2006 s.15 / s.16, Income-tax s.43B(h) / 2025 Act s.37(2)(g), MSME Form 1)
// and supplier statements / reconciliation. Each tab renders its own header (with this tab bar)
// so its options drawer stays its own.
import { useState } from 'react'
import { TabBar } from '../components/TabBar'
import { PAYABLES_TABS, type PayablesTab } from './payables/common'
import { PlanTab } from './payables/PlanTab'
import { BatchTab } from './payables/BatchTab'
import { RunsTab } from './payables/RunsTab'
import { MsmeTab } from './payables/MsmeTab'
import { SuppliersTab } from './payables/SuppliersTab'

export function PayablesScreen({ tab: initial = 'plan' }: { tab?: PayablesTab }): React.JSX.Element {
  const [tab, setTab] = useState<PayablesTab>(initial)
  const tabs = <TabBar screen="payables" tabs={PAYABLES_TABS} active={tab} onSelect={setTab} />
  switch (tab) {
    case 'batch':
      return <BatchTab tabs={tabs} />
    case 'runs':
      return <RunsTab tabs={tabs} />
    case 'msme':
      return <MsmeTab tabs={tabs} />
    case 'suppliers':
      return <SuppliersTab tabs={tabs} />
    default:
      return <PlanTab tabs={tabs} />
  }
}
