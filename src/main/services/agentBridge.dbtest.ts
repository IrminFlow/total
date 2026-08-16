// Inbox drop-folder semantics: valid voucher JSON posts (audited as 'agent-inbox') and moves to
// processed/; invalid drops move to failed/ with an .error.txt; multi-voucher files are atomic.
// The fs.watch wiring itself isn't timing-tested here — scanInbox/processInboxFile ARE the watcher
// callback body, so this covers the whole pipeline deterministically.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setAuditContext } from './audit'
import { getAgentBridgeEnabled, setAgentBridgeEnabled } from './config'
import { inboxDir, processInboxFile, scanInbox } from './agentBridge'
import { cmdCreateCompany, openCompany } from '../cli/commands'
import type { DB } from '../db/connection'

let dataDir: string
let prevDataDir: string | undefined
let db: DB
let slug: string
let inbox: string

function ledgerId(name: string): number {
  const row = db.prepare('SELECT id FROM ledgers WHERE name = ?').get(name) as { id: number } | undefined
  if (!row) throw new Error(`ledger ${name} missing`)
  return row.id
}

function voucherCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM vouchers WHERE deleted_at IS NULL').get() as { n: number }).n
}

beforeAll(() => {
  prevDataDir = process.env.TOTAL_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'total-inbox-test-'))
  process.env.TOTAL_DATA_DIR = dataDir
  // The app's session context — inbox writes must override this per-call with 'agent-inbox'.
  setAuditContext({ appVersion: 'test', getUserName: () => 'app-user' })
  slug = cmdCreateCompany({ name: 'Inbox Co', stateCode: '27', booksFrom: 2025 }).slug
  db = openCompany(slug)
  inbox = inboxDir(slug)
  mkdirSync(inbox, { recursive: true })
  // A revenue ledger to post against.
  const csv = ['Name,Group,Opening Balance', 'Inbox Sales,Sales Accounts,0'].join('\n')
  writeFileSync(join(inbox, 'masters.csv'), csv)
})

