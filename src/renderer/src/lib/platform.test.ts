// WP 7.3 — the Windows shortcut labels are applied to what the screen shows, and follow re-renders.
import { describe, expect, it } from 'vitest'
import { detectPlatform, installPcShortcutLabels } from './platform'

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('detectPlatform', () => {
  it('reads Electron user agents', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Total/0.11.0 Chrome/140 Electron/38')).toBe('win32')
    expect(detectPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Electron/38')).toBe('darwin')
    expect(detectPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('linux')
  })
})

describe('installPcShortcutLabels', () => {
  it('rewrites text and attributes now, on insert and on change; macOS is left alone', async () => {
    const root = document.createElement('div')
    root.innerHTML = '<button title="Save (⌘↵)" aria-label="Search ⌘K">Save ⌘↵</button><input placeholder="Search ⌘K" />'
    const stop = installPcShortcutLabels(root, 'win32')
    const btn = root.querySelector('button')!
    expect(btn.textContent).toBe('Save Ctrl+Enter')
    expect(btn.getAttribute('title')).toBe('Save (Ctrl+Enter)')
    expect(btn.getAttribute('aria-label')).toBe('Search Ctrl+K')
    expect(root.querySelector('input')!.getAttribute('placeholder')).toBe('Search Ctrl+K')

    const p = document.createElement('p')
    p.textContent = 'Against invoice (⌥A)'
    root.appendChild(p)
    btn.firstChild!.nodeValue = 'Open ⌘J'
    btn.setAttribute('title', '⌘⇧F')
    await flush()
    expect(p.textContent).toBe('Against invoice (Alt+A)')
    expect(btn.textContent).toBe('Open Ctrl+J')
    expect(btn.getAttribute('title')).toBe('Ctrl+Shift+F')
    stop()

    const mac = document.createElement('div')
    mac.textContent = 'Save ⌘↵'
    installPcShortcutLabels(mac, 'darwin')()
    expect(mac.textContent).toBe('Save ⌘↵')
  })
})
