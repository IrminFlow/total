/**
 * Store and forward for the two things visitors send us: feedback from inside the app, and a
 * request for a reminder before a trial runs out.
 *
 * Nothing here writes to a database, because this site does not have one and adding one to hold
 * a handful of messages a week would be silly. Instead each message is stored durably as an
 * issue in the private product repo (the token that already serves release downloads can do it),
 * and forwarded by email so somebody actually reads it today.
 *
 * Every sink is optional and every sink is checked at request time. If none is configured the
 * route says so plainly rather than swallowing the message and showing a tick. A form that
 * pretends to have sent something is worse than a form that is honestly out of order.
 */

const GITHUB_REPO = process.env.GITHUB_REPO ?? 'IrminFlow/total'
const ISSUE_REPO = process.env.FEEDBACK_REPO ?? GITHUB_REPO
const ISSUE_TOKEN = process.env.FEEDBACK_GITHUB_TOKEN ?? process.env.GITHUB_TOKEN
const RESEND_KEY = process.env.RESEND_API_KEY
const MAIL_FROM = process.env.MAIL_FROM
const MAIL_TO = process.env.MAIL_TO
const WEBHOOK = process.env.FORWARD_WEBHOOK_URL

export interface Message {
  /** Short, goes in the issue title and the mail subject. */
  title: string
  /** Markdown. Already sanitised by the caller. */
  body: string
  labels?: string[]
}

export interface Delivery {
  stored: boolean
  forwarded: boolean
  /** Sinks that were configured but failed, for the server log. Never shown to the visitor. */
  failures: string[]
  configured: boolean
}

async function storeAsIssue(message: Message): Promise<boolean> {
  if (!ISSUE_TOKEN) return false
  const res = await fetch(`https://api.github.com/repos/${ISSUE_REPO}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${ISSUE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    cache: 'no-store',
    body: JSON.stringify({ title: message.title, body: message.body, labels: message.labels ?? [] })
  })
  return res.ok
}

async function forwardByEmail(message: Message): Promise<boolean> {
  if (!RESEND_KEY || !MAIL_FROM || !MAIL_TO) return false
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_KEY}`, 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      from: MAIL_FROM,
      to: MAIL_TO.split(',').map((s) => s.trim()),
      subject: message.title,
      text: message.body
    })
  })
  return res.ok
}

async function forwardToWebhook(message: Message): Promise<boolean> {
  if (!WEBHOOK) return false
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ text: `${message.title}\n\n${message.body}` })
  })
  return res.ok
}

export async function deliver(message: Message): Promise<Delivery> {
  const configured = Boolean(ISSUE_TOKEN || (RESEND_KEY && MAIL_FROM && MAIL_TO) || WEBHOOK)
  const failures: string[] = []
  let stored = false
  let forwarded = false

  const attempt = async (name: string, fn: () => Promise<boolean>): Promise<boolean> => {
    try {
      return await fn()
    } catch {
      failures.push(name)
      return false
    }
  }

  stored = await attempt('github-issue', () => storeAsIssue(message))
  const mailed = await attempt('resend', () => forwardByEmail(message))
  const hooked = await attempt('webhook', () => forwardToWebhook(message))
  forwarded = mailed || hooked

  return { stored, forwarded, failures, configured }
}
