import { describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrate } from './migrate'
import { seedCompany } from './seed'
import { TEST_INFO } from './testdb'

type CrashKind = 'voucher' | 'import' | 'approval' | 'migration'

function fixture(): { dbPath: string; voucherTypeId: number; groupId: number } {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'total-crash-')), 'company.db')
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  seedCompany(db, TEST_INFO)
  db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Maker', 'x', 'accountant')").run()
  db.prepare("INSERT INTO users (name, pin_hash, role) VALUES ('Checker', 'y', 'owner')").run()
  db.prepare(
    `INSERT INTO approval_requests (maker_user_id, maker_name, summary, amount, payload_json)
     VALUES (1, 'Maker', 'Crash fixture', 100, '{}')`
  ).run()
  const voucherTypeId = (db.prepare("SELECT id FROM voucher_types WHERE kind = 'journal'").get() as { id: number }).id
  const groupId = (db.prepare("SELECT id FROM groups WHERE name = 'Sales Accounts'").get() as { id: number }).id
  db.close()
  return { dbPath, voucherTypeId, groupId }
}

function crashMidTransaction(kind: CrashKind, fixtureData: ReturnType<typeof fixture>): Promise<void> {
  const childCode = String.raw`
    const Database = require('better-sqlite3')
    const db = new Database(process.env.CRASH_DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.exec('BEGIN IMMEDIATE')
    const kind = process.env.CRASH_KIND
    if (kind === 'voucher') {
      db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-08-24', 'CRASH-V')").run(Number(process.env.CRASH_VT))
    } else if (kind === 'import') {
      db.prepare("INSERT INTO ledgers (name, group_id) VALUES ('Crash Import Ledger', ?)").run(Number(process.env.CRASH_GROUP))
      db.prepare("INSERT INTO import_batches (kind, source_hash, source_bytes, source_rows, accepted_rows, rejected_rows, summary_json) VALUES ('ledgers', ?, 1, 1, 1, 0, '{}')").run('c'.repeat(64))
    } else if (kind === 'approval') {
      db.prepare("UPDATE approval_requests SET status = 'approved', checker_user_id = 2, checker_name = 'Checker' WHERE id = 1").run()
      db.prepare("INSERT INTO vouchers (voucher_type_id, date, number) VALUES (?, '2026-08-24', 'CRASH-A')").run(Number(process.env.CRASH_VT))
    } else if (kind === 'migration') {
      db.exec('CREATE TABLE crash_partial (id INTEGER PRIMARY KEY)')
      db.prepare("INSERT INTO migrations (id, applied_at) VALUES (999, datetime('now'))").run()
    }
    process.stdout.write('READY\n')
    setInterval(() => {}, 1000)
  `
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childCode], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CRASH_DB_PATH: fixtureData.dbPath,
        CRASH_KIND: kind,
        CRASH_VT: String(fixtureData.voucherTypeId),
        CRASH_GROUP: String(fixtureData.groupId)
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.on('data', (chunk) => {
      if (!chunk.toString().includes('READY')) return
      child.kill('SIGKILL')
    })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== 'SIGKILL') reject(new Error(`crash child exited early (${code}): ${stderr}`))
      else resolve()
    })
  })
}

describe('forced-termination transaction recovery', () => {
  it.each<CrashKind>(['voucher', 'import', 'approval', 'migration'])('%s work is all-or-nothing across SIGKILL', async (kind) => {
    const data = fixture()
    await crashMidTransaction(kind, data)

    const db = new Database(data.dbPath)
    expect(db.pragma('quick_check', { simple: true })).toBe('ok')
    expect(db.prepare("SELECT COUNT(*) AS count FROM vouchers WHERE number LIKE 'CRASH-%'").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM ledgers WHERE name = 'Crash Import Ledger'").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM import_batches WHERE source_hash = ?").get('c'.repeat(64))).toEqual({ count: 0 })
    expect(db.prepare('SELECT status, checker_user_id AS checker FROM approval_requests WHERE id = 1').get()).toEqual({ status: 'pending', checker: null })
    expect(db.prepare("SELECT COUNT(*) AS count FROM migrations WHERE id = 999").get()).toEqual({ count: 0 })
    expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'crash_partial'").get()).toEqual({ count: 0 })
    db.close()
  })
})
