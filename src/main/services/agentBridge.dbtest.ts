// Inbox drop-folder semantics: valid voucher JSON creates inert review proposals and moves to
// processed/; invalid drops move to failed/ with an .error.txt; multi-voucher files are atomic.
// The fs.watch wiring itself isn't timing-tested here — scanInbox/processInboxFile ARE the watcher
// callback body, so this covers the whole pipeline deterministically.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { setAuditContext } from './audit'
import { getAgentBridgeEnabled, setAgentBridgeEnabled } from './config'
import { approveProposal, createProposal, discardProposal, inboxDir, listProposals, processInboxFile, scanInbox } from './agentBridge'
import { cmdCreateCompany, openCompany } from '../cli/commands'
import type { DB } from '../db/connection'
import { companyDir } from '../paths'
import { saveDiscountPolicy } from './discountAuthority'
import { listApprovalRequests, setApprovalPolicy } from './approvals'
import { saveUser } from './users'

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

  it('turns a valid voucher JSON drop into an inert review proposal', () => {
    const before = voucherCount()
    const voucherAuditsBefore = (db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE entity='voucher'"
    ).get() as { n: number }).n
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
    expect(outcome.detail).toContain('queued 1 voucher proposal')
    expect(voucherCount()).toBe(before)
    expect(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity='voucher'").get())
      .toEqual({ n: voucherAuditsBefore })
    const proposal = listProposals(slug).find((row) => row.source === 'external')
    expect(proposal).toMatchObject({ status: 'pending', source: 'external' })
    discardProposal(slug, proposal!.id)
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
    const proposalsBefore = listProposals(slug).length
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
    expect(voucherCount()).toBe(before)
    expect(listProposals(slug)).toHaveLength(proposalsBefore)
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

describe('agent proposal review queue', () => {
  const draft = () => ({
    voucherTypeId: receiptTypeId(),
    date: '2025-09-01',
    lines: [
      { ledgerId: ledgerId('Cash'), drCr: 'dr' as const, amount: 7700 },
      { ledgerId: ledgerId('Inbox Sales'), drCr: 'cr' as const, amount: 7700 }
    ]
  })

  it('keeps a draft inert until an accountant explicitly approves it', () => {
    const before = voucherCount()
    const proposal = createProposal(slug, 'mcp', '₹77 cash receipt', draft())
    expect(voucherCount()).toBe(before)
    expect(listProposals(slug).map((p) => p.id)).toContain(proposal.id)
    const saved = approveProposal(db, slug, proposal.id, null)
    expect(saved.approvalRequired).toBe(false)
    if (saved.approvalRequired) throw new Error('Unexpected approval request')
    expect(saved.id).toBeGreaterThan(0)
    expect(voucherCount()).toBe(before + 1)
    expect(listProposals(slug).map((p) => p.id)).not.toContain(proposal.id)
    const audit = db.prepare("SELECT user_name FROM audit_log WHERE entity = 'voucher' ORDER BY id DESC LIMIT 1").get() as { user_name: string }
    expect(audit.user_name).toBe('agent-mcp')
  })

  it('rolls posting back when the durable proposal result cannot be recorded', () => {
    const before = voucherCount()
    const proposal = createProposal(slug, 'ai', 'Injected result-ledger failure', draft())
    db.exec(`CREATE TRIGGER fail_agent_proposal_result
      BEFORE INSERT ON agent_proposal_results
      BEGIN SELECT RAISE(ABORT, 'injected proposal result failure'); END`)

    expect(() => approveProposal(db, slug, proposal.id, null))
      .toThrow(/injected proposal result failure/)
    expect(voucherCount()).toBe(before)
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_proposal_results WHERE proposal_id=?').get(proposal.id))
      .toEqual({ n: 0 })
    expect(listProposals(slug).map((row) => row.id)).toContain(proposal.id)

    db.exec('DROP TRIGGER fail_agent_proposal_result')
    const retry = approveProposal(db, slug, proposal.id, null)
    expect(retry.approvalRequired).toBe(false)
    expect(voucherCount()).toBe(before + 1)
  })

  it('returns the same posted voucher after archival failure instead of posting twice', () => {
    const before = voucherCount()
    const proposal = createProposal(slug, 'mcp', 'Archive failure replay', draft())
    const reviewed = join(companyDir(slug), 'proposals', 'reviewed')
    rmSync(reviewed, { recursive: true, force: true })
    writeFileSync(reviewed, 'blocks reviewed directory creation')

    expect(() => approveProposal(db, slug, proposal.id, null)).toThrow()
    expect(voucherCount()).toBe(before + 1)
    expect(listProposals(slug).map((row) => row.id)).toContain(proposal.id)
    const durable = db.prepare(
      `SELECT result_kind AS resultKind,result_id AS resultId
       FROM agent_proposal_results WHERE proposal_id=?`
    ).get(proposal.id) as { resultKind: string; resultId: number }
    expect(durable.resultKind).toBe('voucher')

    rmSync(reviewed)
    const retry = approveProposal(db, slug, proposal.id, null)
    expect(retry.approvalRequired).toBe(false)
    if (retry.approvalRequired) throw new Error('Unexpected approval request')
    expect(retry.id).toBe(durable.resultId)
    expect(voucherCount()).toBe(before + 1)
    expect(listProposals(slug).map((row) => row.id)).not.toContain(proposal.id)

    // A client retry after the file has already moved still resolves from the durable ledger.
    const afterMoveRetry = approveProposal(db, slug, proposal.id, null)
    expect(afterMoveRetry.approvalRequired).toBe(false)
    if (afterMoveRetry.approvalRequired) throw new Error('Unexpected approval request')
    expect(afterMoveRetry.id).toBe(durable.resultId)
    expect(voucherCount()).toBe(before + 1)
  })

  it('discards a draft without changing the books', () => {
    const before = voucherCount()
    const proposal = createProposal(slug, 'ai', 'discard me', draft())
    discardProposal(slug, proposal.id)
    expect(voucherCount()).toBe(before)
    expect(listProposals(slug).map((p) => p.id)).not.toContain(proposal.id)
  })

  it('refuses an excessive sales discount and leaves the proposal pending', () => {
    const before = voucherCount()
    const unitId = (db.prepare('SELECT id FROM units ORDER BY id LIMIT 1').get() as { id: number }).id
    const itemId = Number(
      db.prepare("INSERT INTO stock_items(name,unit_id,gst_rate) VALUES('Protected proposal item',?,0)")
        .run(unitId).lastInsertRowid
    )
    saveDiscountPolicy(db, {
      name: 'Agent proposal ceiling',
      scopeKind: 'role',
      role: 'accountant',
      stockItemId: null,
      customerLedgerId: null,
      maxDiscountBps: 500,
      active: true
    }, 'Owner')
    const salesTypeId = (db.prepare("SELECT id FROM voucher_types WHERE kind='sales' LIMIT 1").get() as { id: number }).id
    const proposal = createProposal(slug, 'mcp', 'Discount outside authority', {
      voucherTypeId: salesTypeId,
      date: '2025-09-02',
      lines: [
        { ledgerId: ledgerId('Cash'), drCr: 'dr', amount: 90_000 },
        { ledgerId: ledgerId('Inbox Sales'), drCr: 'cr', amount: 90_000 }
      ],
      inventory: [{
        stockItemId: itemId,
        godownId: null,
        qtyMilli: 2_000,
        ratePaise: 50_000,
        discountPaise: 10_000,
        amount: 90_000,
        direction: 'out'
      }]
    })

    expect(() => approveProposal(db, slug, proposal.id, {
      id: 999,
      name: 'Restricted accountant',
      role: 'accountant'
    })).toThrow('exceeds the 5% authority limit')
    expect(voucherCount()).toBe(before)
    expect(listProposals(slug).map((row) => row.id)).toContain(proposal.id)
    expect(db.prepare(
      "SELECT actor_role AS actorRole, actor_name AS actorName, outcome FROM sales_discount_events ORDER BY id DESC LIMIT 1"
    ).get()).toEqual({ actorRole: 'accountant', actorName: 'Restricted accountant', outcome: 'blocked' })
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_proposal_results WHERE proposal_id=?').get(proposal.id))
      .toEqual({ n: 0 })
  })

  it('routes a controlled proposal into maker-checker once even when archival fails', () => {
    const owner = saveUser(db, { name: 'Proposal owner', role: 'owner', pin: '1357' })
    const maker = saveUser(db, { name: 'Proposal maker', role: 'accountant', pin: '2468' })
    setApprovalPolicy(db, {
      enabled: true,
      thresholdPaise: 1,
      voucherTypeIds: [],
      expenseEnabled: false,
      expenseThresholdPaise: null
    })
    const before = voucherCount()
    const proposal = createProposal(slug, 'ai', 'Controlled receipt', draft())
    const reviewed = join(companyDir(slug), 'proposals', 'reviewed')
    rmSync(reviewed, { recursive: true, force: true })
    writeFileSync(reviewed, 'blocks reviewed directory creation')

    expect(() => approveProposal(db, slug, proposal.id, maker)).toThrow()
    expect(voucherCount()).toBe(before)
    expect(listApprovalRequests(db)).toHaveLength(1)
    const durable = db.prepare(
      `SELECT result_kind AS resultKind,result_id AS resultId
       FROM agent_proposal_results WHERE proposal_id=?`
    ).get(proposal.id) as { resultKind: string; resultId: number }
    expect(durable.resultKind).toBe('approval_request')

    rmSync(reviewed)
    const result = approveProposal(db, slug, proposal.id, maker)

    expect(result.approvalRequired).toBe(true)
    if (!result.approvalRequired) throw new Error('Expected maker-checker handoff')
    expect(voucherCount()).toBe(before)
    expect(result.request).toMatchObject({
      id: durable.resultId,
      status: 'pending',
      makerUserId: maker.id,
      makerName: maker.name,
      postedVoucherId: null
    })
    expect(listApprovalRequests(db)).toHaveLength(1)
    expect(listProposals(slug).map((row) => row.id)).not.toContain(proposal.id)
    expect(owner.role).toBe('owner')
  })
})
