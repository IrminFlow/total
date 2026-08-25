import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * A custom field can never change a total (roadmap #195).
 *
 * The feature lets a company define its own fields per voucher type. The value of one is text —
 * including for the `number` kind — and it exists so a document can carry a fact the books do not
 * model: a customer's PO number, a site, a dispatch mode.
 *
 * What it must never become is a second, invisible ledger. Money that lands in a custom field is
 * not money: it is not in a ledger, so it is not in the trial balance, so it is not in the return.
 * The day a report sums one, the books and the filing disagree and nothing says why.
 *
 * That rule is a grep rather than a review note, for the same reason `notDeleted.test.ts` is:
 * the mistake is one line, it looks helpful, and it fails silently for a year.
 */

const ROOT = resolve(__dirname, '..', '..')
const SERVICES = join(ROOT, 'src', 'main', 'services')

const isTest = (name: string): boolean => name.endsWith('.test.ts') || name.endsWith('.dbtest.ts')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    if (!name.endsWith('.ts') || name.endsWith('.d.ts') || isTest(name)) return []
    return [full]
  })
}

/**
 * The two files that are allowed to name the values table.
 *
 * `customFields.ts` owns it. `migrations.ts` creates it. Anywhere else means somebody has reached
 * past the service, and the service is where "no arithmetic" is enforced.
 */
const MAY_NAME_THE_TABLE = ['src/main/services/customFields.ts', 'src/main/db/migrations.ts']

/**
 * Services whose whole job is producing a figure somebody files or signs.
 *
 * If one of these ever needs a custom field it is not a reporting change, it is a request to make
 * the field an account — and the answer to that is a ledger, not a column.
 */
const REPORTING = /(report|gst|edocs|analysis|tds|payroll|cma|consolidated|budget|receivable|valuation|filings|disclosure|caPack|capack)/i

describe('custom fields stay out of the arithmetic', () => {
  const files = [...sourceFiles(join(ROOT, 'src', 'main')), ...sourceFiles(join(ROOT, 'src', 'shared'))]

  it('only the owning service and the migration name custom_field_values', () => {
    const offenders = files
      .filter((f) => readFileSync(f, 'utf8').includes('custom_field_values'))
      .map((f) => relative(ROOT, f).split('\\').join('/'))
      .filter((rel) => !MAY_NAME_THE_TABLE.includes(rel))
    expect(offenders).toEqual([])
  })

  it('no report, return or statutory service reads a custom field at all', () => {
    const offenders = files
      .filter((f) => REPORTING.test(relative(SERVICES, f)) && !relative(SERVICES, f).startsWith('..'))
      .filter((f) => {
        const src = readFileSync(f, 'utf8')
        return src.includes('custom_field') || /from '\.\/customFields'/.test(src)
      })
      .map((f) => relative(ROOT, f))
    expect(offenders).toEqual([])
  })

  it('the engine never converts a custom field value to a number', () => {
    // The value is text on purpose. `Number(...)`, `parseFloat` or a `* 100` anywhere in the
    // custom-field engine would be the first step towards it pretending to be paise.
    const engine = readFileSync(join(ROOT, 'src', 'shared', 'customFields.ts'), 'utf8')
    expect(engine).not.toMatch(/parseFloat|parseInt|toPaise|\*\s*100\b/)
  })
})
