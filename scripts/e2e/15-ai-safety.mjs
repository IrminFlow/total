// Scenario 15 — AI safety UX: context is explicit and field-removable before any provider call.
// No network request is made; this verifies the local privacy and proposal-only surface.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('15-ai-safety', async (h) => {
  await h.createDemoCompany()
  await h.invoke('device-safety:set', {
    aiCopilot: true,
    mcpAccess: false,
    supportUploads: false,
    telemetry: false,
  })
  await h.page.evaluate(() => {
    const key = 'total:product-flags:v1'
    const current = JSON.parse(localStorage.getItem(key) ?? '{"version":1,"flags":{},"history":[]}')
    current.flags = { ...current.flags, aiCopilot: true }
    localStorage.setItem(key, JSON.stringify(current))
    window.dispatchEvent(new Event('total:device-safety-refresh'))
  })
  await h.page.waitForFunction(async () => {
    const result = await window.total.invoke('device-safety:get')
    return result.ok && result.data.aiCopilot === true
  })

  // See scenario 13: avoid unsigned-test Keychain UI while retaining a reversible encrypted
  // envelope inside this one isolated Electron process.
  await h.app.evaluate(({ safeStorage }) => {
    const key = Buffer.from('total-e2e-ai-envelope')
    safeStorage.isEncryptionAvailable = () => true
    safeStorage.encryptString = (plain) => {
      const bytes = Buffer.from(plain, 'utf8')
      for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length]
      return bytes
    }
    safeStorage.decryptString = (encrypted) => {
      const bytes = Buffer.from(encrypted)
      for (let i = 0; i < bytes.length; i++) bytes[i] ^= key[i % key.length]
      return bytes.toString('utf8')
    }
  })
  await h.invoke('ai:setConfig', {
    enabled: true,
    provider: 'openai',
    apiMode: 'responses',
    model: 'gpt-5-mini',
    baseUrl: null,
    apiKey: 'e2e-not-a-real-key'
  })

  await h.click('btn-copilot')
  await h.page.waitForSelector('[data-modal="Total copilot"]')
  const contextToggle = h.page.getByLabel('Share selected company context for this request')
  assert(!(await contextToggle.isChecked()), 'book context sharing starts off for every request')
  await contextToggle.check()
  await h.page.waitForSelector('[data-testid="ai-context-inspector"]')
  const inspector = h.page.locator('[data-testid="ai-context-inspector"]')
  assert(await inspector.locator('input[type="checkbox"]').count() === 7, 'every context field has its own consent control')
  assert(await inspector.locator('input[type="checkbox"]:checked').count() === 2, 'only company and period are selected by default')
  assert((await inspector.innerText()).includes('Only checked fields are sent'), 'inspector states the exact sharing rule')

  await inspector.locator('summary').first().click()
  const companyJson = await inspector.locator('details').first().locator('pre').innerText()
  assert(companyJson.includes('Demo Traders') && companyJson.includes('stateCode'), 'exact field JSON is inspectable before sending')

  await inspector.locator('input[type="checkbox"]').first().uncheck()
  await h.page.waitForFunction(() => document.body.innerText.includes('1 fields'))
  await h.shot('01-context-inspector')

  const proposals = await h.invoke('agent:listProposals')
  assert(proposals.length === 0, 'opening and editing context creates no accounting proposal or write')
})
