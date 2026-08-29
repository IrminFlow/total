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

/** Every file under a directory, recursively — the key hunt walks the whole data dir. */
const walk = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name)
    return e.isDirectory() ? walk(full) : [full]
  })

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

    // Subscribe BEFORE asking. `ai:chat` returns a runId immediately and the frames follow on a
    // one-way channel — attaching the listener afterwards is a subscribe-after-fire race that
    // loses the `done` frame whenever the run finishes quickly, which is most of the time.
    await h.page.evaluate(() => {
      window.__aiFrames = []
      window.__aiOff = window.total.on('ai:stream', (f) => window.__aiFrames.push(f))
    })

    const { runId } = await h.invoke('ai:chat', { question: 'what is my cash balance?' })
    assert(typeof runId === 'string' && runId.length > 0, 'ai:chat returns a runId immediately')

    const finish = await h.page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const settle = () => {
            const mine = window.__aiFrames.filter((f) => f.runId === id)
            const done = mine.find((f) => f.t === 'done')
            if (!done) return false
            window.__aiOff()
            resolve({
              finish: done.finish,
              text: mine.filter((x) => x.t === 'delta').map((x) => x.text).join('')
            })
            return true
          }
          if (settle()) return
          const poll = setInterval(() => {
            if (settle()) clearInterval(poll)
          }, 50)
          setTimeout(() => {
            clearInterval(poll)
            window.__aiOff()
            resolve({ finish: 'timeout', text: '' })
          }, 15000)
        }),
      runId
    )
    assertEq(finish.finish, 'stop', 'the run completed')
    assert(finish.text.includes('50,000.00'), `the answer streamed through (${finish.text})`)

    await h.shot('01-ai-answered')

    // ---- the audit trail records the question, and never the key ----
    //
    // The trail lives in the company database, which is what lets it join a question to the
    // voucher a human eventually saved. That makes it exactly the file the key must not be in.
    const runs = await h.invoke('ai:log', { limit: 5 })
    assert(runs.length > 0, 'the run was recorded in the assistant audit trail')
    assertEq(runs[0].question, 'what is my cash balance?', 'the trail holds the question that was asked')
    assertEq(runs[0].voucherId, null, 'nothing was posted, so nothing is linked')
    assert(!JSON.stringify(runs).includes(KEY), 'the key is not in the audit trail')

    // ---- the payload viewer works without contacting anything ----
    const preview = await h.invoke('ai:preview', { question: 'who owes me?' })
    assert(preview.payload.messages[0].role === 'system', 'the preview leads with the system prompt')
    assert(
      preview.payload.tools.length > 0 && !preview.payload.tools.includes('post_voucher'),
      'the tool list the user can read has no tool that writes'
    )
    assert(!JSON.stringify(preview).includes(KEY), 'the payload viewer never shows the key')
    assert(
      preview.redaction.withheld.some((f) => f.field === 'pan'),
      'the redaction preview shows PAN being withheld'
    )
    const gstinRow = preview.redaction.withheld.find((f) => f.field === 'gstin')
    assert(gstinRow && !gstinRow.after.includes('AAPFU0939F'), 'the GSTIN loses its embedded PAN')

    // ---- the spend cap is enforced in main, before anything is sent ----
    //
    // Set against a REMOTE host: a local endpoint costs nothing and is never capped, which is the
    // configuration the rest of this scenario runs in.
    const sentBefore = fake.requests.length
    await h.invoke('ai:setConfig', {
      baseUrl: 'https://api.example.invalid/v1',
      model: 'gpt-4o-mini',
      apiKey: '••••••••',
      sessionCapPaise: 0,
      consentedHost: 'api.example.invalid'
    })
    await h.page.evaluate(() => {
      window.__capFrames = []
      window.__capOff = window.total.on('ai:stream', (f) => window.__capFrames.push(f))
    })
    const capped = await h.invoke('ai:chat', { question: 'anything at all' })
    const capFinish = await h.page.evaluate(
      (id) =>
        new Promise((resolve) => {
          const settle = () => {
            const mine = window.__capFrames.filter((f) => f.runId === id)
            const done = mine.find((f) => f.t === 'done')
            if (!done) return false
            window.__capOff()
            resolve({ finish: done.finish, error: mine.find((f) => f.t === 'error')?.kind ?? null })
            return true
          }
          if (settle()) return
          const poll = setInterval(() => {
            if (settle()) clearInterval(poll)
          }, 50)
          setTimeout(() => {
            clearInterval(poll)
            window.__capOff()
            resolve({ finish: 'timeout', error: null })
          }, 15000)
        }),
      capped.runId
    )
    assertEq(capFinish.finish, 'cap', 'a run over the spend cap ends as capped')
    assertEq(capFinish.error, 'cap', 'and says why')
    assertEq(fake.requests.length, sentBefore, 'nothing was sent: the cap is checked before the request')

    // ---- and the key still is not anywhere on disk, after all of that ----
    for (const file of walk(h.dataDir)) {
      assert(!fs.readFileSync(file).includes(KEY), `the key leaked into ${path.relative(h.dataDir, file)}`)
    }

    // The drawer UI itself is covered by scenario 15, which needs a signed-in owner so the
    // in-app feature toggle is enabled.
  } finally {
    await fake.close()
  }
})
