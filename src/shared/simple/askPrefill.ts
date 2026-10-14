// WP 10.1: an Ask Total entry request opens its simple flow pre-filled. ONE pure mapping from the
// prefill (shared/assist.ts AssistPrefill — the flow's screen params) onto the flow's own form,
// used by BOTH sides: main (src/main/assist/entry.ts) applies it to the empty form and builds the
// draft's intent with the form's own `*IntentFrom`, and the screen applies it to its blank form —
// so what the flow's Save sends is exactly the draft's intent. Pure.
import type { AssistPrefill } from '../assist'
import { formatQtyMilli } from '../money'
import type { MoneyInForm, MoneyOutForm } from './money'
import type { SellForm, SellLine } from './sell'
import type { BuyForm, BuyLine } from './buy'

type Of<S extends AssistPrefill['screen']> = Extract<AssistPrefill, { screen: S }>

/** "3" for 3000 thousandths, "2.5" for 2500 (the qty box's own text). */
export const qtyTextOf = (qtyMilli: number): string => formatQtyMilli(qtyMilli)

export function moneyOutFromAsk(form: MoneyOutForm, p: Of<'simple-money-out'>): MoneyOutForm {
  return {
    ...form,
    who: p.who,
    supplierId: p.party ?? null,
    payeeId: p.payee ?? null,
    ticks: null,
    ...(p.amount != null ? { amount: p.amount } : {}),
    ...(p.how ? { how: p.how, accountId: null } : {}),
    ...(p.date ? { date: p.date } : {}),
    ...(p.note ? { note: p.note } : {})
  }
}

export function moneyInFromAsk(form: MoneyInForm, p: Of<'simple-money-in'>): MoneyInForm {
  return {
    ...form,
    who: p.who,
    customerId: p.party ?? null,
    ticks: null,
    ...(p.amount != null ? { amount: p.amount } : {}),
    ...(p.how ? { how: p.how, accountId: null } : {}),
    ...(p.date ? { date: p.date } : {}),
    ...(p.note ? { note: p.note } : {})
  }
}

/** A bill: the customer (none = walk-in), one product line or just an amount, Paid how. A price
 *  or an amount the user said is what they charged — GST included where it applies. */
export function sellFromAsk<F extends SellForm>(form: F, p: Of<'simple-sell'>, line: (l: Omit<SellLine, 'key'>) => F['lines'][number]): F {
  const priced = p.rate != null || p.amount != null
  return {
    ...form,
    customerId: p.party ?? null,
    ...(p.date ? { date: p.date } : {}),
    ...(p.how ? { paid: p.how } : {}),
    ...(priced ? { ratesIncludeGst: true } : {}),
    ...(p.itemId != null
      ? { mode: 'items' as const, amount: null, lines: [line({ itemId: p.itemId, qtyText: qtyTextOf(p.qtyMilli ?? 1000), rate: p.rate ?? null, discount: null, auto: p.rate == null })] }
      : p.amount != null
        ? { mode: 'amount' as const, amount: p.amount, lines: [] }
        : {}),
    ...(p.note ? { note: p.note } : {})
  }
}

export function buyFromAsk<F extends BuyForm>(form: F, p: Of<'simple-buy'>, line: (l: Omit<BuyLine, 'key'>) => F['lines'][number]): F {
  const priced = p.rate != null || p.amount != null
  return {
    ...form,
    supplierId: p.party ?? null,
    ...(p.date ? { date: p.date } : {}),
    ...(p.how ? { paid: p.how } : {}),
    ...(priced ? { ratesIncludeGst: true } : {}),
    ...(p.itemId != null
      ? { mode: 'items' as const, amount: null, lines: [line({ itemId: p.itemId, qtyText: qtyTextOf(p.qtyMilli ?? 1000), rate: p.rate ?? null, discount: null })] }
      : p.amount != null
        ? { mode: 'amount' as const, amount: p.amount, lines: [] }
        : {}),
    ...(p.note ? { note: p.note } : {})
  }
}
