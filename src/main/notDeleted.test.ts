import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve, sep } from 'path'

/**
 * Every query that reads `vouchers` says what it thinks about the bin (roadmap Q #331).
 *
 * Vouchers are soft-deleted: `vouchers.deleted_at` is stamped and the row stays. A query that
 * forgets the filter therefore does not crash, does not look wrong, and does not fail a test that
 * only ever creates live vouchers. It returns a trial balance that includes entries the user
 * deleted last March, and the way anyone finds out is that the books disagree with the return
 * that was filed from them.
 *
 * So the filter is checked mechanically instead of by review. The sanctioned scopes are
 * `NOT_DELETED` and `IN_BOOKS` from `src/main/services/vouchers.ts` — `IN_BOOKS` is the one new
 * report queries want, since it also drops post-dated, optional and unapproved vouchers — or a
 * literal `deleted_at` condition for the queries that read the bin on purpose.
 *
 * This is a grep, not a parser. It reads SQL out of string literals, follows one level of
 * `${interpolation}` inside a file, and asks whether the result mentions a scope. It cannot know
 * that a scope is the RIGHT one; it can know that somebody thought about it.
 */

const ROOT = resolve(__dirname, '..', '..')
const MAIN = join(ROOT, 'src', 'main')

/** Tests are excluded: asserting that a binned voucher is still on disk is what a bin test is. */
const isTest = (name: string): boolean => name.endsWith('.test.ts') || name.endsWith('.dbtest.ts')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || isTest(name)) return []
    return [full]
  })
}

