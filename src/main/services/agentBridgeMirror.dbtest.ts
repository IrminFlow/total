import { afterEach, describe, expect, it } from 'vitest'
import {
  existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { seededDb } from '../db/testdb'
import { companyDir, ensureCompanyTree } from '../paths'
import {
  agentDir, exportMirror, MIRROR_SCHEMA_VERSION, verifyMirrorManifest, type MirrorManifestV2
} from './agentBridge'

let root: string | null = null
const slug = 'mirror-v2-books'

function setup() {
  root = mkdtempSync(join(tmpdir(), 'total-mirror-v2-'))
  process.env.TOTAL_DATA_DIR = root
  ensureCompanyTree(slug)
  return seededDb()
}

afterEach(() => {
  delete process.env.TOTAL_DATA_DIR
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

function readMeta(): MirrorManifestV2 {
  return JSON.parse(readFileSync(join(agentDir(slug), 'meta.json'), 'utf8')) as MirrorManifestV2
}

describe('agent mirror manifest v2', () => {
  it('publishes stable IDs, explicit units, schemas and verified byte digests', () => {
    const db = setup()
    const result = exportMirror(db, slug)
    const meta = verifyMirrorManifest(result.dir)

    expect(meta).toMatchObject({
      schema: 'total.agent-mirror',
      schemaVersion: MIRROR_SCHEMA_VERSION,
      company: slug,
      units: {
        amount: { name: 'paise', type: 'integer', scale: 100, currency: 'INR' },
        quantity: { name: 'milli-unit', type: 'integer', scale: 1000 }
      },
      manifest: { algorithm: 'sha256' }
    })
    // v1 readers still receive the same simple file-name array and direct payload paths.
    expect(meta.files).toContain('ledgers.json')
    expect(result.files).toContain('meta.json')
    expect(meta.manifest.files.some((file) => file.path === 'schemas/mirror.schema.json')).toBe(true)
    for (const file of meta.manifest.files) {
      const bytes = readFileSync(join(result.dir, ...file.path.split('/')))
      expect(file.bytes).toBe(bytes.byteLength)
      expect(file.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
      expect(file.id).toMatch(/^total\.mirror\./)
    }
    db.close()
  })

  it('never exposes a partial generation and preserves the prior mirror on failures', () => {
    const db = setup()
    exportMirror(db, slug)
    const original = readFileSync(join(agentDir(slug), 'meta.json'), 'utf8')

    expect(() => exportMirror(db, slug, {}, {
      beforePromote: () => { throw new Error('injected staging failure') }
    })).toThrow('injected staging failure')
    expect(readFileSync(join(agentDir(slug), 'meta.json'), 'utf8')).toBe(original)

    expect(() => exportMirror(db, slug, {}, {
      afterPreviousMoved: () => { throw new Error('injected promotion failure') }
    })).toThrow('injected promotion failure')
    expect(readFileSync(join(agentDir(slug), 'meta.json'), 'utf8')).toBe(original)
    expect(readdirSync(companyDir(slug)).filter((name) => name.startsWith('.agent-'))).toEqual([])
    db.close()
  })

  it('detects tampering and rejects traversal and manifest bounds before reading payloads', () => {
    const db = setup()
    exportMirror(db, slug)
    const ledgerPath = join(agentDir(slug), 'ledgers.json')
    writeFileSync(ledgerPath, `${readFileSync(ledgerPath, 'utf8')}\n`)
    expect(() => verifyMirrorManifest(agentDir(slug))).toThrow(/byte count mismatch|digest mismatch/)

    exportMirror(db, slug)
    const metaPath = join(agentDir(slug), 'meta.json')
    const traversal = readMeta()
    traversal.manifest.files[0]!.path = '../company.db'
    writeFileSync(metaPath, JSON.stringify(traversal))
    expect(() => verifyMirrorManifest(agentDir(slug))).toThrow('Unsafe mirror path')

    exportMirror(db, slug)
    const oversized = readMeta()
    oversized.manifest.files = Array.from({ length: 257 }, () => ({ ...oversized.manifest.files[0]! }))
    writeFileSync(metaPath, JSON.stringify(oversized))
    expect(() => verifyMirrorManifest(agentDir(slug))).toThrow('too many files')
    db.close()
  })

  it('rejects truncated and wrong-schema manifests without reading adjacent company files', () => {
    const db = setup()
    exportMirror(db, slug)
    const databasePath = join(companyDir(slug), 'company.db')
    const sentinel = existsSync(databasePath) ? readFileSync(databasePath) : null
    const metaPath = join(agentDir(slug), 'meta.json')
    writeFileSync(metaPath, '{"schema":"total.agent-mirror"')
    expect(() => verifyMirrorManifest(agentDir(slug))).toThrow()
    writeFileSync(metaPath, JSON.stringify({ schema: 'wrong', schemaVersion: 2, files: [], manifest: { algorithm: 'sha256', files: [] } }))
    expect(() => verifyMirrorManifest(agentDir(slug))).toThrow()
    if (sentinel) expect(readFileSync(databasePath)).toEqual(sentinel)
    db.close()
  })

  it('refuses a symlinked mirror destination instead of writing outside company storage', () => {
    const db = setup()
    const outside = mkdtempSync(join(tmpdir(), 'total-mirror-outside-'))
    symlinkSync(outside, agentDir(slug), 'dir')
    expect(() => exportMirror(db, slug)).toThrow('Mirror storage is not a regular directory')
    expect(existsSync(join(outside, 'meta.json'))).toBe(false)
    expect(lstatSync(agentDir(slug)).isSymbolicLink()).toBe(true)
    rmSync(outside, { recursive: true, force: true })
    db.close()
  })
})
