/**
 * WP 7.3 — keyboard-shortcut labels per platform. Every shortcut handler in the renderer accepts
 * Ctrl as well as ⌘ (`e.metaKey || e.ctrlKey`), but the labels are written the Mac way (⌘K, ⌘↵,
 * ⌥A, ⌘⇧F) in the catalogues and on the accountant screens. On Windows (and Linux) they read as
 * Ctrl+K, Ctrl+Enter, Alt+A, Ctrl+Shift+F. Pure (unit-tested); the renderer applies it to the
 * screen text (lib/platform.ts) so no label anywhere has to be written twice.
 */

/** True when `text` holds a Mac modifier symbol worth rewriting. */
export function hasMacShortcut(text: string): boolean {
  return /[⌘⌥⌃⇧]/.test(text)
}

/** ⌘ → Ctrl+, ⌥ → Alt+, ⌃ → Ctrl+, ⇧ → Shift+ (only inside a shortcut, i.e. right after another
 *  modifier or before a key), and a ↵ that follows a modifier → Enter. Other text is unchanged. */
export function pcShortcutLabels(text: string): string {
  if (!hasMacShortcut(text)) return text
  return text.replace(/[⌘⌥⌃⇧]+(↵|⌫|⎋|.)?/gu, (run: string, key: string | undefined) => {
    const mods = [...(key ? run.slice(0, -key.length) : run)]
    const names: string[] = mods.map((m) => (m === '⌘' || m === '⌃' ? 'Ctrl' : m === '⌥' ? 'Alt' : 'Shift'))
    // Ctrl before Alt before Shift, as Windows writes them (⇧⌘F = Ctrl+Shift+F); no duplicates.
    const order = ['Ctrl', 'Alt', 'Shift'].filter((n) => names.includes(n))
    const k = key === '↵' ? 'Enter' : key === '⌫' ? 'Backspace' : key === '⎋' ? 'Esc' : key
    if (k === undefined || /\s/.test(k)) return `${order.join('+')}${k ?? ''}`
    return `${order.join('+')}+${/^[a-z]$/.test(k) ? k.toUpperCase() : k}`
  })
}
