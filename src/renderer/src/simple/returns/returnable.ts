import { useQuery } from '@tanstack/react-query'
import type { ReturnSide } from '@shared/simple/returns'
import { api } from '../../lib/client'
import { useSession, type Screen } from '../../state/stores'

/** WP 9.5: where a bill view's "Return items" goes — the return screen of its side, on that bill. */
export const returnScreen = (side: ReturnSide, billId: number): Screen =>
  side === 'sale' ? { name: 'simple-return-sale', billId } : { name: 'simple-return-purchase', billId } // i18n-technical

/** WP 9.5: is anything on this bill still returnable? (simple:returns:bill — the same reading the
 *  return is mapped from). `undefined` while loading — the button shows then, as before. */
export function useReturnable(side: ReturnSide, billId: number): boolean | undefined {
  const workingDate = useSession((s) => s.workingDate)
  const { data } = useQuery({
    queryKey: ['simpleReturnBill', side, billId, workingDate], // i18n-technical
    queryFn: () => api.simple.returnBill(side, billId, workingDate)
  })
  if (data === undefined) return undefined
  if (data === null) return false
  return data.mode === 'items' ? data.lines.some((l) => l.leftMilli > 0) : data.amountLeft == null || data.amountLeft > 0
}
