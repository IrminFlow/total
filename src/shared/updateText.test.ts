// WP 7.3 — the updater's words and links on macOS vs Windows.
import { describe, expect, it } from 'vitest'
import { dataFolderLabel, downloadUrlFor, updateCheckDisabled } from './updateText'

describe('updateText', () => {
  it('names the data folder the way each platform writes it', () => {
    expect(dataFolderLabel('darwin')).toBe('~/Documents/total')
    expect(dataFolderLabel('win32')).toBe('Documents\\total')
  })
  it('asks /api/download for this platform’s installer, leaving other URLs alone', () => {
    expect(downloadUrlFor('https://devjindal.tech/api/download', 'win32')).toBe('https://devjindal.tech/api/download?platform=win')
    expect(downloadUrlFor('https://devjindal.tech/api/download', 'darwin')).toBe('https://devjindal.tech/api/download?platform=mac')
    expect(downloadUrlFor('https://devjindal.tech/api/download?platform=mac', 'win32')).toBe('https://devjindal.tech/api/download?platform=mac')
    expect(downloadUrlFor('https://github.com/IrminFlow/total/releases/tag/v1', 'win32')).toBe('https://github.com/IrminFlow/total/releases/tag/v1')
    expect(downloadUrlFor('https://devjindal.tech/api/download', 'linux')).toBe('https://devjindal.tech/api/download')
  })
  it('scripted runs turn the startup check off', () => {
    expect(updateCheckDisabled({ TOTAL_NO_UPDATE_CHECK: '1' })).toBe(true)
    expect(updateCheckDisabled({})).toBe(false)
  })
})
