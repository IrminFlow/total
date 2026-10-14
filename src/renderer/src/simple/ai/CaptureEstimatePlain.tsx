// WP 10.6: the document-capture cost estimate (WP 5.4) in plain words, while the company is in
// simple mode: "About ₹X to read N bills" first; pages, model and tokens behind Details. The same
// estimate (capture:estimate) and the same approval (capture:process with exactly its ids) — only
// the words differ. The accountant dialog in screens/Capture.tsx is unchanged.
import { useQuery } from '@tanstack/react-query'
import type { CaptureEstimate } from '@shared/capture/types'
import { moneyText, rateNote, usdRateOn } from '@shared/simple/aiPlain'
import { todayISO } from '@shared/dates'
import { cfApi } from '../../lib/cashFinanceClient'
import { useT } from '../../lib/i18n'
import { Banner, Button, Modal } from '../../components/ui'

const RATES_KEY = ['fxRates'] // i18n-technical

export function PlainCaptureEstimate({ estimate, onClose, onConfirm }: { estimate: CaptureEstimate; onClose: () => void; onConfirm: () => void }): React.JSX.Element {
  const t = useT()
  const { data: rates } = useQuery({ queryKey: RATES_KEY, queryFn: cfApi.fx.rates })
  const rate = usdRateOn(rates, todayISO())
  const count = estimate.items
  return (
    <Modal title={t('simple.ai.capture.title')} onClose={onClose}>
      <div className="space-y-3 p-4" data-testid="capture-estimate" data-plain="true">
        <p className="text-body font-medium text-ink" data-testid="text-capture-cost">
          {estimate.costMicroUsd == null
            ? t('simple.ai.capture.unpriced', { count })
            : t('simple.ai.capture.cost', { count, cost: moneyText(estimate.costMicroUsd, rate) })}
        </p>
        {estimate.costMicroUsd != null && <p className="text-hint text-muted">{rateNote(rate, t)}</p>}
        <p className="text-small text-muted" data-testid="text-capture-privacy">{estimate.maskIds ? t('simple.ai.capture.hidden') : t('simple.ai.capture.notHidden')}</p>
        {estimate.unmaskable > 0 && (
          <Banner tone="warning" testId="banner-capture-unmaskable">
            {t('simple.ai.capture.photos', { count: estimate.unmaskable })}
          </Banner>
        )}
        {estimate.blocker && <Banner tone="danger">{t('simple.ai.panel.off')}</Banner>}
        <details className="text-hint text-muted" data-testid="capture-estimate-details">
          <summary className="cursor-pointer">{t('common.details')}</summary>
          <p className="num mt-0.5">
            {t('simple.ai.capture.details', {
              pages: estimate.pages,
              model: estimate.model,
              input: estimate.inputTokens.toLocaleString('en-IN'),
              output: estimate.outputTokens.toLocaleString('en-IN')
            })}
          </p>
          {estimate.blocker && <p className="mt-0.5">{estimate.blocker}</p>}
        </details>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button variant="primary" disabled={!!estimate.blocker} data-testid="btn-capture-confirm" onClick={onConfirm}>
            {t('simple.ai.capture.send', { count })}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
