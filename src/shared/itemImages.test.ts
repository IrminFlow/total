import { describe, expect, it } from 'vitest'
import {
  ITEM_IMAGE_MAX_BYTES,
  checkItemImage,
  isAllowedItemImage,
  itemImageMime,
  storedImageNameFor
} from './itemImages'

describe('isAllowedItemImage', () => {
  it('takes what a browser can paint', () => {
    expect(isAllowedItemImage('bolt.jpg')).toBe(true)
    expect(isAllowedItemImage('BOLT.PNG')).toBe(true)
    expect(isAllowedItemImage('bolt.webp')).toBe(true)
  })

  it('refuses HEIC, which an attachment allows and an <img> cannot render', () => {
    // The bug this prevents: a picture that exists, backs up nightly, and draws a broken square.
    expect(isAllowedItemImage('IMG_4021.heic')).toBe(false)
  })

  it('refuses a PDF and anything with no extension at all', () => {
    expect(isAllowedItemImage('catalogue.pdf')).toBe(false)
    expect(isAllowedItemImage('bolt')).toBe(false)
  })
})

describe('checkItemImage', () => {
  it('accepts an ordinary product shot', () => {
    expect(checkItemImage({ fileName: 'bolt.jpg', byteSize: 180_000 })).toEqual({ ok: true })
  })

  it('refuses the wrong type by name, and says the file name back', () => {
    const v = checkItemImage({ fileName: 'catalogue.pdf', byteSize: 1000 })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('type')
      expect(v.message).toContain('catalogue.pdf')
    }
  })

  it('refuses an empty file and one over the cap, in bytes a person reads', () => {
    expect(checkItemImage({ fileName: 'bolt.jpg', byteSize: 0 }).ok).toBe(false)
    const v = checkItemImage({ fileName: 'bolt.jpg', byteSize: ITEM_IMAGE_MAX_BYTES + 1 })
    expect(v.ok).toBe(false)
    if (!v.ok) {
      expect(v.reason).toBe('size')
      expect(v.message).toContain('2.0 MB')
    }
  })

  it('accepts a file exactly at the cap', () => {
    expect(checkItemImage({ fileName: 'bolt.jpg', byteSize: ITEM_IMAGE_MAX_BYTES }).ok).toBe(true)
  })
})

describe('storedImageNameFor', () => {
  it('leads with the item id so the folder is readable without the app', () => {
    expect(storedImageNameFor(42, 'ab12cd', 'bolt.jpg')).toBe('42-ab12cd-bolt.jpg')
  })

  it('cannot be made to point out of the images folder', () => {
    const name = storedImageNameFor(1, 'tok', '../../../etc/passwd.png')
    expect(name).not.toContain('/')
    expect(name).not.toContain('..')
  })

  it('survives a token that is not hex', () => {
    expect(storedImageNameFor(1, '../x', 'a.png')).toBe('1-x-a.png')
    expect(storedImageNameFor(1, '', 'a.png')).toBe('1-0-a.png')
  })
})

describe('itemImageMime', () => {
  it('says what the bytes are, so Chromium has something to decode with', () => {
    expect(itemImageMime('bolt.png')).toBe('image/png')
    expect(itemImageMime('bolt.webp')).toBe('image/webp')
    expect(itemImageMime('bolt.gif')).toBe('image/gif')
    expect(itemImageMime('bolt.jpg')).toBe('image/jpeg')
    expect(itemImageMime('bolt.jpeg')).toBe('image/jpeg')
  })
})
