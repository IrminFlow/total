import { describe, expect, it } from 'vitest'
import { parseUpdateFeed } from './updateFeed'

describe('update feed contract', () => {
  it('accepts the exact production response shape', () => {
    expect(parseUpdateFeed({ version: '0.5.0', downloadUrl: 'https://total.irminlabs.com/api/download' })).toEqual({
      version: '0.5.0',
      downloadUrl: 'https://total.irminlabs.com/api/download'
    })
  })

  it.each([
    { version: 'latest', downloadUrl: 'https://total.irminlabs.com/api/download' },
    { version: '0.5.0', downloadUrl: 'http://total.irminlabs.com/api/download' },
    { version: '0.5.0', downloadUrl: 'javascript:alert(1)' },
    { version: '0.5.0', downloadUrl: 'https://total.irminlabs.com/api/download', extra: true },
    { downloadUrl: 'https://total.irminlabs.com/api/download' }
  ])('rejects malformed or expanded payloads: %j', (payload) => {
    expect(parseUpdateFeed(payload)).toBeNull()
  })
})
