// Scenario 13 — NIC credential masking (ported from the retired drive6.mjs check): the saved
// password AND clientSecret never come back to the renderer (both halves of the NIC auth
// credential pair — v0.3 review F3), and re-saving the masked sentinels keeps the real values
// (configured stays true) instead of clobbering them.
import { scenario, assert, assertEq } from '../lib/harness.mjs'
import fs from 'node:fs'
import path from 'node:path'

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

  // And the page itself never contains either secret anywhere.
  await h.goto('edocs')
  const leaked = await h.page.evaluate(
    (secrets) => secrets.some((s) => document.documentElement.outerHTML.includes(s)),
    [CREDS.password, CREDS.clientSecret]
  )
  assert(!leaked, 'neither secret ever appears in the DOM')

  // The assertion the old plaintext-in-meta layout could never make: neither secret exists
  // anywhere under the data directory. That directory is what backups, the CA pack, encrypted
  // exports and a folder-copy all carry, and syncpath.ts warns it may live inside OneDrive --
  // so a credential landing there travels with the books. Secrets belong in the OS keychain,
  // and this walk is what keeps them there.
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name)
      return e.isDirectory() ? walk(full) : [full]
    })

  const files = walk(h.dataDir)
  assert(files.length > 0, `data dir has files to check (${files.length})`)
  // Guard against this passing vacuously. With a keychain the secrets file must exist and be
  // one of the files walked above -- that is what proves the bytes were encrypted rather than
  // simply never written. Without one (a CI box with no libsecret) secrets are session-only by
  // design, and the walk proves the weaker but still useful "nothing hit the disk".
  console.log('[13] secret storage mode:', got.secretStorage)
  if (got.secretStorage === 'keychain') {
    const rel = files.map((f) => path.relative(h.dataDir, f))
    assert(rel.includes('secrets.json'), `secrets.json was written and scanned (saw ${rel.join(', ')})`)
  }
  for (const file of files) {
    const bytes = fs.readFileSync(file)
    for (const secret of [CREDS.password, CREDS.clientSecret]) {
      assert(!bytes.includes(secret), `${secret} leaked into ${path.relative(h.dataDir, file)}`)
    }
  }

  await h.shot('01-edocs')
})
