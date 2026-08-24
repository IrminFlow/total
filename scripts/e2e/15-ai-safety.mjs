// Scenario 15 — AI safety UX: context is explicit and field-removable before any provider call.
// No network request is made; this verifies the local privacy and proposal-only surface.
import { scenario, assert } from '../lib/harness.mjs'

await scenario('15-ai-safety', async (h) => {
  await h.createDemoCompany()

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
  await h.click('btn-ai-context-inspector')
  await h.page.waitForSelector('[data-testid="ai-context-inspector"]')
  const inspector = h.page.locator('[data-testid="ai-context-inspector"]')
  assert(await inspector.locator('input[type="checkbox"]').count() === 7, 'every context field has its own consent control')
  assert((await inspector.innerText()).includes('Only checked fields are sent'), 'inspector states the exact sharing rule')

  await inspector.locator('summary').first().click()
  const companyJson = await inspector.locator('details').first().locator('pre').innerText()
  assert(companyJson.includes('Demo Traders') && companyJson.includes('stateCode'), 'exact field JSON is inspectable before sending')

  await inspector.locator('input[type="checkbox"]').first().uncheck()
  await h.page.waitForFunction(() => document.body.innerText.includes('6 fields'))
  await h.shot('01-context-inspector')

  const proposals = await h.invoke('agent:listProposals')
  assert(proposals.length === 0, 'opening and editing context creates no accounting proposal or write')
})
