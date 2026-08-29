import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  pushLayer,
  removeLayer,
  topLayer,
  isBlocked,
  layerCount,
  isTypingTarget,
  isPlainKey,
  __resetLayersForTest
} from '../lib/keyboard'

function key(init: Partial<KeyboardEventInit> & { key: string }, target?: Element): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
  ;(target ?? document.body).dispatchEvent(e)
  return e
}

describe('keyboard layers', () => {
  beforeEach(() => __resetLayersForTest())
  afterEach(() => __resetLayersForTest())

  it('routes a key to the top layer', () => {
    const seen: string[] = []
    pushLayer({ kind: 'nav', handle: () => (seen.push('nav'), true) })
    pushLayer({ kind: 'screen', handle: () => (seen.push('screen'), true) })
    key({ key: 'v' })
    expect(seen).toEqual(['screen'])
  })

  it('falls through a transparent layer that declines', () => {
    const seen: string[] = []
    pushLayer({ kind: 'nav', handle: () => (seen.push('nav'), true) })
    pushLayer({ kind: 'screen', handle: () => (seen.push('screen'), false) })
    key({ key: 'v' })
    expect(seen).toEqual(['screen', 'nav'])
  })

  it('an opaque layer swallows keys it declines', () => {
    const seen: string[] = []
    pushLayer({ kind: 'nav', handle: () => (seen.push('nav'), true) })
    pushLayer({ kind: 'modal', opaque: true, handle: () => (seen.push('modal'), false) })
    key({ key: 'v' })
    expect(seen).toEqual(['modal'])
  })

  it('removing a layer restores the one below it', () => {
    const seen: string[] = []
    pushLayer({ kind: 'nav', handle: () => (seen.push('nav'), true) })
    const id = pushLayer({ kind: 'modal', opaque: true, handle: () => (seen.push('modal'), true) })
    key({ key: 'v' })
    removeLayer(id)
    key({ key: 'v' })
    expect(seen).toEqual(['modal', 'nav'])
  })

  it('ignores an event another handler already claimed', () => {
    const seen: string[] = []
    pushLayer({ kind: 'nav', handle: () => (seen.push('nav'), true) })
    const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    e.preventDefault() // what TypeAhead/DateInput do when they own the key
    document.body.dispatchEvent(e)
    expect(seen).toEqual([])
  })

  it('reproduces the Escape chain: modal wins over the nav layer', () => {
    const seen: string[] = []
    pushLayer({
      kind: 'nav',
      handle: (e) => (e.key === 'Escape' ? (seen.push('nav-back'), true) : false)
    })
    const modal = pushLayer({
      kind: 'modal',
      opaque: true,
      handle: (e) => (e.key === 'Escape' ? (seen.push('modal-close'), true) : false)
    })
    key({ key: 'Escape' })
    removeLayer(modal)
    key({ key: 'Escape' })
    expect(seen).toEqual(['modal-close', 'nav-back'])
  })

  it('topLayer can be filtered by kind so only the topmost list reacts', () => {
    const a = pushLayer({ kind: 'list', handle: () => true })
    expect(topLayer('list')?.id).toBe(a)
    const b = pushLayer({ kind: 'list', handle: () => true })
    expect(topLayer('list')?.id).toBe(b)
    removeLayer(b)
    expect(topLayer('list')?.id).toBe(a)
  })

  it('a list behind a modal is not the top layer even though it is the top list', () => {
    const list = pushLayer({ kind: 'list', handle: () => true })
    pushLayer({ kind: 'modal', opaque: true, handle: () => false })
    expect(topLayer('list')?.id).toBe(list)
    expect(topLayer()?.kind).toBe('modal')
    expect(isBlocked()).toBe(true)
  })

  it('isBlocked tracks opaque layers only', () => {
    expect(isBlocked()).toBe(false)
    const screen = pushLayer({ kind: 'screen', handle: () => false })
    expect(isBlocked()).toBe(false)
    const modal = pushLayer({ kind: 'modal', opaque: true, handle: () => false })
    expect(isBlocked()).toBe(true)
    removeLayer(modal)
    expect(isBlocked()).toBe(false)
    removeLayer(screen)
  })

  it('removing an unknown id is a no-op', () => {
    pushLayer({ kind: 'nav', handle: () => true })
    removeLayer(9999)
    expect(layerCount()).toBe(1)
  })

  it('removes the listener once the last layer goes', () => {
    const id = pushLayer({ kind: 'nav', handle: () => true })
    expect(layerCount()).toBe(1)
    removeLayer(id)
    expect(layerCount()).toBe(0)
    // No layers means nothing to dispatch to; this must not throw.
    expect(() => key({ key: 'v' })).not.toThrow()
  })
})

describe('guards', () => {
  it('isTypingTarget covers every editable target', () => {
    for (const tag of ['input', 'select', 'textarea']) {
      const el = document.createElement(tag)
      document.body.append(el)
      expect(isTypingTarget({ target: el } as unknown as KeyboardEvent), tag).toBe(true)
      el.remove()
    }
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(editable)
    expect(isTypingTarget({ target: editable } as unknown as KeyboardEvent)).toBe(true)
    editable.remove()

    const btn = document.createElement('button')
    expect(isTypingTarget({ target: btn } as unknown as KeyboardEvent)).toBe(false)
  })

  it('isPlainKey rejects anything with a modifier', () => {
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: false } as KeyboardEvent)).toBe(true)
    expect(isPlainKey({ metaKey: true, ctrlKey: false, altKey: false } as KeyboardEvent)).toBe(false)
    expect(isPlainKey({ metaKey: false, ctrlKey: true, altKey: false } as KeyboardEvent)).toBe(false)
    expect(isPlainKey({ metaKey: false, ctrlKey: false, altKey: true } as KeyboardEvent)).toBe(false)
  })
})
