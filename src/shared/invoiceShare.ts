/**
 * Sending an invoice out (roadmap I-193 WhatsApp, I-192 email).
 *
 * The app never sends anything. It builds the message, puts the PDF where the person can attach
 * it, and opens WhatsApp or the mail client with the text already filled in — the same rule the
 * payment reminders in `outstanding.ts` and the reorder notes in `reorder.ts` follow, and for the
 * same three reasons: an offline app has no outbound credentials to hold, a message sent by
 * software is a message nobody read before it went, and WhatsApp's Business API is a paid,
 * account-bound service this product deliberately does not depend on.
 *
 * The awkward part is honest rather than solvable: a `wa.me` link can carry TEXT and cannot carry
 * an attachment. So the flow is PDF → clipboard → wa.me, and the message says the invoice is
 * attached only because the person attaching it is about to paste it. The caller is responsible
 * for the clipboard half; this module builds the words and the links.
 *
 * Pure — no Electron, no filesystem.
 */

import { formatPaise } from './money'
import { toDisplayDate } from './dates'
import { whatsappNumber } from './outstanding'

export interface InvoiceShareParty {
  name: string
  phone: string | null
  email: string | null
}

export interface InvoiceShareInvoice {
  number: string
  date: string
  totalPaise: number
  /** Set when the document is a proforma or a credit note, so the wording can stop saying "due". */
  kind?: 'invoice' | 'proforma' | 'credit_note'
}

export interface InvoiceShare {
  subject: string
  body: string
  /** Always present. An empty address still opens a compose window, which is better than nothing. */
  mailto: string
  /** Null when the party has no number WhatsApp could use — the UI must say so, not fail silently. */
  whatsapp: string | null
  /** What the caller should tell the user to do, given that the PDF cannot ride inside the link. */
  attachmentHint: string
}

/**
 * Compose the message.
 *
 * The figure is in the text on purpose. A customer who opens WhatsApp on a phone with no PDF
 * reader still learns what is owed, and a message that says only "please find attached" is a
 * message that gets ignored until somebody opens the attachment.
 */
export function buildInvoiceShare(
  companyName: string,
  invoice: InvoiceShareInvoice,
  party: InvoiceShareParty,
  opts: { pdfFileName?: string; defaultCountryCode?: string } = {}
): InvoiceShare {
  const kind = invoice.kind ?? 'invoice'
  const noun = kind === 'proforma' ? 'proforma invoice' : kind === 'credit_note' ? 'credit note' : 'invoice'
  const amount = `₹ ${formatPaise(invoice.totalPaise)}`

  const subject = `${companyName} — ${noun} ${invoice.number}`

  const lines = [
    `Dear ${party.name},`,
    '',
    kind === 'credit_note'
      ? `Please find our credit note ${invoice.number} dated ${toDisplayDate(invoice.date)} for ${amount}.`
      : `Please find our ${noun} ${invoice.number} dated ${toDisplayDate(invoice.date)} for ${amount}.`,
    '',
    `Regards,`,
    companyName
  ]
  const body = lines.join('\n')

  const number = whatsappNumber(party.phone, opts.defaultCountryCode ?? '91')

  return {
    subject,
    body,
    mailto: `mailto:${party.email ?? ''}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`,
    whatsapp: number ? `https://wa.me/${number}?text=${encodeURIComponent(body)}` : null,
    attachmentHint: opts.pdfFileName
      ? `${opts.pdfFileName} is on the clipboard — paste it into the chat before sending.`
      : 'The PDF is on the clipboard — paste it into the chat before sending.'
  }
}
