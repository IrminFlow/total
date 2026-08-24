// Scenario 29 - local daily operating brief with financial position and prioritized work.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('29-morning-digest', async (h) => {
  await h.createDemoCompany()
  await h.click('btn-morning-digest')
  await h.page.getByTestId('morning-digest-metrics').waitFor()

  const body = await h.page.textContent('body')
  for (const label of ['Cash and bank', 'Overdue receivables', 'Overdue payables', 'Book exceptions', 'Deadlines ahead', 'Work due today']) {
    assert(body.includes(label), `morning brief includes ${label}`)
  }
  assert(body.includes('Nothing leaves this device.'), 'brief explains its local-only privacy boundary')
  await h.shot('01-morning-brief')

  await h.page.getByRole('button', { name: /Collect overdue customer balances/ }).click()
  await h.waitScreen('collections')
  assert(true, 'brief action opens the underlying work queue')
})
