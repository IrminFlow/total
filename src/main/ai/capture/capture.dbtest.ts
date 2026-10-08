// WP 5.4 — document capture end to end against a real company DB: intake (type / content / same
// file), the runner (one strict extraction call per file, masked text layer, outbound log +
// usage), bill → purchase draft (GSTIN → supplier, HSN + name → items, the editor's GST, the
// printed total compared), the duplicate rules (refused / flagged), questions answered without a
// second call, ledger-line bills, saving the draft (the file becomes the voucher attachment),
// queue persistence (restart / stop / cancel), the capture inbox folder, and statement
// categorisation → drafts → save reconciles the line. Audit rows never carry file content.
import { beforeEach, describe, expect, it } from 'vitest'
import { deflateSync } from 'zlib'
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AiSettings } from '@shared/ai'
import { storedPathFor } from '@shared/attachments'
import { makeTestPdf, FIXTURE_BILL_LINES } from '@shared/capture/pdfFixture.testutil'
import { buildAccountingPayload, derivePartyId, type AccountingFormState, type InvoiceFormState } from '@shared/voucherEdit'
import { fixture, db, ids, ledger, item, typeId, invoiceEditorPayload, INFO, TODAY } from '../drafting.testutil'
import { getVoucher, saveVoucher } from '../../services/vouchers'
import { commitStatement, statementWorkspace } from '../../services/bankImport'
import { listAttachments } from '../../services/attachments'
import { descendantIdsByName } from '../../services/masters'
import { defaultAiSettings } from '../settings'
import { MockProvider } from '../mockProvider'
import { settleDraftOnSave } from '../drafts'
import * as aiStore from '../store'
import { captureMockStep } from './mock'
import { captureFilesDir, captureInboxDir } from './files'
import { passthroughImages } from './prepare'
import { addCaptureFile, getItem, listItems, patchItem, recoverQueue } from './store'
import { CaptureRunner, redraft, type CaptureEnv } from './runner'
import { acceptCategories, categoriseStatement } from './bankCategorise'
import { scanCaptureInbox } from './watcher'
import { estimateCapture } from './estimate'

const deflate = (b: Uint8Array): Uint8Array => new Uint8Array(deflateSync(b))
const pdf = (lines: string[]): Buffer => Buffer.from(makeTestPdf(lines, { deflate }))
// A 1×1 PNG (the content is irrelevant: the mock reads the photo by file name).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const settings = (): AiSettings => ({ ...defaultAiSettings(), enabled: true, noticeAcceptedAt: 'x', noticeVersion: 1, prices: { 'gpt-6.1-sol': { inputPerM: 2_000_000, cachedInputPerM: null, outputPerM: 8_000_000 } } })

let dir: string
let provider: MockProvider
let runner: CaptureRunner
let env: CaptureEnv
let chairId: number
let cabinetId: number

beforeEach(() => {
  fixture()
  dir = mkdtempSync(join(tmpdir(), 'total-capture-'))
  provider = new MockProvider((req) => captureMockStep(req) ?? { text: '{}' })
  runner = new CaptureRunner()
  chairId = item('Office Chair', 18, [0, 0], { hsn: '9401' })
  cabinetId = item('Steel Filing Cabinet', 12, [0, 0], { hsn: '9403' })
  env = {
    db, company: INFO, slug: 'test', filesDir: captureFilesDir(dir), provider: () => provider, settings, blocker: () => null, images: passthroughImages, today: () => TODAY
  }
})

const add = (name: string, bytes: Buffer, origin: 'picker' | 'drop' | 'folder' = 'drop') => addCaptureFile(db, captureFilesDir(dir), { name, bytes, origin, addedBy: 'Arun' })

async function run(ids_: number[]): Promise<void> {
  for (const id of ids_) patchItem(db, id, { status: 'pending', approvedBy: 'Arun' }, true)
  runner.kick(env)
  await runner.idle('test')
}

