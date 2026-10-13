// WP 8.2 lint: simple-mode components (src/renderer/src/simple/**) show no raw user-facing
// string — every word goes through t() with a key in a linted namespace (common / simple /
// errors, whose values i18n.test.ts checks for banned words). Uses the TypeScript parser only
// (pure; no renderer import).
//
// Flagged:
//   - JSX text containing a letter;
//   - a string / template literal with a letter inside a JSX expression or a non-technical JSX
//     prop (title, placeholder, label, aria-label, …);
//   - outside JSX, a literal that reads like prose (starts "Xy…", or is ≥ 2 letter-only words) —
//     so a label table can't sneak strings past the lint; mark a genuine technical literal with
//     an `i18n-technical` comment on its line;
//   - a t() key outside common.* / simple.* / errors.*, or not in the en catalogue.
// Allowed: className, data-*, aria-* state attributes, TECHNICAL_PROPS, t() arguments, import
// paths, equality / case comparisons, element-access keys and literal types.
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { en } from './index'

const ROOT = resolve(__dirname, '../../renderer/src/simple')

const TECHNICAL_PROPS = new Set([
  'className',
  'id',
  'key',
  'type',
  'role',
  'name',
  'htmlFor',
  'href',
  'src',
  'rel',
  'target',
  'method',
  'autoComplete',
  'inputMode',
  'enterKeyHint',
  'lang',
  'dir',
  'tabIndex',
  'spellCheck',
  'testId',
  'variant',
  'size',
  'tone',
  'kind',
  'icon',
  'as',
  'align',
  'mode',
  'viewId',
  'screen',
  'width',
  'height',
  'viewBox',
  'fill',
  'stroke',
  'd'
])
// aria-* attributes whose value is read out to the user.
const USER_FACING_ARIA = new Set(['aria-label', 'aria-description', 'aria-placeholder', 'aria-roledescription', 'aria-valuetext'])
const LINTED_NAMESPACES = /^(common|simple|errors)\./

function technicalProp(name: string): boolean {
  if (USER_FACING_ARIA.has(name)) return false
  return TECHNICAL_PROPS.has(name) || name.startsWith('data-') || name.startsWith('aria-')
}

const hasLetter = (s: string): boolean => /\p{L}/u.test(s)
function readsLikeProse(s: string): boolean {
  const text = s.trim()
  if (/^\p{Lu}\p{Ll}/u.test(text)) return true
  const words = text.split(/\s+/)
  return words.length >= 2 && words.every((w) => /^\p{L}+[.,!?…]?$/u.test(w))
}

export interface LintIssue {
  file: string
  line: number
  text: string
  reason: string
}

const EQUALITY = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken
])

export function lintSimpleSource(source: string, file: string): LintIssue[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const lines = source.split('\n')
  const issues: LintIssue[] = []
  const add = (node: ts.Node, text: string, reason: string): void => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line
    if (lines[line]?.includes('i18n-technical')) return
    issues.push({ file, line: line + 1, text: text.trim().slice(0, 80), reason })
  }

  const isTCall = (n: ts.Node): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 't'

  /** Where a literal sits: allowed, in JSX (any letter flagged) or plain code (prose flagged). */
  function context(lit: ts.Node): 'allowed' | 'jsx' | 'code' {
    let child: ts.Node = lit
    let node: ts.Node | undefined = lit.parent
    while (node && !ts.isSourceFile(node)) {
      if (isTCall(node) && node.arguments.includes(child as ts.Expression)) return 'allowed'
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'require') return 'allowed'
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node)) return 'allowed'
      if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) return 'allowed'
      if (ts.isCaseClause(node) && node.expression === child) return 'allowed'
      if (ts.isElementAccessExpression(node) && node.argumentExpression === child) return 'allowed'
      if (ts.isPropertyAssignment(node) && node.name === child) return 'allowed'
      if (ts.isJsxAttribute(node)) return technicalProp(node.name.getText(sf)) ? 'allowed' : 'jsx'
      if (ts.isJsxExpression(node) && !ts.isJsxAttribute(node.parent)) return 'jsx'
      child = node
      node = node.parent
    }
    return 'code'
  }

  function checkLiteral(node: ts.Node, text: string): void {
    if (!hasLetter(text)) return
    const where = context(node)
    if (where === 'jsx') add(node, text, 'raw string in JSX — use t()')
    else if (where === 'code' && readsLikeProse(text)) add(node, text, 'prose string outside t()')
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxText(node)) {
      if (hasLetter(node.text)) add(node, node.text, 'raw JSX text — use t()')
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      checkLiteral(node, node.text)
    } else if (ts.isTemplateExpression(node)) {
      const text = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' ')
      checkLiteral(node, text)
    }
    if (isTCall(node)) {
      const [first] = node.arguments
      if (!first || !ts.isStringLiteralLike(first)) add(node, node.getText(sf), 't() key must be a string literal')
      else if (!LINTED_NAMESPACES.test(first.text)) add(first, first.text, 't() key outside common / simple / errors')
      else if (!(first.text in en)) add(first, first.text, 't() key not in the en catalogue')
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return issues
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return sourceFiles(path)
    return /\.(tsx?|jsx?)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : []
  })
}

describe('simple-mode string lint', () => {
  it('has a target: src/renderer/src/simple has components', () => {
    expect(sourceFiles(ROOT).length).toBeGreaterThan(0)
  })

  it('src/renderer/src/simple/** shows no raw strings and only linted t() keys', () => {
    const issues = sourceFiles(ROOT).flatMap((path) => lintSimpleSource(readFileSync(path, 'utf8'), relative(ROOT, path)))
    expect(issues.map((i) => `${i.file}:${i.line} ${i.reason}: "${i.text}"`)).toEqual([])
  })

  it('catches each kind of violation (self-test)', () => {
    const bad = `
      const LABELS = { cash: 'Paid in cash' }
      export function Bad({ kind }: { kind: string }) {
        return (
          <div className="px-2 text-muted" data-testid="bad" aria-hidden="true" title="Raw title">
            Hello there
            {kind === 'cash' ? 'Cash sale' : t('simple.nav.home')}
            <input placeholder="Type here" aria-label="Amount" />
            {\`Total \${kind}\`}
            {t('voucher.title')}
            {t('simple.nope')}
            <span>·</span>
          </div>
        )
      }`
    const reasons = lintSimpleSource(bad, 'Bad.tsx').map((i) => `${i.line}:${i.reason}`)
    expect(reasons).toEqual([
      '2:prose string outside t()',
      '5:raw string in JSX — use t()',
      '6:raw JSX text — use t()',
      '7:raw string in JSX — use t()',
      '8:raw string in JSX — use t()',
      '8:raw string in JSX — use t()',
      '9:raw string in JSX — use t()',
      '10:t() key outside common / simple / errors',
      '11:t() key not in the en catalogue'
    ])
  })

  it('leaves technical strings alone', () => {
    const ok = `
      import { useT } from '../lib/i18n'
      const base = 'rounded-lg border px-3' // tailwind
      export function Ok({ mode }: { mode: 'a' | 'b' }) {
        const t = useT()
        const id = 'simple-home'
        switch (mode) { case 'a': break }
        return (
          <section className={mode === 'a' ? 'bg-panel' : base} data-testid={id} role="region" aria-live="polite">
            {t('simple.home.title')} · {t('common.bills', { count: 2 })}
          </section>
        )
      }`
    expect(lintSimpleSource(ok, 'Ok.tsx')).toEqual([])
  })
})
