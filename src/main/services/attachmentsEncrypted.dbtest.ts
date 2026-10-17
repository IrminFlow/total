// WP 7.2 follow-up — files under the passphrase lock, end to end through the IPC handlers
// (electron mocked; a scratch TOTAL_DATA_DIR):
//  - lock on → every attachment, every backup copy of one and every captured bill is stored
//    encrypted (`TLF1`), under the same content-addressed name; each still opens with identical
//    bytes and hash; the same file attached twice is still one stored file;
//  - files added while locked are written encrypted;
//  - a crash between the DB swap and the file conversion (or in the middle of it) is finished by
//    the next open (the `.files-converting` marker); leftovers of a half-converted file go;
//  - a plaintext backup's files restored into a locked business come back encrypted;
//  - the .totalbak export carries the DECRYPTED files;
//  - lock off → every file plaintext again, byte-identical;
//  - the renderer never receives a stored path (a viewer opens by id; the reply carries none).
import { afterAll, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'

type Result = { ok: boolean; data?: unknown; error?: string; code?: string; field?: string }
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<Result>>()
const io = vi.hoisted(() => ({ pick: [] as string[], opened: [] as string[] }))

vi.mock('electron', () => ({
  app: { getVersion: () => '0.12.0-test', getPath: () => tmpdir(), isPackaged: false, on: () => {} },
  ipcMain: { handle: (ch: string, fn: (e: unknown, p: unknown) => Promise<Result>) => handlers.set(ch.replace(/^total:/, ''), fn) },
  dialog: {
    showOpenDialog: async () => {
      const filePaths = io.pick
      io.pick = []
      return { canceled: filePaths.length === 0, filePaths }
    },
    showSaveDialog: async () => ({ canceled: true })
  },
  shell: {
    openPath: async (p: string) => {
      io.opened.push(p)
      return ''
    },
    showItemInFolder: () => {},
    openExternal: async () => {}
  },
  Notification: class {},
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false }
}))
vi.mock('../updater', () => ({ checkForUpdatesInteractive: async () => null }))

const DATA_DIR = mkdtempSync(join(tmpdir(), 'total-att-enc-'))
process.env.TOTAL_DATA_DIR = DATA_DIR
process.env.TOTAL_SUPPRESS_SYNC_WARNING = '1'
process.env.TOTAL_INSECURE_TEST_SECRETS = '1'

// WP 7.3: the IPC module is imported at collection, never inside a hook.
const ipc = await import('../ipc')
const crypt = await import('../db/crypt')
const enc = await import('../db/encryption')
const fc = await import('../db/fileCrypto')
ipc.registerIpc()

afterAll(() => {
  ipc.closeCurrentCompany()
  rmSync(DATA_DIR, { recursive: true, force: true })
})

async function call(channel: string, payload?: unknown): Promise<Result> {
  const h = handlers.get(channel)
  if (!h) throw new Error(`no handler ${channel}`)
  return h({}, payload)
}
async function ok<T>(channel: string, payload?: unknown): Promise<T> {
  const r = await call(channel, payload)
  if (!r.ok) throw new Error(`${channel}: ${r.error} (${r.code ?? ''})`)
  return r.data as T
}

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const dir = (slug: string): string => join(DATA_DIR, 'companies', slug)
const stores = (slug: string): string[] => [join(dir(slug), 'attachments'), join(dir(slug), 'backups', 'attachments'), join(dir(slug), 'capture', 'files')]
const PASS = 'monsoon ledger 2026'
const SRC = mkdtempSync(join(tmpdir(), 'total-att-enc-src-'))
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

const FILES = {
  bill: Buffer.from('%PDF-1.4 bill 42 from Bharat Steel — ₹34,240'),
  receipt: Buffer.from('%PDF-1.4 a second document, the courier receipt'),
  late: Buffer.from('%PDF-1.4 attached while the lock is on')
}
function srcFile(name: string, data: Buffer): string {
  const p = join(SRC, name)
  writeFileSync(p, data)
  return p
}

