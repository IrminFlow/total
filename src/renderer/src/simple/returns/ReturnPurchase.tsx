import { ReturnScreen } from './ReturnScreen'

const SIDE = 'purchase' as const // i18n-technical

/** WP 9.5 — Buy → Return a purchase (registry `simple-return-purchase`; `billId` = from a bill's view). */
export function ReturnPurchase({ billId }: { billId?: number }): React.JSX.Element {
  return <ReturnScreen side={SIDE} billId={billId} />
}
