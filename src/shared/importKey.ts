/**
 * Re-import safety: the identity of a voucher that came from somewhere else.
 *
 * A migrating business does not import once. They import the masters, then the vouchers, then
 * realise April is missing and export again with a wider date range — and the second file
 * contains every voucher the first one did. Without an identity, the books end up with two of
 * everything and a trial balance that ties perfectly at double the size, which is the worst
 * possible failure: it looks right.
 *
 * The identity is a fingerprint, stored on the voucher as `import_key`, and checked before an
 * import creates anything.
 */

export interface FingerprintSource {
  /** Tally's own GUID / REMOTEID for the voucher, when the export carries one. */
  guid?: string | null
  vchType: string
  /** ISO date. */
  date: string
  number: string
  party?: string | null
  lines: { ledger: string; drCr: 'dr' | 'cr'; amount: number }[]
}

/**
 * 32-bit FNV-1a over a string, hex. Not a cryptographic hash and not trying to be — it exists
 * to compress a voucher's contents to a comparable token. Written out rather than imported from
 * node:crypto because this module has to run in the renderer too (src/shared/ is pure).
 */
function fnv1a(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    // The FNV prime, 16777619, by shifts — Math.imul keeps it in 32-bit range.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * The fingerprint of one imported voucher.
 *
 * A GUID wins whenever the export carries one: Tally's GUID is stable across exports of the same
 * voucher, so it survives the user re-exporting with different columns or a wider period.
 *
 * Without a GUID (Day Book exports frequently have none), the fingerprint is built from what
 * makes the voucher what it is — type, date, number, party — plus the shape and total of its
 * lines, plus a hash of the lines themselves. The counts and totals are carried in the key in
 * plain sight rather than being folded into the hash, so a hash collision alone can never make
 * two different vouchers look like one: they would have to agree on type, date, number, party,
 * line count and total as well, at which point they are the same voucher by any definition a
 * person would use.
 *
 * Amounts are paise integers, so this is exact.
 */
export function voucherFingerprint(v: FingerprintSource): string {
  const guid = (v.guid ?? '').trim()
  if (guid) return `guid:${guid.toUpperCase()}`

  const totalDr = v.lines.filter((l) => l.drCr === 'dr').reduce((sum, l) => sum + l.amount, 0)
  const detail = v.lines
    .map((l) => `${l.ledger.trim().toLowerCase()}|${l.drCr}|${l.amount}`)
    // Sorted: Tally does not promise line order between exports, and a voucher whose lines came
    // back in a different order is the same voucher.
    .sort()
    .join(';')
  const head = [
    v.vchType.trim().toLowerCase(),
    v.date,
    v.number.trim().toLowerCase(),
    (v.party ?? '').trim().toLowerCase()
  ].join('|')
  return `v1:${head}|${v.lines.length}|${totalDr}|${fnv1a(`${head}#${detail}`)}`
}
