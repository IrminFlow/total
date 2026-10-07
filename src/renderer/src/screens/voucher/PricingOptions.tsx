// WP 2.6 — the "Pricing" section of Voucher entry's (and Counter billing's) Options drawer. Unlike
// the drawer's display preferences these are company settings (meta 'pricing.config'), because
// "remember last price" runs in the main process when a sale is saved.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { DrawerSection } from '../../components/ui'
import { OptionToggle } from '../../components/ScreenOptions'
import { pricingApi } from '../../lib/pricingClient'
import { useToasts } from '../../state/stores'
import type { PricingConfig } from '@shared/pricingSchemas'

export function PricingOptions({ showAutoApply = true }: { showAutoApply?: boolean }): React.JSX.Element {
  const { data } = useQuery({ queryKey: ['pricingConfig'], queryFn: pricingApi.config })
  const queryClient = useQueryClient()
  const toast = useToasts()
  const set = async (patch: Partial<PricingConfig>): Promise<void> => {
    if (!data) return
    try {
      await pricingApi.setConfig({ ...data, ...patch })
      await queryClient.invalidateQueries({ queryKey: ['pricingConfig'] })
    } catch (err) {
      toast.push('error', (err as Error).message)
    }
  }
  return (
    <DrawerSection title="Pricing">
      {showAutoApply && (
        <OptionToggle
          label="Apply prices automatically"
          hint="Sales lines follow party rates, price levels and schemes as the item, quantity or party changes. A rate you type is always kept."
          checked={data?.autoApply ?? true}
          onChange={(v) => void set({ autoApply: v })}
          testId="input-pricing-auto-apply"
        />
      )}
      <OptionToggle
        label="Remember the last price per customer"
        hint="Saving a sales invoice stores each item's rate as that customer's last price (the walk-in Cash sale party excepted)."
        checked={data?.rememberLastPrice ?? false}
        onChange={(v) => void set({ rememberLastPrice: v })}
        testId="input-pricing-remember-last"
      />
    </DrawerSection>
  )
}