/** Save a draft the way its editor would, then settle it (voucher:save's transaction). */
function saveDraft(draftId: number): number {
  const d = aiStore.getDraft(db, draftId)!
  return db.transaction(() => {
    let payload
    if (d.payload.form === 'invoice') payload = invoiceEditorPayload(d.payload.state as InvoiceFormState, 'purchase', d.payload.voucherTypeId)
    else {
      const st = d.payload.state as AccountingFormState
      const parties = descendantIdsByName(db, ['Sundry Debtors', 'Sundry Creditors'])
      const isParty = (lid: number): boolean => parties.has((db.prepare('SELECT group_id FROM ledgers WHERE id = ?').get(lid) as { group_id: number }).group_id)
      const built = buildAccountingPayload(st, { kind: d.payload.voucherKind as never, voucherTypeId: d.payload.voucherTypeId, derivedPartyId: derivePartyId(st.rows, isParty, d.payload.partyLedgerId) })
      if (!built.ok) throw new Error(built.error)
      payload = built.payload
    }
    const v = saveVoucher(db, payload as never)
    settleDraftOnSave(db, draftId, v.id, 'voucher', { companyDir: dir })
    return v.id
  })()
}

const auditRows = (entity: string): { action: string; after_json: string | null; before_json: string | null }[] =>
  db.prepare('SELECT action, before_json, after_json FROM audit_log WHERE entity = ? ORDER BY id').all(entity) as never

