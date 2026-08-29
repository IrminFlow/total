import { describe, it, expect, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { seededDb } from '../db/testdb'
import { createStockItem, deleteStockItem, listStockItems } from './masters'
import {
  clearItemImage,
  getItemImage,
  itemImageDataUrl,
  itemImageDataUrls,
  itemImagePath,
  setItemImage,
  sweepOrphanItemImages
} from './itemImages'
import { companyItemImagesDir } from '../paths'

/**
 * Item images (roadmap E #119), against a real database and a real folder.
 *
 * The rules are unit-tested in `@shared/itemImages`. What matters here is the same thing that
 * matters for attachments: the file is COPIED into the company folder, the row holds the name, and
 * nothing is ever left pointing at a file that is not there.
 */

// A one-pixel PNG, so the bytes really are a picture and the extension is not a lie.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

const roots: string[] = []
function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'total-item-images-'))
  roots.push(dir)
  process.env.TOTAL_DATA_DIR = dir
  return dir
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  delete process.env.TOTAL_DATA_DIR
})

function books() {
  scratchRoot()
  const db = seededDb()
  const unitId = (db.prepare('SELECT id FROM units LIMIT 1').get() as { id: number }).id
  const item = (name: string): number =>
    createStockItem(db, {
      name, unitId, groupId: null, hsn: null, gstRate: null, cessRate: null,
      openingQtyMilli: 0, openingValue: 0, barcode: null, reorderLevelMilli: null
    }).id
  return { db, item, slug: 'demo' }
}

describe('item images', () => {
  it('copies the file in and records the name, never the path', () => {
    const b = books()
    const bolt = b.item('Bolt')
    const image = setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.png' })
    expect(image.storedName).toContain(`${bolt}-`)
    expect(image.storedName.endsWith('bolt.png')).toBe(true)
    expect(existsSync(itemImagePath(b.slug, image.storedName))).toBe(true)
    // The database holds a name, not a path: nothing in it depends on where the user's file was.
    const row = b.db.prepare('SELECT image_name AS n FROM stock_items WHERE id = ?').get(bolt) as { n: string }
    expect(row.n).toBe(image.storedName)
    expect(row.n).not.toContain('/')
  })

  it('surfaces on the item master, so a picker can tell which items have one', () => {
    const b = books()
    const bolt = b.item('Bolt')
    b.item('Nut')
    setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.png' })
    const items = listStockItems(b.db)
    expect(items.find((i) => i.name === 'Bolt')!.imageName).not.toBeNull()
    expect(items.find((i) => i.name === 'Nut')!.imageName).toBeNull()
  })

  it('comes back as a data URL with the right type, because the renderer has no filesystem', () => {
    const b = books()
    const bolt = b.item('Bolt')
    setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.png' })
    const url = itemImageDataUrl(b.db, b.slug, bolt)!
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(itemImageDataUrls(b.db, b.slug, [bolt])[bolt]).toBe(url)
  })

  it('replaces under a NEW name and deletes the old copy', () => {
    // New name, then row, then unlink: at no moment does the row point at a half-written file.
    const b = books()
    const bolt = b.item('Bolt')
    const first = setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'old.png' })
    const second = setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'new.png' })
    expect(second.storedName).not.toBe(first.storedName)
    expect(existsSync(itemImagePath(b.slug, first.storedName))).toBe(false)
    expect(existsSync(itemImagePath(b.slug, second.storedName))).toBe(true)
    expect(readdirSync(companyItemImagesDir(b.slug))).toHaveLength(1)
  })

  it('clearing removes the row first and then the copy', () => {
    const b = books()
    const bolt = b.item('Bolt')
    const image = setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.png' })
    clearItemImage(b.db, b.slug, bolt)
    expect(getItemImage(b.db, b.slug, bolt)).toBeNull()
    expect(existsSync(itemImagePath(b.slug, image.storedName))).toBe(false)
  })

  it('says the file is missing rather than hiding it', () => {
    const b = books()
    const bolt = b.item('Bolt')
    const image = setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.png' })
    rmSync(itemImagePath(b.slug, image.storedName))
    const found = getItemImage(b.db, b.slug, bolt)!
    expect(found.missing).toBe(true)
    // A missing picture is cosmetic; the masters screen must not fail to load because of it.
    expect(itemImageDataUrl(b.db, b.slug, bolt)).toBeNull()
  })

  it('refuses a format a browser cannot paint, and one that is too big', () => {
    const b = books()
    const bolt = b.item('Bolt')
    expect(() => setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.heic' })).toThrow(/not one of them/)
    expect(() =>
      setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: Buffer.alloc(3 * 1024 * 1024), fileName: 'huge.jpg' })
    ).toThrow(/limit is/)
    // And nothing was written on either refusal.
    expect(existsSync(companyItemImagesDir(b.slug)) ? readdirSync(companyItemImagesDir(b.slug)) : []).toEqual([])
  })

  it('refuses an item that does not exist', () => {
    const b = books()
    expect(() => setItemImage(b.db, b.slug, { stockItemId: 9999, bytes: PNG, fileName: 'x.png' })).toThrow(/not found/)
  })

  it('sweeps the copies no item points at any more', () => {
    const b = books()
    const bolt = b.item('Bolt')
    setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: 'bolt.png' })
    // A file nobody ever recorded, and an item deleted out from under its picture.
    writeFileSync(join(companyItemImagesDir(b.slug), 'stray.png'), PNG)
    deleteStockItem(b.db, bolt)
    expect(sweepOrphanItemImages(b.db, b.slug)).toBe(2)
    expect(readdirSync(companyItemImagesDir(b.slug))).toEqual([])
  })

  it('a stored name can never point out of the images folder', () => {
    const b = books()
    const bolt = b.item('Bolt')
    const image = setItemImage(b.db, b.slug, { stockItemId: bolt, bytes: PNG, fileName: '../../escape.png' })
    expect(image.storedName).not.toContain('..')
    expect(itemImagePath(b.slug, image.storedName).startsWith(companyItemImagesDir(b.slug))).toBe(true)
  })
})
