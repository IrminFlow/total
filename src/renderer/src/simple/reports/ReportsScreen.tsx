import { BusinessDoing } from './BusinessDoing'
import { CashNext30 } from './CashNext30'
import { WhoOwes } from './WhoOwes'
import { ByMonth } from './ByMonth'

/**
 * WP 9.9 — the simple Reports (plan §2.2): one plain report per entry of the Reports section
 * (the section page is the hub, with the "For your CA" group of accountant screens). Every figure
 * comes from simple:reports:* — the accountant reports' own services.
 */
export function ReportsScreen({ report, side }: { report?: 'doing' | 'cash' | 'owed' | 'by-month'; side?: 'receivable' | 'payable' }): React.JSX.Element {
  switch (report) {
    case 'cash':
      return <CashNext30 />
    case 'owed':
      return <WhoOwes side={side} />
    case 'by-month':
      return <ByMonth />
    default:
      return <BusinessDoing />
  }
}
