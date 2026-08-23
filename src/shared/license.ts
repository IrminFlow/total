/**
 * Offline licensing.
 *
 * Total never phones home, so a licence cannot be a server check. It is a short token the buyer
 * pastes in: a JSON payload plus an Ed25519 signature over it, verified against a public key
 * compiled into the app. No account, no activation call, no network. The private key never
 * leaves the machine that issues licences.
 *
 * This module is pure — encoding, parsing and the state machine — so it runs in the renderer and
 * under plain vitest. The signature check itself needs crypto and lives in main
 * (services/license.ts); nothing here can be tricked into believing an unsigned payload, because
 * `decodeLicense` deliberately returns the payload WITHOUT asserting anything about validity.
 *
 * The central design decision is that it fails soft. An expired licence never locks the books:
 * it degrades to read-only, and reading, printing, exporting and backing up keep working
 * forever. Nobody should ever be shut out of their own accounts because a payment failed, and
 * the two rupees that policy costs are worth less than one person telling that story publicly.
 */

export const LICENSE_VERSION = 1

/** Days of full function before a licence is needed. No key, no email, no signup. */
export const TRIAL_DAYS = 30

export interface LicensePayload {
  v: number
  /** Who it was issued to, shown in Settings so a shared key is obvious. */
  name: string
  plan: 'annual' | 'perpetual'
  /** ISO date the licence was issued. */
  issued: string
  /**
   * ISO date after which it stops covering NEW versions (perpetual) or stops working
   * (annual). Perpetual licences keep working forever on versions released before this date.
   */
  expires: string
  /** Companies covered. 0 means unlimited — what a CA edition carries. */
  companies: number
}

export type LicenseKind = 'trial' | 'licensed' | 'trial-expired' | 'license-expired' | 'invalid'

export interface LicenseState {
  kind: LicenseKind
  /** Whether writes are allowed. Reading, printing, exporting and backup are ALWAYS allowed. */
  readOnly: boolean
  /** Days remaining, when that is a meaningful thing to show. */
  daysLeft: number | null
  payload: LicensePayload | null
  /** One sentence for the UI. Never scolding, always says what still works. */
  message: string
}

function daysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)))
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)))
  return Math.round((b - a) / 86_400_000)
}

function b64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  // The payload is ASCII JSON, so a byte-for-byte decode is enough and avoids a TextDecoder
  // dependency in a module that has to run everywhere.
  return binary
}

export function b64urlEncode(input: string): string {
  return btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Split a token into its signed part and its signature. Neither is trusted yet. */
export function splitLicense(token: string): { signed: string; signature: string } | null {
  const parts = token.trim().split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null
  return { signed: parts[0], signature: parts[1] }
}

/**
 * Parse the payload out of a token. Does NOT verify the signature — that is main's job, and the
 * split is deliberate so no caller can mistake "parsed" for "valid".
 */
export function decodeLicense(token: string): LicensePayload | null {
  const parts = splitLicense(token)
  if (!parts) return null
  try {
    const payload = JSON.parse(b64urlDecode(parts.signed)) as LicensePayload
    if (payload?.v !== LICENSE_VERSION) return null
    if (typeof payload.name !== 'string' || typeof payload.expires !== 'string') return null
    if (!/^\d{4}-\d{2}-\d{2}$/.test(payload.expires)) return null
    if (payload.plan !== 'annual' && payload.plan !== 'perpetual') return null
    return payload
  } catch {
    return null
  }
}

/**
 * The whole state machine, given what main has already verified.
 *
 * `verified` is false when there is no licence at all, or when the signature did not check out.
 * Those are different messages but the same capability: trial rules apply.
 */
export function licenseState(input: {
  today: string
  firstRun: string
  payload: LicensePayload | null
  verified: boolean
  /** True when a token was supplied but failed verification, as opposed to no token at all. */
  tampered?: boolean
}): LicenseState {
  const { today, firstRun, payload, verified } = input

  if (verified && payload) {
    const daysLeft = daysBetween(today, payload.expires)
    if (daysLeft >= 0) {
      return {
        kind: 'licensed',
        readOnly: false,
        daysLeft,
        payload,
        message:
          payload.plan === 'perpetual'
            ? `Licensed to ${payload.name}. Updates included until ${payload.expires}.`
            : `Licensed to ${payload.name} until ${payload.expires}.`
      }
    }
    // A perpetual licence keeps working after its date; only its update window closed.
    if (payload.plan === 'perpetual') {
      return {
        kind: 'licensed',
        readOnly: false,
        daysLeft: 0,
        payload,
        message: `Licensed to ${payload.name}. Your update window ended on ${payload.expires}; this version keeps working.`
      }
    }
    return {
      kind: 'license-expired',
      readOnly: true,
      daysLeft: 0,
      payload,
      message: `Your licence ended on ${payload.expires}. Your books are still here: you can open, read, print, export and back up everything. Renew to post new entries.`
    }
  }

  if (input.tampered) {
    return {
      kind: 'invalid',
      readOnly: false,
      daysLeft: null,
      payload: null,
      message: "That licence key didn't verify. Check you pasted all of it, or write to us and we'll sort it out."
    }
  }

  const used = daysBetween(firstRun, today)
  const daysLeft = TRIAL_DAYS - used
  if (daysLeft > 0) {
    return {
      kind: 'trial',
      readOnly: false,
      daysLeft,
      payload: null,
      message: `${daysLeft} day${daysLeft === 1 ? '' : 's'} left in your trial. Everything works; nothing expires but the trial.`
    }
  }
  return {
    kind: 'trial-expired',
    readOnly: true,
    daysLeft: 0,
    payload: null,
    message:
      'Your trial has ended. Your books are still here: you can open, read, print, export and back up everything. Add a licence to post new entries.'
  }
}
