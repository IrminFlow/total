// Scenario 13 — NIC credential masking (ported from the retired drive6.mjs check): the saved
// password AND clientSecret never come back to the renderer (both halves of the NIC auth
// credential pair — v0.3 review F3), and re-saving the masked sentinels keeps the real values
// (configured stays true) instead of clobbering them.
//
// WP 3.5 — Settings → NIC "Connection test" against the fake NIC sandbox
// (src/main/services/nicFake.testutil.ts — loaded here through Node's TypeScript type stripping,
// Node >= 22.18), served on 127.0.0.1 so the BUILT app's real client, real fetch and real crypto
// do the auth handshake: success, a mapped error (wrong password → NIC 1019), the experimental
// label + spec-only note, and still no secret anywhere in the DOM.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const { createFakeNic } = await import(path.join(here, '../../src/main/services/nicFake.testutil.ts'))

/** Serve a fake NIC over HTTP on an ephemeral 127.0.0.1 port. */
async function serveFake(fake) {
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined
        const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)]))
        const r = await fake.fetch(`http://127.0.0.1${req.url}`, { method: req.method, headers, body })
        let payload
        try { payload = JSON.stringify(await r.json()) } catch { payload = '<html>Bad gateway</html>' }
        res.writeHead(r.status, { 'Content-Type': 'application/json' })
        res.end(payload)
      } catch (e) {
        res.writeHead(500)
        res.end(String(e))
      }
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, url: `http://127.0.0.1:${server.address().port}` }
}

/** Every file under `dir` (recursive), as raw bytes joined — for "is this string on disk?" checks. */
function readTree(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(readTree(p))
    else out.push(fs.readFileSync(p).toString('latin1'))
  }
  return out.join('\n')
}

const CREDS = {
  baseUrlEinvoice: 'https://einv-apisandbox.nic.in',
  baseUrlEwb: '',
  username: 'demo_user',
  password: 'secret123',
  clientId: 'CID',
  clientSecret: 'CSEC',
  publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----'
}

