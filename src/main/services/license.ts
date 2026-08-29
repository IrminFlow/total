/**
 * Licence verification and state.
 *
 * The signature check lives here, in main, because it needs crypto and because keeping it out of
 * shared/ means no renderer code path can accidentally treat a decoded payload as a valid one.
 *
 * Verification is Ed25519 against a public key compiled into the app. There is no network call
 * and no activation server: the buyer pastes a token, this checks the signature, and that is the
 * whole mechanism. Someone determined can share a key, and that is accepted — every mechanism
 * that stops them costs the honest majority more than the leakage does.
 */

import { createPublicKey, verify } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { decodeLicense, licenseState, splitLicense, type LicenseState } from '@shared/license'
import { todayISO } from '@shared/dates'
import { dataRoot } from '../paths'

/**
 * Public half of the licensing key pair. Replace with your own before selling anything:
 *   node scripts/make-license.mjs --keygen
 * prints a fresh pair and tells you where to paste each half.
 *
 * A placeholder rather than a real key means an unlicensed build simply never verifies anything,
 * which is the safe default: everyone gets the trial, nobody is wrongly locked out.
 */
function publicKeyB64(): string {
  // Read per call rather than at module load: a build-time value either way, but this keeps the
  // module free of import-order coupling and lets the tests exercise a real key pair.
  return process.env.TOTAL_LICENSE_PUBKEY ?? ''
}

interface LicenseFile {
  version: 1
  token: string | null
  /** First launch, in ISO date form. The trial clock. */
  firstRun: string
}

function licensePath(): string {
  if (process.env.TOTAL_DATA_DIR) return join(dataRoot(), 'license.json')
  try {
    return join(app.getPath('userData'), 'license.json')
  } catch {
    return join(dataRoot(), 'license.json')
  }
}

function read(): LicenseFile {
  const path = licensePath()
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as LicenseFile
      if (parsed?.version === 1 && typeof parsed.firstRun === 'string') return parsed
    } catch {
      // A corrupt file must not brick the app. Fall through and start a fresh trial clock.
    }
  }
  const fresh: LicenseFile = { version: 1, token: null, firstRun: todayISO() }
  write(fresh)
  return fresh
}

function write(file: LicenseFile): void {
  const path = licensePath()
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(file, null, 2), 'utf8')
  renameSync(tmp, path)
}

/** True when the token's signature checks out against the compiled-in public key. */
export function verifyToken(token: string): boolean {
  const spki = publicKeyB64()
  if (!spki) return false
  const parts = splitLicense(token)
  if (!parts) return false
  try {
    const key = createPublicKey({
      key: Buffer.from(spki, 'base64'),
      format: 'der',
      type: 'spki'
    })
    return verify(null, Buffer.from(parts.signed), key, Buffer.from(parts.signature, 'base64url'))
  } catch {
    return false
  }
}

export function currentState(): LicenseState {
  const file = read()
  if (!file.token) {
    return licenseState({ today: todayISO(), firstRun: file.firstRun, payload: null, verified: false })
  }
  const verified = verifyToken(file.token)
  const payload = verified ? decodeLicense(file.token) : null
  return licenseState({
    today: todayISO(),
    firstRun: file.firstRun,
    payload,
    verified: verified && payload != null,
    tampered: !verified
  })
}

/** Store a pasted key. Returns the resulting state so the UI can say what happened. */
export function applyToken(token: string): LicenseState {
  const file = read()
  const trimmed = token.trim()
  write({ ...file, token: trimmed || null })
  return currentState()
}

/** True when writes should be refused. Reading, printing, exporting and backup never are. */
export function isReadOnly(): boolean {
  return currentState().readOnly
}
