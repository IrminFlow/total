import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/client'
import { useT } from '../lib/i18n'
import { useSession, useToasts } from '../state/stores'

/**
 * "Remembered on this computer · Forget" under a passphrase prompt (the screen lock of a business
 * without people): with the key remembered, a restart opens these books without the passphrase,
 * so the prompt offers to forget it. Forget only takes the convenience away (company:forgetRemembered);
 * nothing shows when nothing is remembered.
 */
export function RememberedForget(): React.JSX.Element | null {
  const t = useT()
  const slug = useSession((s) => s.slug)
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ['company-remembered'], queryFn: api.company.remembered })
  if (!slug || !data?.includes(slug)) return null
  const forget = async (): Promise<void> => {
    try {
      await api.company.forgetRemembered(slug)
      toast.push('success', t('simple.passphrase.forgotten'))
    } catch (err) {
      toast.push('error', (err as Error).message) // i18n-technical
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['company-remembered'] })
    }
  }
  return (
    <p className="text-center text-small text-muted" data-testid="lock-remembered">
      {t('simple.passphrase.rememberedBadge')} ·{' '}
      <button type="button" className="underline hover:text-ink focus-visible:outline-2 focus-visible:outline-amber/70" data-testid="btn-lock-forget" onClick={() => void forget()}>
        {t('simple.passphrase.forget')}
      </button>
    </p>
  )
}
