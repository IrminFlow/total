// The TOTAL_AI_MOCK demo script's drafting half (WP 5.3) — kept apart from mockProvider.ts so the
// scripted chat and the scripted drafting grow independently. It plays the model for:
//   "record a sales invoice to Umbrella Retail for 2 Laptop 14 at 45,000"   → draft_invoice
//   "purchase invoice from X for 3 Y at 500"                                 → draft_invoice
//   "pay Bharat Steel against bills P-12 and P-15 from HDFC Bank"            → draft_voucher
//   "receive from X against bill S-3 into Cash"                              → draft_voucher
//   "quotation for Umbrella Retail for 3 Office Chair at 6,500"              → draft_trade_doc
//   "delivery challan to Umbrella Retail for 1 Laptop 14 [at 45,000]"        → draft_stock_note
//   "manufacture 2 Steel Filing Cabinet"                                      → draft_manufacture
// passing names, quantities and amounts exactly as typed (the app resolves and computes them),
// then answers by quoting the tool's summary, or asks the clarification the tool returned.
import type { MockStep } from './mockProvider'

interface Result {
  name: string
  output: string
}

const DRAFT_TOOLS = ['draft_invoice', 'draft_voucher', 'draft_stock_note', 'draft_manufacture', 'draft_trade_doc']

function answerFrom(r: Result): MockStep {
  try {
    const d = JSON.parse(r.output) as {
      ok?: boolean
      error?: string
      result?: { status?: string; summary?: string; questions?: { question: string; candidates: { name: string; detail?: string }[] }[]; assumptions?: string[] }
    }
    if (d.ok === false || d.error) return { text: `I could not draft it: ${d.error}` }
    const res = d.result ?? {}
    if (res.status === 'needs_clarification') {
      const q = (res.questions ?? []).map((x) => `${x.question}${x.candidates.length ? ` ${x.candidates.map((c) => c.name).join(' / ')}` : ''}`).join(' ')
      return { text: q || 'I need more details.' }
    }
    const assumed = res.assumptions?.length ? ` Assumed: ${res.assumptions.join('; ')}.` : ''
    return { text: `I drafted it: ${res.summary}.${assumed} Review the draft and save it from the editor — nothing is in the books yet.` }
  } catch {
    return { text: 'The draft tool answered with something I could not read.' }
  }
}

/** A step for a drafting question, or null when the question is not one. */
export function draftingDemoStep(question: string, results: readonly Result[], today: string | undefined): MockStep | null {
  const done = results.find((r) => DRAFT_TOOLS.includes(r.name))
  const q = question.trim()

  const inv = /\b(sales|purchase) invoice (?:to|from) (.+?) for (\d+(?:\.\d+)?) (.+?) at (₹?\s?[\d,]+(?:\.\d{1,2})?(?:\s*(?:lakh|k))?)\s*$/i.exec(q)
  if (inv) {
    if (done) return answerFrom(done)
    return {
      text: '',
      toolCalls: [
        {
          name: 'draft_invoice',
          arguments: { kind: inv[1]!.toLowerCase(), party: inv[2]!.trim(), ...(today ? { date: today } : {}), items: [{ item: inv[4]!.trim(), qty: inv[3]!, rate: inv[5]!.trim() }] }
        }
      ]
    }
  }

  const pay = /\b(pay|receive from) (.+?) against bills? (.+?) (?:from|into|by) (.+?)\s*$/i.exec(q)
  if (pay) {
    if (done) return answerFrom(done)
    const bills = pay[3]!.split(/\s*(?:,|\band\b|&)\s*/i).map((b) => b.trim()).filter(Boolean)
    return {
      text: '',
      toolCalls: [
        {
          name: 'draft_voucher',
          arguments: {
            kind: pay[1]!.toLowerCase() === 'pay' ? 'payment' : 'receipt',
            party: pay[2]!.trim(),
            account: pay[4]!.trim(),
            ...(today ? { date: today } : {}),
            bills: bills.map((bill) => ({ bill }))
          }
        }
      ]
    }
  }
  const doc = /\b(quotation|sales order|purchase order) (?:to|for|from) (.+?) for (\d+(?:\.\d+)?) (.+?) at (₹?\s?[\d,]+(?:\.\d{1,2})?(?:\s*(?:lakh|k))?)\s*$/i.exec(q)
  if (doc) {
    if (done) return answerFrom(done)
    return {
      text: '',
      toolCalls: [
        {
          name: 'draft_trade_doc',
          arguments: { kind: doc[1]!.toLowerCase().replace(' ', '_'), party: doc[2]!.trim(), ...(today ? { date: today } : {}), items: [{ item: doc[4]!.trim(), qty: doc[3]!, rate: doc[5]!.trim() }] }
        }
      ]
    }
  }

  const note = /\b(delivery challan|goods receipt note|grn) (?:to|from) (.+?) for (\d+(?:\.\d+)?) (.+?)(?: at (₹?\s?[\d,]+(?:\.\d{1,2})?))?\s*$/i.exec(q)
  if (note) {
    if (done) return answerFrom(done)
    return {
      text: '',
      toolCalls: [
        {
          name: 'draft_stock_note',
          arguments: { kind: /challan/i.test(note[1]!) ? 'delivery_note' : 'receipt_note', party: note[2]!.trim(), ...(today ? { date: today } : {}), items: [{ item: note[4]!.trim(), qty: note[3]!, ...(note[5] ? { rate: note[5].trim() } : {}) }] }
        }
      ]
    }
  }
  const make = /\bmanufacture (\d+(?:\.\d+)?) (.+?)\s*$/i.exec(q)
  if (make) {
    if (done) return answerFrom(done)
    return { text: '', toolCalls: [{ name: 'draft_manufacture', arguments: { item: make[2]!.trim(), qty: make[1]!, ...(today ? { date: today } : {}) } }] }
  }
  return null
}
