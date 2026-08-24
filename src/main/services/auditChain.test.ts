import { describe, it, expect } from 'vitest'
import { CHAIN_GENESIS, rowHash, verifyChain, type ChainLink, type ChainedRow } from './auditChain'

function row(id: number, over: Partial<ChainedRow> = {}): ChainedRow {
  return {
    id,
    entity: 'voucher',
    entityId: id,
    action: 'create',
    at: `2026-04-0${id} 10:00:00`,
    beforeJson: null,
    afterJson: `{"amount":${id * 1000}}`,
    userName: 'Asha',
    appVersion: '0.4.0',
    ...over
  }
}

/** Build a well-formed chain of `n` rows, the way writeAudit would. */
function chain(n: number): ChainLink[] {
  const links: ChainLink[] = []
  let prev = CHAIN_GENESIS
  for (let id = 1; id <= n; id++) {
    const r = row(id)
    const hash = rowHash(prev, r)
    links.push({ ...r, prevHash: prev, storedHash: hash })
    prev = hash
  }
  return links
}

const headOf = (links: ChainLink[]): { id: number; hash: string } => {
  const last = links[links.length - 1]!
  return { id: last.id, hash: last.storedHash! }
}

describe('audit hash chain', () => {
  it('verifies a chain nobody has touched', () => {
    const links = chain(5)
    const result = verifyChain(links, headOf(links))
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(5)
    expect(result.problems).toEqual([])
  })

  it('catches a row whose contents were edited', () => {
    const links = chain(5)
    // The edit an interested party actually makes: change what the entry says happened.
    links[2] = { ...links[2]!, afterJson: '{"amount":1}' }
    const result = verifyChain(links, headOf(links))
    expect(result.ok).toBe(false)
    expect(result.problems.map((p) => p.kind)).toContain('altered')
    expect(result.problems[0]!.id).toBe(3)
  })

  it('catches an edit that also rewrites that row own hash', () => {
    const links = chain(5)
    const edited = { ...links[2]!, userName: 'Someone else' }
    links[2] = { ...edited, storedHash: rowHash(edited.prevHash!, edited) }
    const result = verifyChain(links, headOf(links))
    expect(result.ok).toBe(false)
    // Its own hash now checks out, so the break shows up as the next row not following it.
    expect(result.problems.map((p) => p.kind)).toEqual(['broken-link'])
    expect(result.problems[0]!.id).toBe(4)
  })

  it('catches a row deleted out of the middle', () => {
    const links = chain(5)
    const head = headOf(links)
    links.splice(2, 1)
    const result = verifyChain(links, head)
    expect(result.ok).toBe(false)
    expect(result.problems.map((p) => p.kind)).toEqual(['broken-link'])
  })

  it('catches the newest entries being lopped off the end', () => {
    const links = chain(5)
    const head = headOf(links)
    const result = verifyChain(links.slice(0, 3), head)
    expect(result.ok).toBe(false)
    expect(result.problems.map((p) => p.kind)).toEqual(['truncated'])
  })

  it('accepts the oldest entries being pruned, because retention does exactly that', () => {
    const links = chain(5)
    const result = verifyChain(links.slice(2), headOf(links))
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(3)
  })

  it('counts rows written before the chain existed rather than calling them tampering', () => {
    const links = chain(3)
    const legacy: ChainLink[] = [{ ...row(0), prevHash: null, storedHash: null }, ...links]
    const result = verifyChain(legacy, headOf(links))
    expect(result.ok).toBe(true)
    expect(result.unchained).toBe(1)
    expect(result.checked).toBe(3)
  })

  it('distinguishes a null field from an empty one', () => {
    // Otherwise "not signed in" could be swapped for a blank user name without breaking anything.
    const a = rowHash(CHAIN_GENESIS, row(1, { userName: null }))
    const b = rowHash(CHAIN_GENESIS, row(1, { userName: '' }))
    expect(a).not.toBe(b)
  })

  it('calls an unhashed row after chained ones an insertion, not history', () => {
    const links = chain(3)
    const forged: ChainLink = { ...row(4), prevHash: null, storedHash: null }
    const result = verifyChain([...links, forged], headOf(links))
    expect(result.ok).toBe(false)
    expect(result.problems.map((p) => p.kind)).toEqual(['inserted'])
  })

  it('reports the head so the caller can stamp it', () => {
    const links = chain(4)
    const result = verifyChain(links, null)
    expect(result.headId).toBe(4)
    expect(result.headHash).toBe(links[3]!.storedHash)
  })
})
