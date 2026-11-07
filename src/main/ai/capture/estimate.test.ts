// Phase 3a (review of #210): the capture estimate says up front which queued files the chosen AI
// service can't read.
import { describe, expect, it } from 'vitest'
import { unreadableItems } from './estimate'

const all = { tools: true, structured: true, images: true, files: true }
const photo = { mime: 'image/jpeg', pages: 1, textLayer: false }
const scan = { mime: 'application/pdf', pages: 2, textLayer: false }
const textPdf = { mime: 'application/pdf', pages: 1, textLayer: true }

describe('unreadableItems', () => {
  it('names what fails, and how many', () => {
    expect(unreadableItems([photo, scan, textPdf], all)).toBeNull()
    expect(unreadableItems([], { ...all, structured: false })).toBeNull()
    expect(unreadableItems([photo, textPdf], { ...all, structured: false })).toEqual({ need: 'structured', count: 2 })
    expect(unreadableItems([photo, scan, textPdf], { ...all, images: false, files: false })).toEqual({ need: 'images', count: 2 })
    expect(unreadableItems([photo, scan, textPdf], { ...all, images: false })).toEqual({ need: 'images', count: 1 })
    expect(unreadableItems([scan, textPdf], { ...all, files: false })).toEqual({ need: 'files', count: 1 })
    expect(unreadableItems([textPdf], { ...all, images: false, files: false })).toBeNull()
  })
})