/** Block comments, and whole-line `//` comments, so that prose about a query is not a query. */
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const STRING_RE = /`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g
const IS_SQL = /\b(SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE)\b/
const READS_VOUCHERS = /\b(?:FROM|JOIN)\s+vouchers\b/i
const SCOPED = /\b(IN_BOOKS|NOT_DELETED|deleted_at)\b/

/**
 * A write is not in scope for this rule.
 *
 * `UPDATE vouchers SET deleted_at = …` IS the soft delete, the restore un-stamps it, and
 * `DELETE FROM vouchers` is the purge — every one of them exists precisely to touch a binned row
 * by id. Requiring the filter here would mean requiring the bin never to be emptied.
 */
const IS_WRITE = /^\s*(INSERT|UPDATE|DELETE)\b/i

/**
 * The deliberate exceptions, keyed by file plus a snippet that must still be present.
 *
 * All of them share a shape: the voucher id is already in hand — it came from a scoped listing,
 * or from the row the user clicked — and the question being asked is about that one voucher, not
 * about what belongs in the books.
 */
const ALLOWED: { file: string; contains: string; why: string }[] = [
  {
    file: 'src/main/services/vouchers.ts',
    contains: 'SELECT * FROM vouchers WHERE id = ?',
    // Documented in CLAUDE.md. The bin screen and every restore path need to read a voucher that
    // is deleted; getVoucher returns `deletedAt` and lets the caller decide.
    why: 'getVoucher deliberately reads binned vouchers — the bin and restore depend on it'
  },
  {
    file: 'src/main/services/vouchers.ts',
    contains: 'AS stripped',
    // Documented in CLAUDE.md. A number that a binned voucher used is spent: reissuing it would
    // put two vouchers on the same invoice number the day the first is restored, and GSTR-1
    // Table 13 reports the binned one as a cancelled document in the same series.
    why: 'nextVoucherNumber counts binned vouchers because their numbers are still consumed'
  },
  {
    file: 'src/main/services/gst.ts',
    contains: 'SELECT DISTINCT v.voucher_type_id AS typeId',
    // The function it belongs to says the same thing in a comment above it: a deleted invoice is
    // reported to GSTR-1 as cancelled, not as a gap in the series.
    why: 'GSTR-1 Table 13 reports binned vouchers as cancelled documents, so it must see them'
  },
  {
    file: 'src/main/services/rcm.ts',
    contains: 'SELECT DISTINCT siv.voucher_id AS id',
    // The join exists to read the voucher's date; the question is "which purchases already carry
    // a document". A self-invoice issued to satisfy Rule 46 does not stop having existed because
    // the voucher behind it was later binned, and that combination is exactly what an auditor is
    // looking for. It cannot widen `pending` either — that is rcmSupplies (IN_BOOKS) minus this.
    why: 'an issued self-invoice outlives the voucher it documents, and the auditor asks for that case'
  },
  {
    file: 'src/main/services/rcm.ts',
    contains: 'SELECT party_ledger_id AS id FROM vouchers WHERE id = ?',
    // The id came from rcmSupplies, which is IN_BOOKS-filtered. Same shape as every other entry
    // here: the voucher is already in hand and the question is about that one voucher.
    why: 'a by-id lookup for a voucher a scoped listing already returned'
  },
  {
    file: 'src/main/services/extras.ts',
    contains: 'SELECT COUNT(*) AS n FROM vouchers WHERE currency_code = ?',
    // Counting only live vouchers would let the currency be deleted while a binned voucher still
    // refers to it, and restoring that voucher would then produce an entry in a currency that no
    // longer exists.
    why: 'deleteCurrency refuses while ANY voucher references it, binned ones included'
  },
  {
    file: 'src/main/services/approvals.ts',
    contains: 'SELECT approval_state AS s FROM vouchers WHERE id = ?',
    why: 'applyApprovalGate reads the state of the voucher being saved, by id'
  },
  {
    file: 'src/main/services/approvals.ts',
    contains: '${PENDING_SQL} WHERE v.id = ?',
    // getPending fetches the one voucher a decision is about, by id, and `decide` refuses
    // anything whose state is not 'pending'. A voucher binned while it waited can still be
    // approved through this path, which changes nothing anyone can see: IN_BOOKS drops it for
    // being deleted long before it asks about approval.
    why: 'getPending loads one voucher by id for the approve/reject decision'
  },
  {
    file: 'src/main/services/attachments.ts',
    contains: 'SELECT id FROM vouchers WHERE id = ?',
    why: 'addAttachment checks the voucher exists at all before copying a file in'
  },
  {
    file: 'src/main/services/edocs.ts',
    contains: 'SELECT party_ledger_id AS p FROM vouchers WHERE id = ?',
    why: 'the party of one invoice already selected by a scoped extractor, looked up by id'
  },
  {
    file: 'src/main/services/nic.ts',
    contains: 'SELECT irn FROM vouchers WHERE id = ?',
    why: 'generateIrn reads the IRN of the one voucher the user asked to file'
  },
  {
    file: 'src/main/services/nic.ts',
    contains: 'SELECT irn, ewb_no, vehicle_no, transporter_id, transport_distance FROM vouchers',
    why: 'generateEwbByIrn reads the dispatch details of that same voucher, by id'
  }
]

interface Finding {
  file: string
  line: number
  sql: string
}

/** `const NAME = '…sql…'` — the SQL fragments a file builds its real queries out of. */
function stringConstants(code: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*")/g
  for (const m of code.matchAll(re)) out.set(m[1]!, m[2]!.slice(1, -1))
  return out
}

/** The whole declaration line of `name`, for the cases where the scope lives in a variable
 *  (`const scope = includeOutOfBooks ? NOT_DELETED : IN_BOOKS`, `const conds = [NOT_DELETED]`). */
function declarationText(code: string, name: string): string {
  const m = new RegExp(`(?:const|let|var)\\s+${name}\\b[^\\n]*`).exec(code)
  return m?.[0] ?? ''
}

function scan(): { files: number; sqlStrings: number; voucherReads: number; findings: Finding[] } {
  const findings: Finding[] = []
  let sqlStrings = 0
  let voucherReads = 0
  const files = sourceFiles(MAIN)

  for (const full of files) {
    const rel = relative(ROOT, full).split(sep).join('/')
    const src = readFileSync(full, 'utf8')
    const code = stripComments(src)
    const consts = stringConstants(code)

    for (const literal of code.match(STRING_RE) ?? []) {
      const body = literal.slice(1, -1)

      // Expand one level FIRST: half the real queries in this codebase are `${BASE_SQL} WHERE …`,
      // and the SELECT they run lives in the fragment, not in the string being looked at.
      const expanded = body.replace(/\$\{\s*([A-Za-z_$][\w$]*)\s*\}/g, (all, id: string) =>
        consts.has(id) ? consts.get(id)! : all
      )
      if (!IS_SQL.test(expanded)) continue
      sqlStrings++

      // A fragment — a const that other SQL strings interpolate — is checked where it is used,
      // because that is where the WHERE clause is.
      const asFragment = [...consts].find(([, value]) => value === body)?.[0]
      if (asFragment && new RegExp(`\\$\\{\\s*${asFragment}\\b`).test(code)) continue

      if (!READS_VOUCHERS.test(expanded)) continue
      voucherReads++

      if (IS_WRITE.test(expanded.trim())) continue
      if (SCOPED.test(expanded)) continue

      // The scope may be held in a variable that is interpolated in — check what it was set to.
      const viaVariable = [...expanded.matchAll(/\$\{([^}]*)\}/g)].some((m) =>
        [...m[1]!.matchAll(/[A-Za-z_$][\w$]*/g)].some((id) => SCOPED.test(declarationText(code, id[0])))
      )
      if (viaVariable) continue

      if (ALLOWED.some((a) => a.file === rel && body.includes(a.contains))) continue

      // Line number from the ORIGINAL source, not the comment-stripped copy — a report that
      // points at the wrong line is a report nobody trusts twice.
      const at = src.indexOf(literal)
      const line = (at >= 0 ? src : code).slice(0, at >= 0 ? at : code.indexOf(literal)).split('\n').length
      findings.push({ file: rel, line, sql: expanded.replace(/\s+/g, ' ').trim().slice(0, 160) })
    }
  }
  return { files: files.length, sqlStrings, voucherReads, findings }
}

describe('every voucher query says what it thinks about the bin', () => {
  const result = scan()

  it('actually read the tree', () => {
    // Floors well under today's numbers. A walk that breaks, or an extractor that stops matching
    // template literals, would otherwise leave this file passing while checking nothing.
    expect(result.files).toBeGreaterThan(80)
    expect(result.sqlStrings).toBeGreaterThan(400)
    expect(result.voucherReads).toBeGreaterThan(60)
  })

  it('recognises a scope however it is written', () => {
    expect(SCOPED.test('SELECT 1 FROM vouchers v WHERE ${NOT_DELETED}')).toBe(true)
    expect(SCOPED.test('SELECT 1 FROM vouchers v WHERE ${IN_BOOKS}')).toBe(true)
    expect(SCOPED.test('SELECT 1 FROM vouchers WHERE deleted_at IS NOT NULL')).toBe(true)
    expect(SCOPED.test('SELECT 1 FROM vouchers v WHERE v.date > ?')).toBe(false)
    expect(READS_VOUCHERS.test('JOIN vouchers v ON v.id = vl.voucher_id')).toBe(true)
    expect(READS_VOUCHERS.test('FROM voucher_lines vl')).toBe(false)
  })

  it('finds no unscoped read of vouchers in src/main', () => {
    const report = result.findings.map((f) => `${f.file}:${f.line} — ${f.sql}`)
    expect(report).toEqual([])
  })

  it('has no stale entries in the exception list', () => {
    // An exception that no longer matches any line is an exception nobody is checking.
    for (const a of ALLOWED) {
      const src = readFileSync(join(ROOT, a.file), 'utf8')
      expect(src.includes(a.contains), `${a.file} no longer contains: ${a.contains}`).toBe(true)
      expect(a.why.length).toBeGreaterThan(10)
    }
  })
})
