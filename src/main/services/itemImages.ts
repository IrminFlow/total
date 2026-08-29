import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'fs'
import { randomBytes } from 'crypto'
import { join } from 'path'
import type { DB } from '../db/connection'
import { companyItemImagesDir } from '../paths'
import { safeFileName } from '@shared/attachments'
import { checkItemImage, itemImageMime, storedImageNameFor } from '@shared/itemImages'
import { writeAudit } from './audit'

/**
 * The picture of the item, kept with the books (roadmap E #119).
 *
 * Deliberately the same shape as `attachments.ts` — copy the file into the company folder, store
 * the NAME, never the path and never the bytes — because that pattern already exists here and a
 * second way of keeping a user's file would be a second thing to get wrong at backup, at restore
 * and at "move my data folder".
 *
 * What it does not share with attachments is the table. An attachment is evidence and belongs to a
 * voucher; an item image is master data and belongs to an item, and one image is the whole of it.
 * See src/shared/itemImages.ts for why the format list is narrower.
 */

export interface ItemImage {
  stockItemId: number
  storedName: string
  byteSize: number
  /** The file is not on disk any more — the folder was copied without it, or somebody tidied. */
  missing: boolean
}

export function itemImagePath(slug: string, storedName: string): string {
  return join(companyItemImagesDir(slug), safeFileName(storedName))
}

export function getItemImage(db: DB, slug: string, stockItemId: number): ItemImage | null {
  const row = db.prepare('SELECT image_name AS name FROM stock_items WHERE id = ?').get(stockItemId) as
    | { name: string | null }
    | undefined
  if (!row?.name) return null
  const path = itemImagePath(slug, row.name)
  const missing = !existsSync(path)
  return {
    stockItemId,
    storedName: row.name,
    byteSize: missing ? 0 : statSync(path).size,
    missing
  }
}

export interface SetItemImageInput {
  stockItemId: number
  /** A file on disk to copy in… */
  sourcePath?: string
  /** …or the bytes, which is how a driver script attaches one without a native file dialog. */
  bytes?: Buffer
  fileName: string
}

/**
 * Put a picture on an item, replacing whatever was there.
 *
 * New name first, row second, old file last. That order is the whole point: at no moment does the
 * row point at a file that is half written or gone. Doing it the other way round — overwrite the
 * file at the existing name — means a failed copy leaves the item showing a truncated image with
 * no way to tell that it is one.
 */
export function setItemImage(db: DB, slug: string, input: SetItemImageInput): ItemImage {
  const item = db.prepare('SELECT id, image_name AS imageName FROM stock_items WHERE id = ?').get(input.stockItemId) as
    | { id: number; imageName: string | null }
    | undefined
  if (!item) throw new Error('Stock item not found')

  const bytes = input.bytes ?? null
  if (!bytes && !input.sourcePath) throw new Error('Nothing to attach')
  if (input.sourcePath && !existsSync(input.sourcePath)) throw new Error('That file is no longer there')
  const byteSize = bytes ? bytes.length : statSync(input.sourcePath!).size

  const verdict = checkItemImage({ fileName: input.fileName, byteSize })
  if (!verdict.ok) throw new Error(verdict.message)

  const storedName = storedImageNameFor(item.id, randomBytes(6).toString('hex'), input.fileName)
  const dir = companyItemImagesDir(slug)
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, storedName)
  if (bytes) writeFileSync(dest, bytes)
  else copyFileSync(input.sourcePath!, dest)

  db.prepare('UPDATE stock_items SET image_name = ? WHERE id = ?').run(storedName, item.id)
  if (item.imageName && item.imageName !== storedName) {
    rmSync(itemImagePath(slug, item.imageName), { force: true })
  }
  writeAudit(db, 'item_image', item.id, item.imageName ? 'update' : 'create', item.imageName, storedName)
  return { stockItemId: item.id, storedName, byteSize, missing: false }
}

/** Take the picture off an item: the row first, then the copy, so a failed unlink can never leave
 *  a row pointing at nothing (the reverse would). */
export function clearItemImage(db: DB, slug: string, stockItemId: number): void {
  const row = db.prepare('SELECT image_name AS imageName FROM stock_items WHERE id = ?').get(stockItemId) as
    | { imageName: string | null }
    | undefined
  if (!row) throw new Error('Stock item not found')
  if (!row.imageName) return
  db.prepare('UPDATE stock_items SET image_name = NULL WHERE id = ?').run(stockItemId)
  rmSync(itemImagePath(slug, row.imageName), { force: true })
  writeAudit(db, 'item_image', stockItemId, 'delete', row.imageName, null)
}

/**
 * The picture as a data URL, for an <img> in the renderer.
 *
 * A data URL rather than a `file://` path because the renderer runs with context isolation and no
 * filesystem access at all, which is the security posture this whole app is built on — punching a
 * hole in it to draw a thumbnail would be a poor trade.
 *
 * Null rather than a throw when the file has gone: a missing picture is a cosmetic problem, and a
 * masters screen that fails to load because somebody tidied a folder is not.
 */
export function itemImageDataUrl(db: DB, slug: string, stockItemId: number): string | null {
  const image = getItemImage(db, slug, stockItemId)
  if (!image || image.missing) return null
  const bytes = readFileSync(itemImagePath(slug, image.storedName))
  return `data:${itemImageMime(image.storedName)};base64,${bytes.toString('base64')}`
}

/** Every item that has a picture, as data URLs — one call for a picker or an invoice. Capped,
 *  because a hundred base64 photographs down one IPC message is a frozen window. */
export function itemImageDataUrls(db: DB, slug: string, stockItemIds: number[]): Record<number, string> {
  const out: Record<number, string> = {}
  for (const id of stockItemIds.slice(0, 60)) {
    const url = itemImageDataUrl(db, slug, id)
    if (url) out[id] = url
  }
  return out
}

/**
 * Delete pictures no item points at any more.
 *
 * The same job `sweepOrphanFiles` does for attachments, and needed for the same reason: deleting
 * a stock item takes its row with it and leaves the file behind, and nothing in the database then
 * remembers what the file was.
 */
export function sweepOrphanItemImages(db: DB, slug: string): number {
  const dir = companyItemImagesDir(slug)
  if (!existsSync(dir)) return 0
  const known = new Set(
    (db.prepare('SELECT image_name AS name FROM stock_items WHERE image_name IS NOT NULL').all() as {
      name: string
    }[]).map((r) => r.name)
  )
  let removed = 0
  for (const entry of readdirSync(dir)) {
    if (known.has(entry)) continue
    rmSync(join(dir, entry), { force: true })
    removed++
  }
  return removed
}
