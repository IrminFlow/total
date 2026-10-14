// WP 10.4 review: every plain date a simple screen, Why sentence or simple service writes names
// its month in the reader's language — the formatters take the language (`t.lang`) and a call
// that leaves it out prints English months inside a Hindi sentence (six such calls were found on
// the Taxes, Withholding and Cash-next-30 screens). Reads the sources with the TypeScript parser.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOTS = [resolve(__dirname, '../../renderer/src/simple'), resolve(__dirname, '../simple'), resolve(__dirname, '../../main/assist')]
/** The argument count that includes the language. */
const NEEDS: Record<string, number> = { toPlainDate: 2, shortDate: 3, toMonthLabel: 3, span: 2 }

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) return files(p)
    return /\.tsx?$/.test(f) && !/\.(db)?test\.tsx?$/.test(f) ? [p] : []
  })
}

describe('plain dates follow the language', () => {
  it('every toPlainDate / shortDate / toMonthLabel / span call in the simple code passes a language', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const file of files(root)) {
        const text = readFileSync(file, 'utf8')
        // Split once per file (WP 7.4: splitting the whole file again for every call expression
        // made this test take > 5 s on a loaded machine).
        const lines = text.split('\n')
        const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && NEEDS[n.expression.text]) {
            const need = NEEDS[n.expression.text]!
            const line = sf.getLineAndCharacterOfPosition(n.getStart()).line
            const technical = lines[line]?.includes('i18n-technical')
            if (n.arguments.length < need && !technical) offenders.push(`${relative(resolve(__dirname, '../..'), file)}:${line + 1} ${n.getText().slice(0, 80)}`)
          }
          ts.forEachChild(n, visit)
        }
        visit(sf)
      }
    }
    expect(offenders).toEqual([])
    // Parses every simple source with the TypeScript compiler: ~1 s idle, > 5 s (vitest's
    // default) on a loaded machine.
  }, 30_000)
})
