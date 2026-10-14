import { ReturnScreen } from './ReturnScreen'

const SIDE = 'sale' as const // i18n-technical

/** WP 9.5 — Sell → Return a sale (registry `simple-return-sale`; `billId` = from a bill's view). */
export function ReturnSale({ billId }: { billId?: number }): React.JSX.Element {
  return <ReturnScreen side={SIDE} billId={billId} />
}
