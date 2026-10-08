// WP 5.3 — did the USER ask for an entry? A draft made when they did not (e.g. prompted by an
// instruction hidden in a narration, a ledger name or imported text) is flagged `unrequested`
// and shown with a red warning. Report questions that merely mention sales, bills or payments
// ("Show me sales for August", "Which bills are overdue?", "make a list of …") are NOT requests.
//
// A request is one of:
//   - an entry verb followed (within three words) by an entry noun:
//       "record a sales invoice", "enter these three expense bills", "create a delivery challan";
//   - "draft …" anywhere ("also draft the July rent");
//   - an imperative money verb opening a sentence: "pay …", "receive … from", "deposit …",
//     "withdraw …", "transfer …", "manufacture / produce …";
//   - a first-person past booking: "I paid …", "we received …", "we sold …".
// Intent carries across a clarification: when a draft tool asked the user to choose (status
// needs_clarification) after a request, the answer ("Sharma Steel") still counts as requested.
import type { DB } from '../../db/connection'
import * as store from '../store'

const VERBS = 'record|enter|create|make|post|book|raise|issue|prepare|add|generate|log|put through|pass'
const NOUNS =
  'invoices?|bills?|payments?|receipts?|vouchers?|entr(?:y|ies)|journals?|contras?|challans?|grns?|goods receipt(?: notes?)?|credit notes?|debit notes?|' +
  'quotations?|quotes?|(?:sales |purchase )?orders?|manufactur\\w*|sales?|purchases?|expenses?|transfers?|deposits?'
/** Words that turn a phrase into a report request even after an entry verb ("make a list of bills"). */
const REPORT_WORDS = /^(list|lists|report|reports|summary|statement|chart|table|breakdown|total|totals|analysis|overview|of)$/i

const PHRASE = new RegExp(`\\b(?:${VERBS})\\s+((?:[\\p{L}\\p{N}'’-]+\\s+){0,3}?)(?:${NOUNS})\\b`, 'iu')
const DRAFT = /\bdraft(?:s|ed|ing)?\b/i
const IMPERATIVE = /(?:^|[.!?;\n]\s*|\b(?:please|also|and)\s+)(?:pay|receive|deposit|withdraw|transfer|manufacture|produce)\b/i
const FIRST_PERSON = /\b(?:i|we)\s+(?:have\s+)?(?:paid|received|sold|bought|purchased|deposited|withdrew|transferred|manufactured|produced|issued)\b/i

export function isRequestedDraft(userRequest: string | undefined | null): boolean {
  if (!userRequest) return false
  const text = userRequest.trim()
  if (DRAFT.test(text) || IMPERATIVE.test(text) || FIRST_PERSON.test(text)) return true
  const re = new RegExp(PHRASE.source, 'giu')
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const between = (m[1] ?? '').trim().split(/\s+/).filter(Boolean)
    if (!between.some((w) => REPORT_WORDS.test(w))) return true
  }
  return false
}

const DRAFT_TOOL_NAMES = new Set(['draft_voucher', 'draft_invoice', 'draft_stock_note', 'draft_manufacture', 'draft_trade_doc'])

/** Whether the current question (`currentText`, the thread's last user message) asked for an
 *  entry, counting a clarification chain: walking back through earlier questions, each one that
 *  was answered with a draft tool's needs_clarification (and made no draft) passes the intent of
 *  the question before it. */
export function draftRequestedInThread(db: DB, threadId: number | null, currentText: string): boolean {
  if (isRequestedDraft(currentText)) return true
  if (threadId == null) return false
  const messages = store.listMessages(db, threadId)
  const userIdx = messages.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i >= 0)
  // The current question is the last user message; walk back from the one before it.
  for (let k = userIdx.length - 2, hops = 0; k >= 0 && hops < 5; k--, hops++) {
    const from = userIdx[k]!
    const to = userIdx[k + 1]!
    const replies = messages.slice(from + 1, to)
    const draftTools = replies.filter((m) => m.role === 'tool' && m.toolName && DRAFT_TOOL_NAMES.has(m.toolName))
    if (replies.some((m) => m.draftId != null)) return false // a draft was made: that request is done
    const asked = draftTools.some((m) => {
      const out = m.toolOutput as { ok?: boolean; result?: { status?: string } } | null
      return out?.ok === true && out.result?.status === 'needs_clarification'
    })
    if (!asked) return false
    if (isRequestedDraft(messages[from]!.content)) return true
  }
  return false
}
