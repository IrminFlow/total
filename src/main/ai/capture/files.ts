// WP 5.4 — where captured files live until their draft is saved: <company>/capture/files/
// <sha256[0:2]>/<sha256> (content-addressed, so the same file dropped twice is stored once), and
// the type policy: an allowed extension AND matching magic bytes, at most CAPTURE_MAX_BYTES.
// Electron-free (the folder is passed in) so dbtests drive it directly.
import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CAPTURE_MAX_BYTES, CAPTURE_TYPES } from '@shared/capture/types'

export const captureRoot = (companyDir: string): string => join(companyDir, 'capture')
export const captureFilesDir = (companyDir: string): string => join(captureRoot(companyDir), 'files')
/** The watched drop folder (like the WP 5.7 agent inbox). */
export const captureInboxDir = (companyDir: string): string => join(companyDir, 'capture-inbox')

export const sha256Of = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

export function extOf(name: string): string {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(name.trim())
  return m ? m[1]!.toLowerCase() : ''
}

/** Cleaned display name: no path parts, no control characters, capped. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name
  // eslint-disable-next-line no-control-regex
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'file'
}

function sniff(b: Uint8Array): string | null {
  const s = (from: number, to: number): string => String.fromCharCode(...b.subarray(from, to))
  if (b.length >= 5 && s(0, 1024).includes('%PDF-')) return 'application/pdf'
  if (b.length >= 8 && b[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 12 && s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && s(4, 8) === 'ftyp' && /^(heic|heix|hevc|heim|heis|mif1|msf1|heif)$/.test(s(8, 12))) return 'image/heic'
  return null
}

/** Why a file cannot be captured (null = it can), and its MIME. */
export function captureRefusal(name: string, bytes: Uint8Array): { refusal: string | null; mime: string } {
  const ext = extOf(name)
  const mime = CAPTURE_TYPES[ext]
  if (!mime) return { refusal: `${cleanName(name)}: only PDF, PNG, JPEG, WEBP and HEIC bills can be captured`, mime: '' }
  if (bytes.length === 0) return { refusal: `${cleanName(name)} is empty`, mime }
  if (bytes.length > CAPTURE_MAX_BYTES) return { refusal: `${cleanName(name)} is ${(bytes.length / 1048576).toFixed(1)} MB — capture takes files up to ${CAPTURE_MAX_BYTES / 1048576} MB`, mime }
  const real = sniff(bytes)
  const family = (m: string): string => (m === 'image/heif' ? 'image/heic' : m)
  if (!real || family(real) !== family(mime)) return { refusal: `${cleanName(name)} is not really a .${ext} file (its content does not match)`, mime }
  return { refusal: null, mime }
}

export const storedRel = (sha: string): string => `${sha.slice(0, 2)}/${sha}`

/** Store the bytes under their hash (atomic: temp + rename); an existing copy is kept. */
export function putCaptureFile(dir: string, bytes: Uint8Array): { sha256: string; rel: string } {
  const sha = sha256Of(bytes)
  const rel = storedRel(sha)
  const abs = join(dir, rel)
  if (existsSync(abs) && sha256Of(readFileSync(abs)) === sha) return { sha256: sha, rel }
  mkdirSync(join(dir, sha.slice(0, 2)), { recursive: true })
  const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`
  try {
    writeFileSync(tmp, bytes, { mode: 0o600 })
    renameSync(tmp, abs)
  } finally {
    rmSync(tmp, { force: true })
  }
  return { sha256: sha, rel }
}

/** The stored bytes, hash-checked (a damaged or missing file throws). */
export function readCaptureFile(dir: string, rel: string, sha: string): Buffer {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(rel) || rel !== storedRel(sha)) throw new Error('Bad capture file path')
  const abs = join(dir, rel)
  if (!existsSync(abs)) throw new Error('The captured file is missing from the capture folder')
  const b = readFileSync(abs)
  if (sha256Of(b) !== sha) throw new Error('The captured file changed on disk since it was queued')
  return b
}

export const captureFilePath = (dir: string, rel: string): string => join(dir, rel)

export function deleteCaptureFile(dir: string, rel: string): void {
  if (!/^[0-9a-f]{2}\/[0-9a-f]{64}$/.test(rel)) return
  try {
    unlinkSync(join(dir, rel))
  } catch {
    /* already gone */
  }
}