afterAll(() => {
  db?.close()
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

function receiptTypeId(): number {
  return (db.prepare("SELECT id FROM voucher_types WHERE kind = 'receipt'").get() as { id: number }).id
}

describe('agent bridge feature flag', () => {
  it('defaults OFF and toggles with an audit trail', () => {
    expect(getAgentBridgeEnabled(db)).toBe(false)
    setAgentBridgeEnabled(db, true)
    expect(getAgentBridgeEnabled(db)).toBe(true)
    setAgentBridgeEnabled(db, false)
    const audit = db
      .prepare("SELECT after_json FROM audit_log WHERE entity = 'company' ORDER BY id DESC LIMIT 1")
      .get() as { after_json: string }
    expect(JSON.parse(audit.after_json)).toEqual({ agentBridge: false })
  })
})

describe('inbox drop processing', () => {
  it('imports a dropped masters CSV (audited as agent-inbox) and moves it to processed/', () => {
    const outcomes = scanInbox(db, slug)
    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({ file: 'masters.csv', ok: true })
    expect(ledgerId('Inbox Sales')).toBeGreaterThan(0)
    expect(existsSync(join(inbox, 'masters.csv'))).toBe(false)
    const processed = readdirSync(join(inbox, 'processed'))
    expect(processed.some((f) => f.endsWith('-masters.csv'))).toBe(true)
    const audit = db
      .prepare("SELECT user_name FROM audit_log WHERE entity = 'ledger' ORDER BY id DESC LIMIT 1")
      .get() as { user_name: string }
    expect(audit.user_name).toBe('agent-inbox')
  })

  it('posts a valid voucher JSON drop and audits it as agent-inbox', () => {
    const file = join(inbox, 'sale.json')
    writeFileSync(
      file,
      JSON.stringify({
        voucherTypeId: receiptTypeId(),
        date: '2025-08-01',
        narration: 'dropped by agent',
        lines: [
          { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 250000 },
          { ledgerId: ledgerId('Inbox Sales'), drCr: 'cr', amount: 250000 }
        ]
      })
    )
    const outcome = processInboxFile(db, slug, file)
    expect(outcome.ok).toBe(true)
    expect(outcome.detail).toContain('posted 1 voucher')
    expect(voucherCount()).toBe(1)
    const audit = db
      .prepare("SELECT user_name FROM audit_log WHERE entity = 'voucher' ORDER BY id DESC LIMIT 1")
      .get() as { user_name: string }
    expect(audit.user_name).toBe('agent-inbox')
    // The app session user is restored after the inbox write.
    db.prepare("SELECT 1").get()
  })

  it('rejects an invalid drop into failed/ with an error file, changing nothing', () => {
    const before = voucherCount()
    const file = join(inbox, 'bad.json')
    writeFileSync(
      file,
      JSON.stringify({
        voucherTypeId: receiptTypeId(),
        date: '2025-08-02',
        lines: [{ ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 100 }] // unbalanced
      })
    )
    const outcome = processInboxFile(db, slug, file)
    expect(outcome.ok).toBe(false)
    expect(voucherCount()).toBe(before)
    expect(existsSync(join(inbox, 'failed', 'bad.json'))).toBe(true)
    const errText = readFileSync(join(inbox, 'failed', 'bad.json.error.txt'), 'utf8')
    expect(errText.toLowerCase()).toMatch(/differ|debit|credit/)
  })

  it('is atomic across a multi-voucher file — one bad voucher rolls back the whole drop', () => {
    const before = voucherCount()
    const good = {
      voucherTypeId: receiptTypeId(),
      date: '2025-08-03',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 5000 },
        { ledgerId: ledgerId('Inbox Sales'), drCr: 'cr', amount: 5000 }
      ]
    }
    const bad = { ...good, lines: [{ ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 5000 }] }
    const file = join(inbox, 'batch.json')
    writeFileSync(file, JSON.stringify([good, good, bad]))
    const outcome = processInboxFile(db, slug, file)
    expect(outcome.ok).toBe(false)
    expect(voucherCount()).toBe(before) // the two good ones rolled back too
  })

  it('rejects malformed JSON and unknown extensions with readable errors', () => {
    const junk = join(inbox, 'junk.json')
    writeFileSync(junk, '{not json')
    expect(processInboxFile(db, slug, junk).ok).toBe(false)

    const txt = join(inbox, 'note.txt')
    writeFileSync(txt, 'hello')
    const outcome = processInboxFile(db, slug, txt)
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('Unsupported file type')
  })

  it('rolls back the WHOLE CSV when any row fails — nothing is applied (v0.3 review F3)', () => {
    const csv = [
      'Name,Group,Opening Balance',
      'Good Ledger A,Sales Accounts,0',
      'Bad Ledger,No Such Group,0',
      'Good Ledger B,Sales Accounts,150000'
    ].join('\n')
    const file = join(inbox, 'partial.csv')
    writeFileSync(file, csv)
    const outcome = processInboxFile(db, slug, file)
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('nothing was applied')
    expect(outcome.detail).toContain('No Such Group')
    // The resolvable rows rolled back too — no half-applied drops, matching what the failure
    // report (and agent-skill/SKILL.md) promises.
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE name IN ('Good Ledger A', 'Good Ledger B')").get() as {
        n: number
      }
    ).n
    expect(n).toBe(0)
    expect(existsSync(join(inbox, 'failed', 'partial.csv'))).toBe(true)
    expect(readFileSync(join(inbox, 'failed', 'partial.csv.error.txt'), 'utf8')).toContain('nothing was applied')
  })

  it('rejects drops over the 5 MB cap with a clear report, without reading them into memory', () => {
    const file = join(inbox, 'huge.json')
    writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1, 0x20))
    const outcome = processInboxFile(db, slug, file)
    expect(outcome.ok).toBe(false)
    expect(outcome.detail).toContain('5 MB')
    expect(existsSync(join(inbox, 'failed', 'huge.json'))).toBe(true)
  })

  it('scanInbox ignores subfolders and non-droppable files', () => {
    // processed/, failed/ and the leftovers from previous tests must not be re-processed.
    const outcomes = scanInbox(db, slug)
    expect(outcomes).toEqual([])
  })
})