/** Every content-addressed file of the company's three stores, with its form. */
function storedFiles(slug: string): { abs: string; sha: string; form: 'plain' | 'encrypted' }[] {
  return stores(slug).flatMap((s) => fc.storeFiles(s).map((f) => ({ abs: f.abs, sha: f.sha, form: fc.storedForm(f.abs, f.sha) })))
}

async function postReceipt(amount: number): Promise<number> {
  const ledgers = await ok<{ id: number; name: string }[]>('master:ledgers:list')
  const groups = await ok<{ id: number; name: string }[]>('master:groups:list')
  const cash = ledgers.find((l) => l.name === 'Cash')!
  let other = ledgers.find((l) => l.name === 'Counter Sales')
  if (!other) {
    other = await ok('master:ledgers:create', {
      name: 'Counter Sales', groupId: groups.find((g) => g.name === 'Sales Accounts')!.id, openingBalance: 0, gstin: null, stateCode: null, address: null,
      taxType: null, gstRate: null, hsn: null, tdsSectionId: null, pan: null, creditDays: null, exportType: null
    })
  }
  const types = await ok<{ id: number; kind: string }[]>('master:voucherTypes:list')
  const v = await ok<{ id: number }>('voucher:save', {
    data: {
      voucherTypeId: types.find((t) => t.kind === 'receipt')!.id, date: '2026-04-10', partyLedgerId: null, narration: null, reference: null, instrumentNo: null,
      instrumentDate: null, transporterId: null, vehicleNo: null, transportDistanceKm: null, currencyCode: null, exchangeRate: null,
      lines: [
        { ledgerId: cash.id, drCr: 'dr', amount, costAllocations: [] },
        { ledgerId: other!.id, drCr: 'cr', amount, costAllocations: [] }
      ],
      inventory: [], billRefs: [], tds: null
    }
  })
  return v.id
}

async function attach(voucherId: number, name: string, data: Buffer): Promise<{ id: number; sha256: string }> {
  io.pick = [srcFile(name, data)]
  const r = await ok<{ added: { id: number; sha256: string }[]; refused: { reason: string }[] }>('attachments:add', { entity: 'voucher', entityId: voucherId })
  if (r.refused.length) throw new Error(r.refused[0]!.reason)
  return r.added[0]!
}

/** Open an attachment through the IPC and return the bytes the viewer would get. */
async function openBytes(id: number): Promise<Buffer> {
  io.opened = []
  const r = await ok<unknown>('attachments:open', { id })
  expect(r).toBeNull() // never a path back to the renderer
  expect(io.opened).toHaveLength(1)
  return readFileSync(io.opened[0]!)
}

