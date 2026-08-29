// Licence issuing tool. Runs on YOUR machine, never ships to a user.
//
//   node scripts/make-license.mjs --keygen
//   node scripts/make-license.mjs --name "Sharma Traders" --plan annual --years 1
//
// The private key never leaves this machine. The public half is compiled into the app, so the
// app verifies a key with no network call of any kind -- which is the only way to sell software
// that promises it never phones home.
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : fallback
}

if (process.argv.includes('--keygen')) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const priv = privateKey.export({ format: 'pem', type: 'pkcs8' })
  console.log('PUBLIC KEY (compile into the app):\n')
  console.log(`  TOTAL_LICENSE_PUBKEY=${pub}\n`)
  console.log('Set it as a build-time env var, or paste it into PUBLIC_KEY_SPKI_B64 in')
  console.log('src/main/services/license.ts.\n')
  console.log('PRIVATE KEY (keep this secret; save as license-key.pem, never commit it):\n')
  console.log(priv)
  process.exit(0)
}

const keyPath = arg('key', 'license-key.pem')
if (!existsSync(keyPath)) {
  console.error(`No private key at ${keyPath}. Run --keygen first, or pass --key <path>.`)
  process.exit(2)
}

const name = arg('name')
if (!name) {
  console.error('--name "Buyer Name" is required.')
  process.exit(2)
}

const plan = arg('plan', 'annual')
if (plan !== 'annual' && plan !== 'perpetual') {
  console.error('--plan must be annual or perpetual.')
  process.exit(2)
}

const years = Number(arg('years', '1'))
const companies = Number(arg('companies', '1'))
const issued = new Date()
const expires = new Date(issued)
expires.setUTCFullYear(expires.getUTCFullYear() + years)

const payload = {
  v: 1,
  name,
  plan,
  issued: issued.toISOString().slice(0, 10),
  expires: expires.toISOString().slice(0, 10),
  companies
}

const b64url = (s) => Buffer.from(s).toString('base64url')
const signed = b64url(JSON.stringify(payload))
const key = createPrivateKey(readFileSync(keyPath, 'utf8'))
const signature = sign(null, Buffer.from(signed), key).toString('base64url')

console.log(JSON.stringify(payload, null, 2))
console.log('\nLicence key (send this to the buyer):\n')
console.log(`${signed}.${signature}`)
