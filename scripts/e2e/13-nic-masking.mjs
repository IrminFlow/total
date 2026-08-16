// Scenario 13 — NIC credential masking (ported from the retired drive6.mjs check): the saved
// password never comes back to the renderer, and re-saving the masked sentinel keeps the real
// password (configured stays true) instead of clobbering it.
import { scenario, assert, assertEq } from '../lib/harness.mjs'

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

  // The renderer NEVER sees the real password.
  const got = await h.invoke('nic:get')
  assertEq(got.username, 'demo_user', 'username rides back in clear')
  assert(got.password !== CREDS.password, 'real password never returned to the renderer')
  assertEq(got.password, '••••••••', 'password comes back as the mask sentinel')

  // Round-trip the masked value (what the settings form does on save-without-retyping):
  // the stored password must survive, not become the literal dots.
  const resaved = await h.invoke('nic:save', { ...CREDS, password: got.password })
  assertEq(resaved.configured, true, 'masked re-save keeps the company configured')
  const got2 = await h.invoke('nic:get')
  assertEq(got2.password, '••••••••', 'still masked after the round-trip')

  // And the page itself never contains the secret anywhere.
  await h.goto('edocs')
  const leaked = await h.page.evaluate((secret) => document.documentElement.outerHTML.includes(secret), CREDS.password)
  assert(!leaked, 'the secret never appears in the DOM')
  await h.shot('01-edocs')
})
