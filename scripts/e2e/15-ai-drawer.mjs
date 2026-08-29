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

    // ---- the citation is a link, not a footnote (roadmap #223) ----
    //
    // The ref came from a tool row, so the screen it opens recomputes the figure from the books.
    // That is the difference between citing and merely quoting: the reader can go and disagree.
    const citation = await h.page.textContent('[data-testid="ai-citation"]')
    assertEq(citation.trim(), 'tb:1', 'the answer rendered its ref as a control')
    await h.page.click('[data-testid="ai-citation"]')
    await h.waitScreen('ledger-statement', 15000)
    assert(
      (await h.page.$('[data-testid="ask-drawer"]')) !== null,
      'following a citation keeps the conversation open beside it'
    )

    // ---- "show me exactly what would be sent" (roadmap #214, #222) ----
    await h.page.click('[data-testid="btn-ai-payload"]')
    await h.page.waitForSelector('[data-testid="ai-payload"]', { timeout: 15000 })
    const payload = await h.page.textContent('[data-testid="ai-payload"]')
    assert(payload.includes('There is no tool that writes'), 'the payload viewer names the absence of a write tool')
    assert(payload.includes('how much cash do I have?'), 'and shows the question that would go with it')
    const redaction = await h.page.textContent('[data-testid="ai-redaction"]')
    assert(redaction.includes('pan') && redaction.includes('ifsc'), 'the redaction preview lists what never leaves')
    // The sample PAN DOES appear here, struck through in the "in your books" column — that is the
    // point of a before-and-after. What must be true is that the "what leaves" side is masked.
    assert(redaction.includes('[redacted]'), 'the worked example shows the fields being dropped')
    assert(redaction.includes('27••••••••••1ZV'), 'and the GSTIN keeping only its non-identifying parts')
    await h.shot('03-payload-viewer')
    await h.page.keyboard.press('Escape')
    await h.page.waitForSelector('[data-testid="ai-payload"]', { state: 'detached', timeout: 10000 })

    // ---- Esc stops a running answer before it closes anything (roadmap #215) ----
    //
    // Losing a half-finished answer to a stray Esc would be worse than an extra keystroke, so the
    // first press cancels and only the second closes.
    fake.push({ kind: 'hang', ms: 20000 })
    await h.page.fill('[data-testid="input-ask"]', 'something slow')
    await h.page.keyboard.press('Enter')
    await h.page.waitForFunction(
      () => [...document.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Stop'),
      null,
      { timeout: 15000 }
    )
    await h.page.keyboard.press('Escape')
    await h.page.waitForFunction(
      () => [...document.querySelectorAll('button')].every((b) => b.textContent?.trim() !== 'Stop'),
      null,
      { timeout: 15000 }
    )
    assert((await h.page.$('[data-testid="ask-drawer"]')) !== null, 'the first Esc stopped the answer, not the drawer')

    // Esc closes the drawer once nothing is running.
    await h.page.keyboard.press('Escape')
    await h.page.waitForSelector('[data-testid="ask-drawer"]', { state: 'detached', timeout: 10000 })
    assertEq(
      await h.page.getAttribute('[data-screen]', 'data-screen'),
      'ledger-statement',
      'Esc closed the drawer, not the screen'
    )

    // ---- the ask bar resolves deterministically first (roadmap #212) ----
    //
    // Most of what people type into a box marked "ask your books" is a report name with a period
    // attached. Routing those through an endpoint would be slower, costlier and less exact than
    // the screen that already answers them — so the palette offers the report, and only an
    // unmatched question offers the assistant.
    await h.page.keyboard.press('Control+k')
    await h.page.waitForSelector('[data-testid="command-palette"]', { timeout: 15000 })
    await h.page.fill('[data-testid="input-palette"]', 'trial balance last month')
    await h.page.waitForFunction(
      () => document.querySelector('[data-testid="command-palette"]')?.textContent?.includes('Trial balance —'),
      null,
      { timeout: 10000 }
    )
    await h.shot('04-ask-bar')
    await h.page.keyboard.press('Enter')
    await h.waitScreen('trial-balance', 15000)

    // A question no report answers is where the assistant comes in — and only there.
    await h.page.keyboard.press('Control+k')
    await h.page.waitForSelector('[data-testid="command-palette"]', { timeout: 15000 })
    await h.page.fill('[data-testid="input-palette"]', 'why is my cash lower than last month')
    await h.page.waitForFunction(
      () => document.querySelector('[data-testid="command-palette"]')?.textContent?.includes('Ask the assistant'),
      null,
      { timeout: 10000 }
    )
    await h.page.keyboard.press('Escape')
  } finally {
    await fake.close()
  }
})
