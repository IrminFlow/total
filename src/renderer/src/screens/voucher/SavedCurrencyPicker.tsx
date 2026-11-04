import type { Currency } from '@shared/domain'
import { Select, TextInput } from '../../components/ui'

/** Foreign-currency invoicing went in the 1.0 cleanup (#195): this picker shows only when editing
 *  a saved invoice that carries a currency, so it round-trips and its rate can be fixed. It offers
 *  exactly that invoice's own currency and ₹ — never a switch to another foreign currency — and
 *  the saved code is there even when the currency master list no longer has it (or is empty). */
export function SavedCurrencyPicker({ currencies, savedCode, currencyCode, setCurrencyCode, fxRateText, setFxRateText, fxActive }: {
  currencies: readonly Currency[]
  savedCode: string
  currencyCode: string
  setCurrencyCode: (code: string) => void
  fxRateText: string
  setFxRateText: (text: string) => void
  fxActive: boolean
}): React.JSX.Element {
  const symbol = currencies.find((c) => c.code === savedCode)?.symbol
  return (
    <div className="flex items-center gap-2" data-testid="saved-currency-picker">
      <Select value={currencyCode} onChange={(e) => setCurrencyCode(e.target.value)} className="w-28" data-testid="select-invoice-currency">
        <option value="">₹ INR</option>
        <option value={savedCode}>{symbol ? `${symbol} ${savedCode}` : savedCode}</option>
      </Select>
      {currencyCode && (
        <>
          <TextInput
            value={fxRateText}
            onChange={(e) => setFxRateText(e.target.value)}
            placeholder={`₹ per ${currencyCode}`}
            className="num w-28 text-right"
            data-testid="input-invoice-fx-rate"
          />
          {fxActive && <span className="text-caption text-muted">rates in {currencyCode} · books in ₹</span>}
        </>
      )}
    </div>
  )
}
