// Scenario 13 — NIC credential masking (ported from the retired drive6.mjs check): the saved
// password AND clientSecret never come back to the renderer (both halves of the NIC auth
// credential pair — v0.3 review F3), and re-saving the masked sentinels keeps the real values
// (configured stays true) instead of clobbering them.
import fs from 'node:fs'
import path from 'node:path'
import { scenario, assert, assertEq } from '../lib/harness.mjs'

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
})