describe('intake', () => {
  it('checks type by extension AND content, refuses the same file twice, reads pages and the text layer', () => {
    expect(add('bill.exe', PNG).refusal).toMatch(/only PDF, PNG/)
    expect(add('bill.pdf', PNG).refusal).toMatch(/not really a .pdf/)
    expect(add('empty.png', Buffer.alloc(0)).refusal).toMatch(/empty/)
    const a = add('bill.pdf', pdf(FIXTURE_BILL_LINES))
    expect(a.item).toMatchObject({ status: 'queued', pages: 1, textLayer: true, mime: 'application/pdf', origin: 'drop' })
    expect(add('copy.pdf', pdf(FIXTURE_BILL_LINES)).refusal).toMatch(/already in the capture queue \(item #/)
    expect(add('photo.png', PNG).item).toMatchObject({ textLayer: false, mime: 'image/png' })
    const scan = add('scan.pdf', Buffer.from(makeTestPdf([' '], {})))
    expect(scan.item!.textLayer).toBe(false)
    // Audited with metadata only.
    const rows = auditRows('capture_item')
    expect(rows.map((r) => r.action)).toEqual(['create', 'create', 'create'])
    expect(JSON.parse(rows[0]!.after_json!)).toEqual({ fileName: 'bill.pdf', size: a.item!.size, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), path: expect.stringMatching(/^capture\/files\//), origin: 'drop', status: 'queued' })
  })

  it('estimates before sending: pages × the per-page allowance, priced from Settings; unpriced = null', () => {
    const e = estimateCapture([{ mime: 'application/pdf', pages: 2, textLayer: true }, { mime: 'image/png', pages: 1, textLayer: false }], settings().prices['gpt-6.1-sol'])
    expect(e).toMatchObject({ pages: 3, inputTokens: 700 * 2 + 2 * 1200 + 1600, outputTokens: 2400, unmaskable: 1 })
    expect(e.costMicroUsd).toBe(Math.round(((700 * 2 + 2400 + 1600) * 2_000_000 + 2400 * 8_000_000) / 1_000_000))
    expect(estimateCapture([{ mime: 'image/png', pages: 1, textLayer: false }], undefined).costMicroUsd).toBeNull()
  })
})

describe('bill → purchase draft', () => {
  it('sends the MASKED text layer once, strictly; resolves the supplier by GSTIN and items by name + HSN; drafts with the editor’s GST', async () => {
    const { item: it } = add('bharat-0142.pdf', pdf(FIXTURE_BILL_LINES))
    await run([it!.id])
    const after = getItem(db, it!.id)!
    expect(after).toMatchObject({ status: 'drafted', supplierLedgerId: ids.bharat, invoiceNo: 'BSS/2025-26/0142', invoiceDate: '2025-08-12', total: 3_424_000, attempts: 1, error: null })
    // One call, no tools, the strict schema, the text masked (GSTINs never sent in clear).
    expect(provider.requests).toHaveLength(1)
    const req = provider.requests[0]!
    expect(req.tools).toEqual([])
    expect(req.responseFormat?.name).toBe('bill_extraction')
    const sent = JSON.stringify(req.input)
    expect(sent).not.toContain('27AABCG3456H1ZN')
    expect(sent).toContain('[GSTIN …1ZN]')
    const log = aiStore.listOutbound(db)[0]!
    expect(log).toMatchObject({ threadId: null, toolsOffered: [], toolResultsSent: ['capture:bill:text'], masked: true, status: 'ok', payloadSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })
    expect(aiStore.listUsage(db)[0]).toMatchObject({ ok: true, threadId: null, inputTokens: 1400 })
    expect(after.costMicroUsd).toBeGreaterThan(0)
    // The draft: invoice form, the bill's rates, the masters' GST, bill no = the supplier's invoice no.
    const d = aiStore.getDraft(db, after.draftId!)!
    expect(d).toMatchObject({ source: 'capture', origin: 'bharat-0142.pdf', unrequested: false, status: 'open' })
    expect(d.payload).toMatchObject({ form: 'invoice', voucherKind: 'purchase', partyLedgerId: ids.bharat, date: '2025-08-12', total: 3_424_000, captureItemId: it!.id })
    const st = d.payload.state as InvoiceFormState
    expect(st.rows.map((r) => [r.itemId, r.qtyText, r.rate])).toEqual([[chairId, '4', 500_000], [cabinetId, '1', 950_000]])
    expect(st.billName).toBe('BSS/2025-26/0142')
    expect(d.payload.sources!.filter((s) => s.field === 'party').map((s) => s.why)).toEqual(['its GSTIN is 27AABCG3456H1ZN'])
    expect(d.payload.sources!.filter((s) => s.field === 'line:0')).toHaveLength(1)
    expect(after.review!.taxCheck).toEqual({ computed: 474_000, printed: 474_000, computedTotal: 3_424_000, printedTotal: 3_424_000 })
    expect(d.payload.assumptions!.some((a) => /prints GST/.test(a))).toBe(false)
    // Nothing in the books yet.
    expect((db.prepare("SELECT COUNT(*) AS n FROM vouchers v JOIN voucher_types t ON t.id = v.voucher_type_id WHERE t.kind = 'purchase'").get() as { n: number }).n).toBe(0)
  })

  it('a printed GST / total that disagrees is an assumption on the banner, never a correction', async () => {
    const lines = FIXTURE_BILL_LINES.map((l) => (l.startsWith('Total') ? 'Total Rs. 34,250.00' : l.startsWith('CGST') ? 'CGST 9% 1,805.00   CGST 6% 570.00' : l))
    const { item: it } = add('wrong-total.pdf', pdf(lines))
    await run([it!.id])
    const d = aiStore.getDraft(db, getItem(db, it!.id)!.draftId!)!
    expect(d.payload.total).toBe(3_424_000) // the editor's computation
    const text = d.payload.assumptions!.join('\n')
    expect(text).toMatch(/The bill prints GST of ₹4,745.00; the editor's calculation from the masters gives ₹4,740.00/)
    expect(text).toMatch(/The bill's total is ₹34,250.00; this draft totals ₹34,240.00/)
    expect(text).toMatch(/On the bill: CGST .* and SGST .* differ/)
  })

  it('saving the draft books the voucher and attaches the captured file; the same bill again is REFUSED with a link', async () => {
    const { item: it } = add('bharat-0142.pdf', pdf(FIXTURE_BILL_LINES))
    await run([it!.id])
    const vId = saveDraft(getItem(db, it!.id)!.draftId!)
    expect(getItem(db, it!.id)).toMatchObject({ status: 'saved', voucherId: vId })
    const att = listAttachments(db, { entity: 'voucher', entityId: vId })
    expect(att).toHaveLength(1)
    expect(att[0]).toMatchObject({ fileName: 'bharat-0142.pdf', mime: 'application/pdf', sha256: getItem(db, it!.id)!.sha256 })
    expect(existsSync(join(dir, 'attachments', storedPathFor(att[0]!.sha256)))).toBe(true)
    expect(aiStore.getDraft(db, getItem(db, it!.id)!.draftId!)!.status).toBe('consumed')
    expect(getVoucher(db, vId)!.billRefs[0]).toMatchObject({ kind: 'new', name: 'BSS/2025-26/0142', amount: 3_424_000 })

    // A photo of the same bill: same supplier + invoice number in the FY → refused, no draft.
    const { item: photo } = add('bharat-photo.png', PNG)
    await run([photo!.id])
    const p = getItem(db, photo!.id)!
    expect(p).toMatchObject({ status: 'duplicate', duplicateKind: 'same_invoice', duplicateVoucherId: vId, draftId: null })
    expect(p.error).toMatch(/already carries invoice BSS\/2025-26\/0142/)
    expect(aiStore.listOutbound(db)[0]).toMatchObject({ toolResultsSent: ['capture:bill:image'], masked: false })
    expect(JSON.stringify(provider.requests[1]!.input)).toContain('"kind":"image"')
  })

  it('same supplier + amount within 7 days is drafted but flagged with a link to the voucher', async () => {
    const { item: first } = add('a.pdf', pdf(FIXTURE_BILL_LINES))
    await run([first!.id])
    const vId = saveDraft(getItem(db, first!.id)!.draftId!)
    const other = FIXTURE_BILL_LINES.map((l) => l.replace('BSS/2025-26/0142', 'BSS/2025-26/0150').replace('12/08/2025', '15/08/2025'))
    const { item: second } = add('b.pdf', pdf(other))
    await run([second!.id])
    const s = getItem(db, second!.id)!
    expect(s).toMatchObject({ status: 'drafted', duplicateKind: 'same_amount', duplicateVoucherId: vId })
    const d = aiStore.getDraft(db, s.draftId!)!
    expect(d.payload.assumptions!.join('\n')).toMatch(/Possible duplicate: Voucher .* same amount/)
    expect(d.payload.sources!.some((x) => x.kind === 'voucher' && x.id === vId)).toBe(true)
  })

  it('an unknown supplier asks (with a create-party suggestion, never created); the answer drafts without another call', async () => {
    const lines = FIXTURE_BILL_LINES.map((l) => l.replace('Bharat Steel Suppliers', 'Navkar Furniture Works').replace('27AABCG3456H1ZN', '27AAACN1234B1Z5'))
    const { item: it } = add('navkar.pdf', pdf(lines))
    await run([it!.id])
    const r = getItem(db, it!.id)!
    expect(r.status).toBe('needs_review')
    expect(r.review!.questions[0]).toMatchObject({ field: 'supplier', said: 'Navkar Furniture Works' })
    expect(r.review!.suggestedParty).toMatchObject({ name: 'Navkar Furniture Works', gstin: '27AAACN1234B1Z5', stateCode: '27' })
    const before = (db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n
    const navkar = ledger('Navkar Furniture', 'Sundry Creditors', { stateCode: '27' })
    patchItem(db, it!.id, { mapping: { supplierLedgerId: navkar } }, true)
    const done = redraft(env, it!.id, 'Arun')
    expect(done.status).toBe('drafted')
    expect(provider.requests).toHaveLength(1) // answered from the stored extraction
    expect((db.prepare('SELECT COUNT(*) AS n FROM ledgers').get() as { n: number }).n).toBe(before + 1) // only the one the user made
  })

  it('an item whose HSN is shared asks which; a service line can be booked to a ledger (accounting-mode purchase)', async () => {
    const svc = [
      'TAX INVOICE', 'Bharat Steel Suppliers', 'MIDC Bhosari, Pune 411026', 'GSTIN: 27AABCG3456H1ZN', 'Invoice No: BSS/SRV/9    Date: 14/08/2025',
      'Sl  Description            HSN    Qty   Rate       Amount', '1   Welding labour         998873   1     2,000.00   2,000.00', 'CGST 9% 180.00', 'SGST 9% 180.00', 'Total Rs. 2,360.00'
    ]
    const { item: it } = add('service.pdf', pdf(svc))
    await run([it!.id])
    const r = getItem(db, it!.id)!
    expect(r.status).toBe('needs_review')
    expect(r.review!.questions[0]).toMatchObject({ field: 'line:0', ledgerOption: true })
    const labour = ledger('Labour Charges', 'Direct Expenses')
    patchItem(db, it!.id, { mapping: { lines: { '0': { ledgerId: labour } } } }, true)
    const done = redraft(env, it!.id, 'Arun')
    expect(done.status).toBe('drafted')
    const d = aiStore.getDraft(db, done.draftId!)!
    expect(d.payload).toMatchObject({ form: 'accounting', voucherKind: 'purchase', total: 236_000 })
    expect(d.payload.lines).toEqual([
      { ledgerId: labour, drCr: 'dr', amount: 200_000 },
      { ledgerId: ids.cgst, drCr: 'dr', amount: 18_000 },
      { ledgerId: ids.sgst, drCr: 'dr', amount: 18_000 },
      { ledgerId: ids.bharat, drCr: 'cr', amount: 236_000 }
    ])
    expect(d.payload.assumptions!.join('\n')).toMatch(/Labour Charges has no GST rate in its master — 18% taken from the bill/)
    const vId = saveDraft(d.id)
    expect(getVoucher(db, vId)!.billRefs[0]).toMatchObject({ name: 'BSS/SRV/9', amount: 236_000 })
    expect(listAttachments(db, { entity: 'voucher', entityId: vId })).toHaveLength(1)

    // Several fixture items share HSN 8471: an unclear name asks which (only those, by HSN).
    const ambiguous = svc.map((l) => l.replace('Welding labour         998873', 'Computer accessory     8471').replace('BSS/SRV/9', 'BSS/SRV/10'))
    const { item: a } = add('hsn.pdf', pdf(ambiguous))
    await run([a!.id])
    expect(getItem(db, a!.id)!.review!.questions[0]!.candidates.map((c) => c.id).sort((x, y) => x - y)).toEqual([ids.laptop, ids.mouse, ids.rod, ids.chair].sort((x, y) => x - y))
  })

  it('not a bill / unreadable figures fail or warn plainly', async () => {
    const { item: it } = add('menu.pdf', pdf(['Lunch menu', 'Thali 250', 'Dosa 120 and more text to make the layer usable 1234']))
    await run([it!.id])
    expect(getItem(db, it!.id)).toMatchObject({ status: 'failed', error: 'This does not look like a bill' })
  })
})

describe('the queue survives restarts and can be stopped', () => {
  it('processing → pending on open; stop returns approved items to queued; cancel marks one', async () => {
    const a = add('a.pdf', pdf(FIXTURE_BILL_LINES)).item!
    const b = add('b.png', PNG).item!
    patchItem(db, a.id, { status: 'processing' }, false)
    patchItem(db, b.id, { status: 'pending' }, false)
    expect(recoverQueue(db)).toBe(1)
    expect(listItems(db).map((i) => i.status).sort()).toEqual(['pending', 'pending'])
    // Blocked (AI off): nothing is sent, items wait.
    expect(runner.kick({ ...env, blocker: () => 'AI is off' })).toBe(false)
    expect(provider.requests).toHaveLength(0)
    runner.stop('test', db)
    expect(listItems(db).map((i) => i.status)).toEqual(['queued', 'queued'])

    // A slow provider: cancel the item in flight; the run goes on with the next.
    let release: () => void = () => {}
    const slow = new MockProvider((req) => captureMockStep(req)!)
    const gate = new Promise<void>((r) => (release = r))
    const original = slow.chat.bind(slow)
    let calls = 0
    slow.chat = async (req, h) => {
      if (calls++ === 0) {
        await Promise.race([gate, new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('Stopped'))))])
      }
      return original(req, h)
    }
    env.provider = () => slow
    for (const id of [a.id, b.id]) patchItem(db, id, { status: 'pending', approvedBy: 'Arun' }, true)
    runner.kick(env)
    await new Promise((r) => setTimeout(r, 20))
    expect(getItem(db, a.id)!.status).toBe('processing')
    patchItem(db, a.id, { status: 'cancelled' }, true)
    expect(runner.cancelCurrent('test', a.id)).toBe(true)
    await runner.idle('test')
    release()
    expect(getItem(db, a.id)!.status).toBe('cancelled')
    expect(getItem(db, b.id)!.status).toBe('failed') // the 1×1 PNG is not the Bharat photo: "not a bill"
  })
})

describe('the capture inbox folder', () => {
  it('queues dropped files (moved to processed/) and rejects others (failed/ + reason file)', () => {
    const inbox = captureInboxDir(dir)
    require('fs').mkdirSync(inbox, { recursive: true })
    writeFileSync(join(inbox, 'bill.pdf'), pdf(FIXTURE_BILL_LINES))
    writeFileSync(join(inbox, 'notes.txt'), 'hello')
    writeFileSync(join(inbox, '.DS_Store'), 'x')
    const old = new Date(Date.now() - 5000)
    for (const f of ['bill.pdf', 'notes.txt']) utimesSync(join(inbox, f), old, old)
    const out = scanCaptureInbox(db, dir)
    expect(out.map((o) => [o.file, o.ok])).toEqual([['bill.pdf', true], ['notes.txt', false]])
    expect(readdirSync(join(inbox, 'processed'))[0]).toMatch(/-bill\.pdf$/)
    expect(readFileSync(join(inbox, 'failed', 'notes.txt.reason.txt'), 'utf8')).toMatch(/only PDF, PNG/)
    expect(existsSync(join(inbox, '.DS_Store'))).toBe(true)
    expect(listItems(db)[0]).toMatchObject({ origin: 'folder', addedBy: 'capture-inbox', status: 'queued' })
  })
})

describe('bank statement → categorised drafts → save reconciles the line', () => {
  it('history and party names first, the model only for the residual (ids from the candidates); accepted rows draft; saving reconciles', async () => {
    // History: an electricity bill paid from the bank, typed by hand earlier.
    saveVoucher(db, {
      voucherTypeId: typeId('payment'), date: '2025-07-10', partyLedgerId: null, narration: 'ACH/MSEDCL BILL/0052231', reference: null,
      lines: [{ ledgerId: ids.power, drCr: 'dr', amount: 150_000, costAllocations: [] }, { ledgerId: ids.bank, drCr: 'cr', amount: 150_000, costAllocations: [] }]
    } as never)
    // An open sales invoice of Umbrella Retail (receipt allocates oldest bill first).
    saveVoucher(db, {
      voucherTypeId: typeId('sales'), date: '2025-07-20', partyLedgerId: ids.umbrella, narration: null, reference: null,
      lines: [{ ledgerId: ids.umbrella, drCr: 'dr', amount: 500_000, costAllocations: [] }, { ledgerId: ids.sales, drCr: 'cr', amount: 500_000, costAllocations: [] }],
      billRefs: [{ kind: 'new', name: 'S-1', amount: 500_000, dueDate: null }]
    } as never)
    commitStatement(db, ids.bank, {
      fileName: 'stmt.csv',
      text: [
        'Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance',
        '05/08/2025,ACH/MSEDCL BILL/0063311,A1,"1,620.00",,',
        '06/08/2025,NEFT-UMBRELLA RETAIL-UTR99887766,N1,,"5,000.00",',
        '07/08/2025,IMPS/RENT AUG SHOP/998877,I1,"25,000.00",,'
      ].join('\n')
    })
    const cat = await categoriseStatement({ db, provider: () => provider, settings: settings(), today: TODAY }, ids.bank)
    expect(cat.aiUsed).toBe(true)
    const by = (d: string) => cat.rows.find((r) => r.description.startsWith(d))!
    expect(by('ACH')).toMatchObject({ ledgerId: ids.power, kind: 'payment', source: 'history' })
    expect(by('NEFT')).toMatchObject({ ledgerId: ids.umbrella, kind: 'receipt', source: 'party', oldestBillsFirst: true })
    expect(by('IMPS')).toMatchObject({ ledgerId: ids.rent, source: 'ai' })
    // Only the residual line went to the model, with its candidates, never the bank itself.
    const sent = provider.requests.at(-1)!
    expect(sent.responseFormat?.name).toBe('statement_categories')
    expect(JSON.stringify(sent.input)).not.toContain('MSEDCL')
    expect(by('IMPS').candidates.some((c) => c.id === ids.bank)).toBe(false)

    const res = acceptCategories(db, INFO, TODAY, ids.bank, cat.rows.map((r) => ({ lineId: r.lineId, ledgerId: r.ledgerId! })))
    expect(res.failed).toEqual([])
    expect(res.drafts).toHaveLength(3)
    const receipt = aiStore.getDraft(db, res.drafts.find((x) => x.lineId === by('NEFT').lineId)!.draftId)!
    expect(receipt.payload.bankLine).toEqual({ bankLedgerId: ids.bank, statementLineId: by('NEFT').lineId })
    expect(receipt.payload.billRefs).toEqual([{ kind: 'against', name: 'S-1', amount: 500_000, dueDate: null }])
    // One open draft per line.
    expect(acceptCategories(db, INFO, TODAY, ids.bank, [{ lineId: by('NEFT').lineId, ledgerId: ids.umbrella }]).failed[0]!.error).toMatch(/already open/)

    const vId = saveDraft(receipt.id)
    const line = statementWorkspace(db, ids.bank, { includeDone: true }).lines.find((l) => l.id === by('NEFT').lineId)!
    expect(line.status).toBe('matched')
    expect(line.matched[0]).toMatchObject({ voucherId: vId, created: true })
    expect(getVoucher(db, vId)!.lines.find((l) => l.ledgerId === ids.bank)!.bankDate).toBe('2025-08-06')
    expect(auditRows('bank_statement_line').at(-1)!.after_json).toContain('"fromDraft":true')
  })

  it('without AI only the rules run; the residual keeps its candidates', async () => {
    commitStatement(db, ids.bank, { fileName: 's.csv', text: 'Date,Narration,Chq/Ref No,Withdrawal,Deposit,Balance\n05/08/2025,IMPS/SOMETHING/1,X,"10.00",,' })
    const cat = await categoriseStatement({ db, provider: null, settings: null, today: TODAY }, ids.bank)
    expect(cat).toMatchObject({ aiUsed: false, aiNote: expect.stringMatching(/assistant is off/) })
    expect(cat.rows[0]).toMatchObject({ source: 'none', ledgerId: null })
    expect(cat.rows[0]!.candidates.length).toBeGreaterThan(0)
  })
})
