/**
 * "Show me exactly what would be sent", and "show me what you will never send".
 *
 * Total's disclosure copy says GSTINs, PAN, bank accounts and payroll never leave the machine.
 * That is a promise made in prose about code the user cannot read, and prose is the weakest form
 * a security claim can take. These two views replace it with something checkable:
 *
 *  - The PAYLOAD VIEWER (buildPreview, in main) renders the exact message array that would be
 *    posted, built by the same code path that posts it, so there is no second implementation to
 *    drift. The user reads their own books going out, in the order they go.
 *  - The REDACTION PREVIEW (below) runs a worked example through the real `redact` function. It
 *    is not a description of the redaction rules — it IS the redaction rules, executed, with the
 *    before and after side by side.
 *
 * Both are read-only and neither contacts anything. Opening the payload viewer with the endpoint
 * misconfigured, the key absent or the network unplugged still shows the payload, which is the
 * point: a user should be able to see what would be sent before deciding to send anything.
 */

import { redact, REDACTED_KEYS } from './redact'

export interface PreviewMessage {
  role: string
  /** Serialized content. Tool results appear exactly as the model would receive them. */
  content: string
  /** Present on assistant messages that requested tools. */
  toolCalls?: { name: string; arguments: string }[]
}

export interface PayloadPreview {
  host: string
  model: string
  local: boolean
  /** True when the endpoint is on this machine, so "sent" means "sent to localhost". */
  messages: PreviewMessage[]
  /** Tool names offered to the model, so the user can see there is no write tool in the list. */
  tools: string[]
  /** Total characters across all messages — the honest size of the disclosure. */
  characters: number
  /** Estimated cost of one exchange of this size, in paise. 0 for a local endpoint. */
  estimatedCostPaise: number
  egress: 'full' | 'names-redacted'
}

/** Rough token count for a size estimate. Four characters per token is the usual approximation
 *  for English and is wrong in the safe direction for Devanagari and for long numbers. */
export function approxTokens(characters: number): number {
  return Math.ceil(characters / 4)
}

export interface RedactionExample {
  field: string
  before: string
  after: string
  why: string
}

/**
 * A worked example of the always-on redaction, computed by running the real function.
 *
 * The sample is a party ledger row with every protected field populated — the shape a tool
 * result actually has. If someone adds a field to REDACTED_KEYS and forgets this list, the
 * unit test that compares the two fails.
 */
export function redactionPreview(): {
  sent: string[]
  withheld: RedactionExample[]
  raw: Record<string, unknown>
  redacted: Record<string, unknown>
} {
  const raw: Record<string, unknown> = {
    ref: 'l:42',
    ledgerId: 42,
    name: 'Sharma Traders',
    group: 'Sundry Debtors',
    gstin: '27AAPFU0939F1ZV',
    pan: 'AAPFU0939F',
    accountNo: '50100234567890',
    ifsc: 'HDFC0000123',
    email: 'accounts@sharmatraders.example',
    phone: '9876543210',
    pending: { text: '1,24,560.00', paise: 12456000 }
  }
  const redacted = redact(raw)

  const why: Record<string, string> = {
    gstin: 'The embedded PAN is the identifying part. The state code and check characters stay, because place of supply is a real GST question.',
    pan: 'A permanent account number identifies a taxpayer for every purpose, not just this one. No question about these books needs it.',
    accountNo: 'A bank account number plus a name is enough to attempt a payment.',
    ifsc: 'Meaningless alone, identifying beside an account number — and they always travel together.',
    email: 'Contact details are the payload of a data breach, and no report is computed from them.',
    phone: 'Contact details are the payload of a data breach, and no report is computed from them.'
  }

  const withheld: RedactionExample[] = Object.keys(raw)
    .filter((key) => String(raw[key]) !== String((redacted as Record<string, unknown>)[key]))
    .map((key) => ({
      field: key,
      before: String(raw[key]),
      after: String((redacted as Record<string, unknown>)[key]),
      why: why[key] ?? 'Never needed to answer a question about the books.'
    }))

  const sent = Object.keys(raw).filter((key) => !withheld.some((w) => w.field === key))
  return { sent, withheld, raw, redacted }
}

/** Every field name the redactor drops, for the settings list. Sorted for a stable rendering. */
export function alwaysRedactedFields(): string[] {
  return [...REDACTED_KEYS].sort()
}
