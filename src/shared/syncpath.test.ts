import { describe, it, expect } from 'vitest'
import { syncFolderWarning } from './syncpath'

describe('syncFolderWarning', () => {
  it('flags a Dropbox path', () => {
    expect(syncFolderWarning('/Users/x/Dropbox/total')).toBe('dropbox')
  })

  it('flags an iCloud Mobile Documents path', () => {
    expect(syncFolderWarning('/Users/x/Library/Mobile Documents/com~apple~CloudDocs/x')).toBe(
      'mobile documents'
    )
  })

  it('flags a OneDrive path', () => {
    expect(syncFolderWarning('/data/OneDrive/books')).toBe('onedrive')
  })

  it('does not flag a plain Documents path', () => {
    expect(syncFolderWarning('/Users/x/Documents/total')).toBeNull()
  })

  it('does not flag an unrelated path containing "totally"', () => {
    expect(syncFolderWarning('/home/user/totally-fine')).toBeNull()
  })
})
