// Scenario 13 — NIC credential masking (ported from the retired drive6.mjs check): the saved
// password AND clientSecret never come back to the renderer (both halves of the NIC auth
// credential pair — v0.3 review F3), and re-saving the masked sentinels keeps the real values
// (configured stays true) instead of clobbering them.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import * as fs from 'node:fs'
import * as path from 'node:path'

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

  // Unsigned automation binaries can trigger a macOS Keychain prompt that Playwright cannot
  // operate. Replace only the test process's safeStorage methods with a reversible byte cipher;
  // production continues to use Electron's OS-backed safeStorage implementation.
  await h.app.evaluate(({ safeStorage }) => {
    const key = Buffer.from('total-e2e-credential-envelope')
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

  const st0 = await h.invoke('nic:status')
  assertEq(st0.configured, false, 'fresh company has no NIC credentials')

  const saved = await h.invoke('nic:save', CREDS)
  assertEq(saved.configured, true, 'nic:save reports configured')

  // Secrets are not merely hidden from the renderer; the on-disk SQLite database and WAL do
  // not contain their plaintext bytes either. They hold an OS-protected encrypted envelope.
  const companyDir = path.join(h.dataDir, 'companies', 'nic-co')
  const diskBytes = fs.readdirSync(companyDir)
    .filter((file) => file.startsWith('company.db'))
    .map((file) => fs.readFileSync(path.join(companyDir, file)))
  assert(!diskBytes.some((bytes) => bytes.includes(Buffer.from(CREDS.password))), 'NIC password is encrypted at rest')
  assert(!diskBytes.some((bytes) => bytes.includes(Buffer.from(CREDS.clientSecret))), 'NIC client secret is encrypted at rest')

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

  // And the page itself never contains either secret anywhere.
  await h.goto('edocs')
  const leaked = await h.page.evaluate(
    (secrets) => secrets.some((s) => document.documentElement.outerHTML.includes(s)),
    [CREDS.password, CREDS.clientSecret]
  )
  assert(!leaked, 'neither secret ever appears in the DOM')
  await h.shot('01-edocs')
})