describe('files under the passphrase lock', () => {
  let slug: string
  let v1: number
  let v2: number
  const ids: Record<string, number> = {}

  it('a plaintext business: attachments, their backup copies and a captured bill are stored as they are', async () => {
    slug = (await ok<{ slug: string }>('company:create', {
      name: 'Files Traders', stateCode: '27', gstin: null, gstRegistrationType: 'regular', address: '', booksFrom: 2026, email: null, phone: null, pan: null, tan: null
    })).slug
    await ok('company:open', { slug })
    v1 = await postReceipt(150_000)
    v2 = await postReceipt(20_000)
    ids.bill = (await attach(v1, 'Bill 42.pdf', FILES.bill)).id
    ids.receipt = (await attach(v1, 'courier.pdf', FILES.receipt)).id
    // The same bytes on a second voucher: one stored file, two rows.
    ids.billAgain = (await attach(v2, 'bill copy.pdf', FILES.bill)).id
    const cap = await ok<{ added: number[] }>('capture:addFiles', { files: [{ name: 'photo.png', base64: PNG.toString('base64') }] })
    expect(cap.added).toHaveLength(1)
    await ok('backup:run')
    const files = storedFiles(slug)
    // 2 attachments + their 2 backup copies + 1 captured bill
    expect(files).toHaveLength(5)
    expect(files.every((f) => f.form === 'plain')).toBe(true)
  })

  it('lock on: every stored file is encrypted under the same name, and opens with identical bytes and hash', async () => {
    const on = await ok<{ encrypted: boolean; filesConverted: number; filesFailed: string[] }>('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    expect(on.encrypted).toBe(true)
    expect(on.filesFailed).toEqual([])
    expect(on.filesConverted).toBe(5)
    const files = storedFiles(slug)
    expect(files).toHaveLength(5)
    for (const f of files) {
      expect(f.form).toBe('encrypted')
      const raw = readFileSync(f.abs)
      expect(fc.hasFileHeader(raw)).toBe(true)
      expect(raw.includes(Buffer.from('%PDF'))).toBe(false)
      expect(raw.includes(Buffer.from('PNG'))).toBe(false)
    }
    expect(existsSync(join(dir(slug), '.files-converting'))).toBe(false)
    const bill = await openBytes(ids.bill!)
    expect(bill.equals(FILES.bill)).toBe(true)
    expect(sha(bill)).toBe(sha(FILES.bill))
    expect((await openBytes(ids.billAgain!)).equals(FILES.bill)).toBe(true)
    expect((await openBytes(ids.receipt!)).equals(FILES.receipt)).toBe(true)
    // The captured bill reads back (the capture runner's read) to the same bytes.
    const capFile = join(dir(slug), 'capture', 'files', sha(PNG).slice(0, 2), sha(PNG))
    expect(fc.readStoredBytes(capFile, sha(PNG), enc.keyForPath(dir(slug))).equals(PNG)).toBe(true)
    expect(() => fc.readStoredBytes(capFile, sha(PNG), null)).toThrow(/locked/)
  })

  it('a file attached while locked is written encrypted; the same file again is still one stored file', async () => {
    const late = await attach(v2, 'late.pdf', FILES.late)
    const abs = join(dir(slug), 'attachments', late.sha256.slice(0, 2), late.sha256)
    expect(fc.storedForm(abs, late.sha256)).toBe('encrypted')
    const again = await attach(v1, 'late again.pdf', FILES.late)
    expect(again.sha256).toBe(late.sha256)
    expect(fc.storeFiles(join(dir(slug), 'attachments')).filter((f) => f.sha === late.sha256)).toHaveLength(1)
    expect((await openBytes(again.id)).equals(FILES.late)).toBe(true)
    ids.late = late.id
    // A capture dropped while locked is encrypted too.
    const png2 = Buffer.concat([PNG, Buffer.from('trailing bytes make another file')])
    await ok('capture:addFiles', { files: [{ name: 'photo 2.png', base64: png2.toString('base64') }] })
    const capFile = join(dir(slug), 'capture', 'files', sha(png2).slice(0, 2), sha(png2))
    expect(fc.storedForm(capFile, sha(png2))).toBe('encrypted')
  })

  it('a crash between the DB swap and the file conversion is finished by the next open', async () => {
    await ok('backup:run')
    // The key of the open business, then two files put back to plaintext as an interrupted run
    // would have left them, plus a half-written conversion temp and the marker.
    const k = enc.keyForPath(dir(slug))!
    expect(k).toBeTruthy()
    await ok('company:close')
    const victims = storedFiles(slug).slice(0, 2)
    for (const f of victims) {
      const plain = fc.readStoredBytes(f.abs, f.sha, k)
      writeFileSync(f.abs, plain)
      expect(fc.storedForm(f.abs, f.sha)).toBe('plain')
    }
    writeFileSync(`${storedFiles(slug)[2]!.abs}${fc.CONVERTING_SUFFIX}`, 'half-written plaintext')
    writeFileSync(join(dir(slug), '.files-converting'), JSON.stringify({ to: 'encrypted' }))
    await ok('company:open', { slug, passphrase: PASS })
    expect(storedFiles(slug).every((f) => f.form === 'encrypted')).toBe(true)
    expect(existsSync(join(dir(slug), '.files-converting'))).toBe(false)
    expect(existsSync(`${storedFiles(slug)[2]!.abs}${fc.CONVERTING_SUFFIX}`)).toBe(false)
    expect((await openBytes(ids.bill!)).equals(FILES.bill)).toBe(true)
  })

  it('a plaintext backup’s file restored into a locked business comes back encrypted', async () => {
    // The live copy goes (removed from the record), and the backups' copy is plaintext — as a
    // backup store copied in from before the lock would be.
    const billSha = sha(FILES.late)
    const k = enc.keyForPath(dir(slug))!
    const backupCopy = join(dir(slug), 'backups', 'attachments', billSha.slice(0, 2), billSha)
    expect(existsSync(backupCopy)).toBe(true)
    writeFileSync(backupCopy, fc.readStoredBytes(backupCopy, billSha, k))
    const list = await ok<{ file: string; tag: string }[]>('backup:list')
    const manual = list.find((b) => b.tag === 'manual')!
    const live = join(dir(slug), 'attachments', billSha.slice(0, 2), billSha)
    rmSync(live)
    const restored = await ok<{ attachments: { restored: number; missing: number } }>('backup:restore', { file: manual.file })
    expect(restored.attachments.missing).toBe(0)
    expect(restored.attachments.restored).toBeGreaterThanOrEqual(1)
    expect(fc.storedForm(live, billSha)).toBe('encrypted')
    expect((await openBytes(ids.late!)).equals(FILES.late)).toBe(true)
  })

  it('the .totalbak export carries the decrypted files', async () => {
    const out = await ok<{ path: string }>('backup:exportEncrypted', { passphrase: 'export passphrase 1' })
    const scratch = mkdtempSync(join(tmpdir(), 'total-att-enc-export-'))
    try {
      const snap = join(scratch, 'snap.db')
      await crypt.decryptFile(out.path, snap, 'export passphrase 1')
      const db = enc.openDb(snap, { readonly: true, key: null })
      try {
        const blobs = db.prepare('SELECT sha256, data FROM backup_attachment_blobs').all() as { sha256: string; data: Buffer }[]
        expect(blobs.length).toBeGreaterThanOrEqual(3)
        for (const b of blobs) {
          expect(fc.hasFileHeader(b.data)).toBe(false)
          expect(sha(b.data)).toBe(b.sha256)
        }
      } finally {
        db.close()
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  it('lock off: every stored file is plaintext again, byte-identical', async () => {
    const off = await ok<{ encrypted: boolean; filesFailed: string[]; backupsFailed: string[] }>('security:passphrase:off', { passphrase: PASS })
    expect(off).toMatchObject({ encrypted: false, filesFailed: [], backupsFailed: [] })
    const files = storedFiles(slug)
    expect(files.length).toBeGreaterThanOrEqual(6)
    for (const f of files) {
      expect(f.form).toBe('plain')
      expect(sha(readFileSync(f.abs))).toBe(f.sha)
    }
    expect(existsSync(join(dir(slug), '.files-converting'))).toBe(false)
    expect(existsSync(join(dir(slug), 'company.key.json'))).toBe(false)
    expect((await openBytes(ids.receipt!)).equals(FILES.receipt)).toBe(true)
    // Reopens with no passphrase; new files are plain.
    await ok('company:close')
    await ok('company:open', { slug })
    const extra = await attach(v2, 'after.pdf', Buffer.from('%PDF-1.4 after the lock came off'))
    expect(fc.storedForm(join(dir(slug), 'attachments', extra.sha256.slice(0, 2), extra.sha256), extra.sha256)).toBe('plain')
  })

  it('lock on again after a lock-off that left a file encrypted: the old key is used again when the passphrase opens it; another passphrase is refused', async () => {
    // What a lock-off with `filesFailed` leaves: the key file kept, the marker, one file still
    // encrypted under the OLD key — staged here from a clean lock on / off.
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    const oldKey = Buffer.from(enc.keyForPath(dir(slug))!)
    const envelope = readFileSync(join(dir(slug), 'company.key.json'))
    const victim = storedFiles(slug)[0]!
    expect((await ok<{ filesFailed: string[] }>('security:passphrase:off', { passphrase: PASS })).filesFailed).toEqual([])
    const plain = readFileSync(victim.abs)
    writeFileSync(victim.abs, fc.encryptBytes(plain, oldKey, victim.sha))
    writeFileSync(join(dir(slug), 'company.key.json'), envelope)
    writeFileSync(join(dir(slug), '.files-converting'), JSON.stringify({ to: 'plain' }))
    // A new passphrase would mint a new key and lose that file for good: refused, nothing changed.
    const refused = await call('security:passphrase:on', { passphrase: 'another one', confirm: 'another one' })
    expect(refused).toMatchObject({ ok: false, code: 'security_files_pending', field: 'passphrase' })
    expect(readFileSync(join(dir(slug), 'company.key.json')).equals(envelope)).toBe(true)
    expect(enc.isEncryptedFile(join(dir(slug), 'company.db'))).toBe(false)
    expect(fc.storedForm(victim.abs, victim.sha)).toBe('encrypted')
    // The passphrase the file was locked with: its key is used again, the file opens, nothing pending.
    const on = await ok<{ encrypted: boolean; filesFailed: string[] }>('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    expect(on).toMatchObject({ encrypted: true, filesFailed: [] })
    expect(enc.keyForPath(dir(slug))!.equals(oldKey)).toBe(true)
    expect(existsSync(join(dir(slug), '.files-converting'))).toBe(false)
    expect(storedFiles(slug).every((f) => f.form === 'encrypted')).toBe(true)
    expect(fc.readStoredBytes(victim.abs, victim.sha, oldKey).equals(plain)).toBe(true)
    expect((await ok<{ filesFailed: string[]; backupsFailed: string[] }>('security:passphrase:off', { passphrase: PASS })).filesFailed).toEqual([])
    expect(existsSync(join(dir(slug), 'company.key.json'))).toBe(false)
    expect(storedFiles(slug).every((f) => f.form === 'plain')).toBe(true)
  })

  it('a crash while the lock was coming off (files half decrypted, books still locked) is put back on the next open', async () => {
    await ok('security:passphrase:on', { passphrase: PASS, confirm: PASS })
    const k = enc.keyForPath(dir(slug))!
    await ok('company:close')
    const victim = storedFiles(slug)[0]!
    writeFileSync(victim.abs, fc.readStoredBytes(victim.abs, victim.sha, k))
    mkdirSync(dir(slug), { recursive: true })
    writeFileSync(join(dir(slug), '.files-converting'), JSON.stringify({ to: 'plain' }))
    await ok('company:open', { slug, passphrase: PASS })
    expect(storedFiles(slug).every((f) => f.form === 'encrypted')).toBe(true)
    expect(existsSync(join(dir(slug), '.files-converting'))).toBe(false)
  })

  it('a viewer opens a locked business’s attachment by id; no reply carries a stored path', async () => {
    await ok('users:save', { data: { name: 'Owner', role: 'owner', pin: '1111' } })
    const viewer = await ok<{ id: number }>('users:save', { data: { name: 'Vik', role: 'viewer', pin: '2222' } })
    await ok('auth:logout')
    await ok('auth:login', { userId: viewer.id, pin: '2222' })
    const list = await ok<unknown[]>('attachments:list', { entity: 'voucher', entityId: v1 })
    const capture = await ok<unknown>('capture:list')
    for (const reply of [list, capture]) {
      // (capture:list names the user's own drop folder, never a stored file)
      const text = JSON.stringify(reply)
      expect(text).not.toMatch(/attachments[\\/]+[0-9a-f]{2}[\\/]/)
      expect(text).not.toMatch(/capture[\\/]+files/)
    }
    expect((await openBytes(ids.bill!)).equals(FILES.bill)).toBe(true)
    // …and cannot add or remove one.
    expect((await call('attachments:remove', { id: ids.bill })).ok).toBe(false)
  })
})
