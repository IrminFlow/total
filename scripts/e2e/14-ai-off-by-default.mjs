// Scenario 14 — the assistant is off until asked for, its key never reaches the renderer or the
// disk, and turning it on works against a local endpoint.
//
// The key-on-disk walk is the assertion the old plaintext-credential layout could never make,
// and it is the reason the key lives in the OS keychain rather than the company database.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import { startFakeOpenAi } from '../lib/fake-openai.mjs'

const KEY = 'sk-test-DO-NOT-LEAK-1234567890'

await scenario('14-ai-off-by-default', async (h) => {
  const fake = await startFakeOpenAi()
  try {
    await h.createDemoCompany()

    // ---- off by default ----
    const features = await h.invoke('config:features:get')
    assertEq(features.ai, false, 'a fresh company has the assistant off')

    const drawerBefore = await h.page.$('[data-testid="ask-drawer"]')
    assert(drawerBefore === null, 'no drawer is rendered while the assistant is off')

    // Even with a key configured, the feature flag is the outer gate.
    await h.invoke('ai:setConfig', {
      baseUrl: fake.url,
      model: 'fake-small',
      apiKey: KEY,
      consentedHost: new URL(fake.url).host
    })
    let refused = null
    try {
      await h.invoke('ai:chat', { question: 'anything' })
    } catch (err) {
      refused = String(err)
    }
    assert(refused !== null && /off for this company/.test(refused), `ai:chat refused while the flag is off (${refused})`)

    // ---- the key never comes back ----
    const config = await h.invoke('ai:getConfig')
    assert(config.apiKey !== KEY, 'the real key never returns to the renderer')
    assertEq(config.apiKey, '••••••••', 'the key comes back as the mask sentinel')
    assert(!('apiKeyEnc' in config), 'no encrypted blob in the renderer payload either')

    const inDom = await h.page.evaluate((k) => document.documentElement.outerHTML.includes(k), KEY)
    assert(!inDom, 'the key never appears in the DOM')

    // ---- and never touches the data directory ----
    const walk = (dir) =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(dir, e.name)
        return e.isDirectory() ? walk(full) : [full]
      })
    const files = walk(h.dataDir)
    assert(files.length > 0, `data dir has files to scan (${files.length})`)
    for (const file of files) {
      assert(!fs.readFileSync(file).includes(KEY), `the key leaked into ${path.relative(h.dataDir, file)}`)
    }

    // ---- turn it on, and it works ----
    // Settings -> Features is owner-gated and this scenario has no signed-in user, so the flag
    // is set through IPC and the company reopened. Reopening is what a real user gets after the
    // in-app toggle anyway (FeaturesSection invalidates the features query), and it doubles as
    // the check that the setting persists.
    await h.invoke('config:features:set', { ...features, ai: true })
    await h.clickText('Switch company')
    await h.waitScreen('company-select', 20000)
    await h.clickText('Demo Traders')
    await h.waitScreen('gateway', 30000)
    fake.push({ kind: 'text', text: 'Your cash balance is 50,000.00 [tb:1].' })

    const { runId } = await h.invoke('ai:chat', { question: 'what is my cash balance?' })
    assert(typeof runId === 'string' && runId.length > 0, 'ai:chat returns a runId immediately')

    // The frames stream on the one-way channel; wait for the run to finish.
    const finish = await h.page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const seen = []
          const off = window.total.on('ai:stream', (f) => {
            if (f.runId !== id) return
            seen.push(f)
            if (f.t === 'done') {
              off()
              resolve({ finish: f.finish, text: seen.filter((x) => x.t === 'delta').map((x) => x.text).join('') })
            }
          })
          setTimeout(() => {
            off()
            resolve({ finish: 'timeout', text: '' })
          }, 15000)
        }),
      runId
    )
    assertEq(finish.finish, 'stop', 'the run completed')
    assert(finish.text.includes('50,000.00'), `the answer streamed through (${finish.text})`)

    await h.shot('01-ai-answered')

    // The drawer UI itself is covered by scenario 15, which needs a signed-in owner so the
    // in-app feature toggle is enabled.
  } finally {
    await fake.close()
  }
})
