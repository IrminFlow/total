/**
 * Minting a licence key and getting it to the buyer.
 *
 * The key format is the app's: base64url(JSON payload) + "." + base64url(Ed25519 signature over
 * that first string), verified offline against a public key compiled into the app. See
 * src/shared/license.ts in the product repo. Nothing here contacts the app and the app never
 * contacts anything here; a key is a piece of text that happens to have been signed.
 *
 * SIGNING IS OPTIONAL AND OFF BY DEFAULT. If LICENCE_PRIVATE_KEY_PEM is set, a paid order is
 * signed and sent within the second. If it is not, the order is recorded and the operator is
 * told to run scripts/make-license.mjs on their own machine and send the key by hand. Keeping
 * the signing key off a web host is a defensible choice and the more conservative one, so the
 * code has to work either way rather than assume.
 */

import { createPrivateKey, sign } from 'node:crypto'

export interface LicenceRequest {
  name: string
  plan: 'annual' | 'perpetual'
  /** Years of cover. Perpetual keys use this for the updates window. */
  years: number
  /** 0 is unlimited, which is what every plan currently carries. */
  companies: number
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url')
}

function addYears(iso: string, years: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString().slice(0, 10)
}

export function canMint(): boolean {
  return Boolean(process.env.LICENCE_PRIVATE_KEY_PEM)
}

/** A signed key, or null when no signing key is configured on this deployment. */
export function mintLicence(req: LicenceRequest, today: string): string | null {
  const pem = process.env.LICENCE_PRIVATE_KEY_PEM
  if (!pem) return null
  const payload = {
    v: 1,
    name: req.name,
    plan: req.plan,
    issued: today,
    expires: addYears(today, req.years),
    companies: req.companies
  }
  const signed = b64url(JSON.stringify(payload))
  // Ed25519 signs the message directly; the algorithm argument is null, as in the app's verifier.
  const signature = sign(null, Buffer.from(signed), createPrivateKey(pem.replace(/\\n/g, '\n')))
  return `${signed}.${b64url(signature)}`
}

const RESEND_KEY = process.env.RESEND_API_KEY
const MAIL_FROM = process.env.MAIL_FROM
const WA_TOKEN = process.env.WHATSAPP_TOKEN
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID
const WA_TEMPLATE = process.env.WHATSAPP_TEMPLATE_NAME
const WA_LOCALE = process.env.WHATSAPP_TEMPLATE_LOCALE ?? 'en'

export interface DeliveryResult {
  email: 'sent' | 'failed' | 'not-configured'
  whatsapp: 'sent' | 'failed' | 'not-configured' | 'no-number'
}

async function emailKey(to: string, name: string, key: string): Promise<boolean> {
  if (!RESEND_KEY || !MAIL_FROM) return false
  const body = [
    `${name},`,
    '',
    'Here is your Total licence key. Open Total, go to Settings, then Licence, and paste it in.',
    '',
    key,
    '',
    'It is checked on your own machine and never sent anywhere. Keep this mail: if you move to a',
    'new computer, copy your ~/Documents/total folder across and paste the same key.',
    '',
    'If a licence ever lapses, Total keeps opening every company, reading every report, printing,',
    'exporting and taking backups. Only posting new entries pauses.'
  ].join('\n')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject: 'Your Total licence key', text: body })
  })
  return res.ok
}

/**
 * WhatsApp through Meta's Cloud API. A message we start rather than reply to has to be an
 * approved template, so the operator registers one with two body variables (the buyer's name and
 * the key) before this can work. Without WHATSAPP_TEMPLATE_NAME this is a no-op.
 */
async function whatsappKey(toNumber: string, name: string, key: string): Promise<boolean> {
  if (!WA_TOKEN || !WA_PHONE_ID || !WA_TEMPLATE) return false
  const res = await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${WA_TOKEN}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: toNumber,
      type: 'template',
      template: {
        name: WA_TEMPLATE,
        language: { code: WA_LOCALE },
        components: [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: name },
              { type: 'text', text: key }
            ]
          }
        ]
      }
    })
  })
  return res.ok
}

export async function deliverLicence(input: {
  email: string
  phone?: string
  name: string
  key: string
}): Promise<DeliveryResult> {
  const result: DeliveryResult = { email: 'not-configured', whatsapp: 'not-configured' }

  if (RESEND_KEY && MAIL_FROM) {
    try {
      result.email = (await emailKey(input.email, input.name, input.key)) ? 'sent' : 'failed'
    } catch {
      result.email = 'failed'
    }
  }

  if (!input.phone) {
    result.whatsapp = 'no-number'
  } else if (WA_TOKEN && WA_PHONE_ID && WA_TEMPLATE) {
    try {
      result.whatsapp = (await whatsappKey(input.phone, input.name, input.key)) ? 'sent' : 'failed'
    } catch {
      result.whatsapp = 'failed'
    }
  }

  return result
}
