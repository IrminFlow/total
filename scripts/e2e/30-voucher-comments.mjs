// Scenario 30 - append-only operational comments remain separate from voucher narration.
import { scenario, assertEq } from '../lib/harness.mjs'

await scenario('30-voucher-comments', async (h) => {
  await h.createDemoCompany()
  await h.goto('daybook')
  const row = h.page.locator('[data-testid="rows-daybook"] tr[data-row-id]').first()
  const voucherId = Number(await row.getAttribute('data-row-id'))
  await row.click()
  await h.waitScreen('voucher-entry')

  await h.click('btn-voucher-comments')
  await h.fill('input-voucher-comment', 'Confirm delivery evidence before the GST review.')
  await h.click('btn-add-voucher-comment')
  await h.page.getByText('Confirm delivery evidence before the GST review.', { exact: true }).waitFor()
  await h.shot('01-voucher-review-comment')
  await h.click('modal-close')
  await h.page.getByRole('button', { name: 'Comments 1', exact: true }).waitFor()

  const comments = await h.invoke('voucher:comments', { id: voucherId })
  assertEq(comments.length, 1, 'comment persists through the main process')
  assertEq(comments[0].body, 'Confirm delivery evidence before the GST review.', 'comment text is retained exactly')
})