await scenario('13-nic-masking', async (h) => {
  await h.createCompanyUI('NIC Co')

  const st0 = await h.invoke('nic:status')
  assertEq(st0.configured, false, 'fresh company has no NIC credentials')

  const saved = await h.invoke('nic:save', CREDS)
  assertEq(saved.configured, true, 'nic:save reports configured')

  // The renderer NEVER sees the real password or clientSecret.
  const got = await h.invoke('nic:get')
  assertEq(got.username, 'demo_user', 'username rides back in clear')
  assert(got.password !== CREDS.password, 'real password never returned to the renderer')
  assertEq(got.password, '••••••••', 'password comes back as the mask sentinel')
  assert(got.clientSecret !== CREDS.clientSecret, 'real clientSecret never returned to the renderer')
  assertEq(got.clientSecret, '••••••••', 'clientSecret comes back as the mask sentinel')

  // Round-trip the masked values (what the settings form does on save-without-retyping):
  // the stored password/clientSecret must survive, not become the literal dots.
  const resaved = await h.invoke('nic:save', { ...CREDS, password: got.password, clientSecret: got.clientSecret })
  assertEq(resaved.configured, true, 'masked re-save keeps the company configured')
  const got2 = await h.invoke('nic:get')
  assertEq(got2.password, '••••••••', 'still masked after the round-trip')
  assertEq(got2.clientSecret, '••••••••', 'clientSecret still masked after the round-trip')

  // At rest: the secrets live (encrypted) in <dataRoot>/secrets.json, never in the company folder
  // (company.db, its WAL, or backups) — so a company backup carries no NIC secrets.
  const companyFiles = readTree(path.join(h.dataDir, 'companies'))
  assert(!companyFiles.includes(CREDS.password), 'password is not anywhere in the company folder')
  assert(!companyFiles.includes(CREDS.clientSecret), 'clientSecret is not anywhere in the company folder')
  const secretsFile = fs.readFileSync(path.join(h.dataDir, 'secrets.json'), 'utf8')
  assert(!secretsFile.includes(CREDS.password), 'secrets.json holds ciphertext, not the password')

  // And the page itself never contains either secret anywhere.
  await h.goto('edocs')
  const leaked = await h.page.evaluate(
    (secrets) => secrets.some((s) => document.documentElement.outerHTML.includes(s)),
    [CREDS.password, CREDS.clientSecret]
  )
  assert(!leaked, 'neither secret ever appears in the DOM')
  await h.shot('01-edocs')

  // ---------- WP 3.5: connection test against the fake NIC sandbox ----------
  const GSTIN = '27AAPFU0939F1ZV'
  const LIVE = { username: 'api_e2e_user', password: 'E2e#Sandbox-4417', clientId: 'AAACL07TXE2E', clientSecret: 'cs-e2e-Secret-88' }
  const fake = createFakeNic({ ...LIVE, gstins: [GSTIN] })
  const { server, url } = await serveFake(fake)
  try {
    const { info } = await h.invoke('company:current')
    await h.invoke('company:updateInfo', { ...info, gstin: GSTIN, address: '12 MG Road\nPune 411001' })
    await h.invoke('nic:save', { ...CREDS, ...LIVE, baseUrlEinvoice: url, publicKeyPem: fake.publicKeyPem })

    // IPC: the handshake only — one auth call, the published header set, nothing filed.
    const r = await h.invoke('nic:testConnection')
    assertEq(r.ok, true, 'connection test succeeds against the fake sandbox')
    assertEq(r.endpoint, url, 'reports the endpoint it reached')
    assert(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(r.tokenExpiry), `reports the token expiry (${r.tokenExpiry})`)
    assertEq(fake.calls.length, 1, 'exactly one request — the auth handshake')
    assertEq(fake.calls[0].path, '/eivital/v1.04/auth', 'it is the v1.04 auth call')
    assertEq(fake.calls[0].headers.client_id, LIVE.clientId, 'client_id header sent')
    assertEq(fake.calls[0].headers.gstin, GSTIN, 'Gstin header sent')
    assert(!fake.calls[0].body.includes(LIVE.password), 'the password travels RSA-encrypted, never in clear')
    assertEq(fake.irns.size, 0, 'nothing was filed')

    // UI: Settings → NIC live filing → Connection test.
    await h.goto('settings')
    await h.click('tab-settings-nic')
    await h.page.waitForSelector('[data-testid="nic-test-connection"]', { timeout: 15000 })
    const note = await h.page.textContent('[data-testid="nic-spec-note"]')
    assert(/published API spec only \(7 Oct 2026\).*not yet verified on the NIC sandbox/.test(note ?? ''), `spec-only note shown (${note})`)
    assert((await h.page.textContent('body')).includes('Experimental'), 'the experimental label stays')
    await h.click('nic-test-connection')
    await h.page.waitForSelector('[data-testid="nic-connection-result"][data-ok="true"]', { timeout: 20000 })
    const okText = await h.page.textContent('[data-testid="nic-connection-result"]')
    assert(okText.includes(`Connected to ${url}`) && okText.includes('Nothing was filed'), `success reported (${okText})`)
    await h.shot('02-nic-connection-ok')

    // A wrong password comes back as the mapped NIC error, in the UI and over IPC.
    await h.invoke('nic:save', { ...CREDS, ...LIVE, password: 'not-the-password', baseUrlEinvoice: url, publicKeyPem: fake.publicKeyPem })
    let ipcError = ''
    try { await h.invoke('nic:testConnection') } catch (e) { ipcError = String(e.message ?? e) }
    assert(/NIC rejected the API password \(NIC 1019/.test(ipcError), `IPC error mapped (${ipcError})`)
    await h.click('nic-test-connection')
    await h.page.waitForSelector('[data-testid="nic-connection-result"][data-ok="false"]', { timeout: 20000 })
    const errText = await h.page.textContent('[data-testid="nic-connection-result"]')
    assert(/NIC rejected the API password \(NIC 1019: Incorrect Password\)/.test(errText), `failure reported (${errText})`)
    await h.shot('03-nic-connection-error')

    const leaked2 = await h.page.evaluate(
      (secrets) => secrets.some((s) => document.documentElement.outerHTML.includes(s)),
      [LIVE.password, LIVE.clientSecret, 'not-the-password']
    )
    assert(!leaked2, 'no secret in the DOM after the connection tests')
    assertEq(fake.irns.size, 0, 'still nothing filed')
  } finally {
    server.close()
  }
})
