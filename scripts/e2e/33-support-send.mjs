// Scenario 33 — the support form sends what it showed, and nothing else (roadmap #345).
//
// A `mailto:` link is not a support channel, so the app posts the report instead. That makes the
// dialog the one place, outside the optional AI and NIC clients, where something about a run
// leaves the machine — and the whole claim is that what leaves is the text the user just read.
//
// The claim is worth testing rather than asserting, because it is the kind that quietly stops
// being true: somebody adds a richer payload in main, the preview keeps showing the old summary,
// and nobody notices. So this stands a recording server on localhost, points the app at it, and
// compares the bytes on the wire against the characters on screen.
import http from 'node:http'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

/** A dependency-free recorder. Answers the way the real /api/feedback route does. */
async function startRecorder() {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      requests.push({ url: req.url, body })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { requests, url: `http://127.0.0.1:${server.address().port}/api/feedback`, close: () => server.close() }
}

const recorder = await startRecorder()
process.env.TOTAL_SUPPORT_URL = recorder.url

try {
  await scenario('33-support-send', async (h) => {
    await h.waitScreen('company-select')

    // A company with a party in it, so there is something nameable that must NOT travel.
    await h.createCompanyUI('Support Test Co')
    const groups = await h.invoke('master:groups:list')
    await h.invoke('master:ledgers:create', {
      name: 'Sharma Confidential Traders',
      groupId: groups.find((g) => g.name === 'Sundry Debtors').id,
      openingBalance: 0, gstin: '27AABCS1429B1ZU', stateCode: '27',
      address: null, taxType: null, gstRate: null, hsn: null
    })

    await h.click('link-support')
    await h.page.waitForSelector('[data-testid="input-support-message"]')

    // Diagnostics are attached by default and shown in full before anything is sent.
    await h.page.waitForSelector('[data-testid="diagnostics-report"]')
    const previewed = await h.page.textContent('[data-testid="diagnostics-report"]')
    assert(previewed.trim().length > 0, 'the diagnostics preview is not empty')
    await h.shot('01-support-dialog')

    // Send is refused until there is something to say — an empty bug report helps nobody.
    assertEq(
      await h.page.getAttribute('[data-testid="btn-support-send"]', 'disabled'),
      '',
      'send is disabled with an empty message'
    )

    await h.fill('input-support-message', 'The trial balance would not print.')
    await h.fill('input-support-email', 'owner@example.com')
    await h.click('btn-support-send')
    await h.page.waitForSelector('[data-testid="support-sent"]', { timeout: 15000 })
    await h.shot('02-sent')

    assertEq(recorder.requests.length, 1, 'exactly one request left the app — not one per keystroke')
    const sent = JSON.parse(recorder.requests[0].body)

    assertEq(sent.message, 'The trial balance would not print.', 'the message is the one typed')
    assertEq(sent.email, 'owner@example.com', 'and the address is the one given')
    assertEq(sent.log, previewed, 'the attached log is character-for-character what the dialog showed')
    assert(/^\d+\.\d+\.\d+$/.test(sent.version), 'the app version rides along')
    assert(sent.platform.includes('Electron'), 'and the platform')

    // The invariant that makes attaching a log safe at all: log() records channel and event names,
    // never IPC payloads. A party name in here would mean that invariant had broken somewhere.
    const wire = recorder.requests[0].body
    assert(!wire.includes('Sharma Confidential'), 'no party name is anywhere in what was sent')
    assert(!wire.includes('27AABCS1429B1ZU'), 'nor a GSTIN')
    assert(!wire.includes('Support Test Co'), 'nor the company name')
  })
} finally {
  recorder.close()
}
