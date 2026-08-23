// Scenario 15 — the assistant drawer, driven the way a user drives it: bootstrap an owner, turn
// the feature on in Settings, open the drawer with the keyboard, and ask a question against a
// local fake endpoint.
//
// The assertion that matters is the sources block: it is rendered from the tool results, not
// from the model's prose, so a figure the model invented would have nothing underneath it.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import { startFakeOpenAi } from '../lib/fake-openai.mjs'

await scenario('15-ai-drawer', async (h) => {
  const fake = await startFakeOpenAi()
  try {
    await h.createDemoCompany()

    // The first user of a company is always the owner, and creating them signs them in — which
    // is what unlocks the owner-gated Features and AI panels below.
    await h.goto('settings')
    await h.page.click('[data-testid="tab-settings-users"]')
    await h.click('btn-users-add')
    await h.page.fill('[data-testid="input-user-name"]', 'Priya Owner')
    const pins = await h.page.$$('input[type="password"]')
    await pins[0].fill('1234')
    await pins[1].fill('1234')
    await h.click('btn-users-save')
    await h.page.waitForSelector('[data-testid="btn-users-add"]', { timeout: 15000 })

    // Point the assistant at the local fake endpoint and turn the feature on.
    await h.invoke('ai:setConfig', {
      baseUrl: fake.url,
      model: 'fake-small',
      apiKey: 'sk-test-not-real',
      consentedHost: new URL(fake.url).host
    })
    await h.page.click('[data-testid="tab-settings-features"]')
    await h.page.click('[data-testid="toggle-feature-ai"]')
    // The toggle only stages a draft; Features has an explicit Save, and saving is what
    // invalidates the shared ['features'] query the Shell reads.
    await h.click('btn-features-save')
    await h.page.waitForFunction(
      () => document.querySelector('[data-testid="btn-features-save"]')?.disabled === true,
      null,
      { timeout: 15000 }
    )

    // Cmd/Ctrl-J from anywhere.
    await h.page.keyboard.press('Escape')
    await h.page.keyboard.press('g')
    await h.waitScreen('gateway', 20000)
    assertEq((await h.invoke('config:features:get')).ai, true, 'the feature really persisted')

    await h.page.keyboard.press('Control+j')
    await h.page.waitForSelector('[data-testid="ask-drawer"]', { timeout: 15000 })
    await h.shot('01-drawer-open')

    fake.push({ kind: 'tool', calls: [{ name: 'trial_balance', args: {} }] })
    fake.push({ kind: 'text', text: 'Cash stands at 50,000.00 [tb:1].' })

    await h.page.fill('[data-testid="input-ask"]', 'how much cash do I have?')
    await h.page.keyboard.press('Enter')
    await h.page.waitForSelector('[data-testid="btn-toggle-sources"]', { timeout: 25000 })

    const answered = await h.page.textContent('[data-testid="ask-drawer"]')
    assert(answered.includes('50,000.00'), `the drawer rendered the answer (${answered.slice(0, 120)})`)

    await h.page.click('[data-testid="btn-toggle-sources"]')
    const withSources = await h.page.textContent('[data-testid="ask-drawer"]')
    assert(withSources.includes('trial_balance'), 'the answer shows the tool it read from')
    await h.shot('02-answer-with-sources')

    // Esc closes the drawer once nothing is running.
    await h.page.keyboard.press('Escape')
    await h.page.waitForSelector('[data-testid="ask-drawer"]', { state: 'detached', timeout: 10000 })
    assertEq(await h.page.getAttribute('[data-screen]', 'data-screen'), 'gateway', 'Esc closed the drawer, not the screen')
  } finally {
    await fake.close()
  }
})
