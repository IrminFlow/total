/**
 * Generate a JSON-Schema-style document for the voucher input contract by walking the live zod
 * schema (`voucherInputSchema`) — no zod-to-json-schema dependency. The walk itself now lives in
 * @shared/ai/jsonSchema, shared with the AI tool definitions so a coding agent posting through
 * the inbox and the assistant drafting a voucher work from the same shape. The unit test asserts
 * every top-level field of the real schema appears here, so the doc can't silently drift.
 *
 * Pure module: imports only zod schemas from src/shared — safe under plain-Node vitest.
 */
import { z } from 'zod'
import { voucherInputSchema } from '@shared/schemas'
import { walkSchema, type JsonSchema } from '@shared/ai/jsonSchema'


/** Field-by-field descriptions, merged into the generated schema. Kept here (not .describe() on
 *  the shared schema) so the shared schema stays exactly as the app uses it. */
const FIELD_DOCS: Record<string, string> = {
  voucherTypeId: 'Voucher type id — see voucherTypes in <company>/agent/meta.json.',
  date: 'Voucher date, YYYY-MM-DD. Must be after the period lock date if one is set.',
  number: 'Voucher number. Omit for auto-numbered types (the app assigns the next number); required for manual-numbered types.',
  partyLedgerId: 'Party ledger id (Sundry Debtor/Creditor) for sales/purchase/receipt/payment; null otherwise.',
  narration: 'Free-text narration shown on the voucher.',
  reference: 'External reference (order no., bill no., ...).',
  instrumentNo: 'Cheque/instrument number for bank vouchers.',
  instrumentDate: 'Cheque/instrument date, YYYY-MM-DD.',
  transporterId: 'Transporter GSTIN/id for e-way bill flows.',
  vehicleNo: 'Vehicle number for e-way bill flows.',
  transportDistanceKm: 'Transport distance in km (integer).',
  posOverride: 'Place-of-supply override: two-digit GST state code (e.g. "27"); null = derive from party/company state.',
  postDated: 'Post-dated voucher (PDC): stays out of the books until its date arrives, then matures automatically on company open.',
  isOptional: 'Optional (memorandum) voucher: recorded but never counted in books or reports.',
  currencyCode: '3-letter currency code for multi-currency vouchers (e.g. USD); null = base currency (INR).',
  exchangeRate: 'Units of INR per 1 unit of currencyCode.',
  lines:
    'Ledger lines. Every amount is INTEGER PAISE (₹1 = 100). The voucher must balance: sum of dr amounts must equal sum of cr amounts, or the whole voucher is rejected.',
  inventory: 'Stock item lines for inventory vouchers. qtyMilli is integer thousandths (1000 = 1 unit); ratePaise/amount are integer paise.',
  billRefs: "Bill-wise allocations: kind 'new' opens a bill, 'against' settles one, by name.",
  tds: 'TDS deduction on this voucher (section + base + deducted amount, paise), or null.',
  customFields:
    'Company-defined custom fields for this voucher type (fieldId + value). Every value is TEXT, including for number fields — a custom field is never money and no report sums it. Omit the key entirely to leave existing values untouched; send [] to clear them.'
}


/**
 * Merge FIELD_DOCS into every matching property, at any depth.
 *
 * Kept out of the shared walker because these descriptions are voucher-specific, and kept off
 * the shared zod schema (via .describe()) so that schema stays exactly as the app uses it.
 * Description first, then the node, so key order matches the committed
 * agent-skill/voucher.schema.json byte for byte.
 */
function withFieldDocs(node: JsonSchema): JsonSchema {
  if (!node.properties) return node
  const properties: Record<string, JsonSchema> = {}
  for (const [key, value] of Object.entries(node.properties)) {
    const described = withFieldDocs(value)
    properties[key] = FIELD_DOCS[key] ? { description: FIELD_DOCS[key], ...described } : described
  }
  const out: JsonSchema = { ...node, properties }
  if (node.items) out.items = withFieldDocs(node.items)
  return out
}

/** The generated voucher JSON schema document (object form). */
export function voucherJsonSchema(): Record<string, unknown> {
  const walked = walkSchema(voucherInputSchema)
  const node = withFieldDocs(walked.node)
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    title: 'Total voucher input',
    description:
      'One voucher for `total-cli post` or a `<company>/inbox/*.json` drop (a file may also hold an array of these). ' +
      'ALL AMOUNTS ARE INTEGER PAISE (₹1 = 100 paise); quantities are integer milli-units (1000 = 1 unit). ' +
      'Debits must equal credits — the app rejects everything else. Same validation as the app UI.',
    ...node
  }
}
