// The agent bridge (lane A): the read-only CSV/JSON mirror under <company>/agent/ and its
// auto-refresh switch. (The inbox drop folder and the MCP server beside it were removed.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setAuditContext } from './audit'
import { getAgentBridgeEnabled, setAgentBridgeEnabled } from './config'
import { agentDir, exportMirror, MIRROR_SCHEMA_VERSION } from './agentBridge'
import { cmdCreateCompany, openCompany } from '../cli/commands'
import type { DB } from '../db/connection'

let dataDir: string
let prevDataDir: string | undefined
let db: DB
let slug: string

beforeAll(() => {
  prevDataDir = process.env.TOTAL_DATA_DIR
  dataDir = mkdtempSync(join(tmpdir(), 'total-agent-bridge-test-'))
  process.env.TOTAL_DATA_DIR = dataDir
  setAuditContext({ appVersion: 'test', getUserName: () => 'app-user' })
  slug = cmdCreateCompany({ name: 'Mirror Co', stateCode: '27', booksFrom: 2025 }).slug
  db = openCompany(slug)
})

afterAll(() => {
  db?.close()
  if (prevDataDir === undefined) delete process.env.TOTAL_DATA_DIR
  else process.env.TOTAL_DATA_DIR = prevDataDir
  rmSync(dataDir, { recursive: true, force: true })
})

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

describe('the read mirror', () => {
  it('writes the masters, reports and meta files under <company>/agent/', () => {
    const r = exportMirror(db, slug, { to: '2025-06-30' })
    expect(r.dir).toBe(agentDir(slug))
    expect(r.files).toEqual(expect.arrayContaining(['ledgers.csv', 'ledgers.json', 'items.csv', 'trial-balance.json', 'outstandings.json', 'meta.json']))
    for (const f of r.files) expect(existsSync(join(r.dir, f))).toBe(true)
    const meta = JSON.parse(readFileSync(join(r.dir, 'meta.json'), 'utf8')) as { schemaVersion: number; company: string; files: string[] }
    expect(meta).toMatchObject({ schemaVersion: MIRROR_SCHEMA_VERSION, company: slug })
    expect(readFileSync(join(r.dir, 'ledgers.csv'), 'utf8').split(/\r?\n/)[0]).toContain('opening_balance_paise')
  })
})
