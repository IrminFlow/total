import { describe, expect, it } from 'vitest'
import { createHash } from 'crypto'
import { agentsMdAction, SHIPPED_AGENTS_MD_SHA256 } from './agentsDoc'

describe('AGENTS.md in the data root', () => {
  const current = '# Total — current AGENTS.md\n'

  it('writes a missing file and leaves the current one alone', () => {
    expect(agentsMdAction(null, current)).toBe('write')
    expect(agentsMdAction(current, current)).toBe('keep')
  })

  it('replaces a copy that still equals a shipped version, never a user-edited one', () => {
    const shipped = 'pretend this is the 0.8 file'
    const hash = createHash('sha256').update(shipped, 'utf8').digest('hex')
    ;(SHIPPED_AGENTS_MD_SHA256 as string[]).push(hash)
    try {
      expect(agentsMdAction(shipped, current)).toBe('write')
      expect(agentsMdAction(`${shipped}\nmy own notes`, current)).toBe('write-new')
    } finally {
      ;(SHIPPED_AGENTS_MD_SHA256 as string[]).pop()
    }
  })
})
