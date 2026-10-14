// WP 7.3 — the renderer's view of the desktop platform (from the user agent: synchronous, no IPC)
// and the Windows shortcut labels.
//
// Shortcut handlers already accept Ctrl as well as ⌘; the labels are written the Mac way (⌘K, ⌥A)
// in the catalogues and on the accountant screens. On Windows / Linux `installPcShortcutLabels`
// rewrites them where they are shown — text nodes and the title / aria-label / placeholder
// attributes — as Ctrl+K, Alt+A (shared/shortcutLabels.ts). React never reads text back from the
// DOM, so a re-render simply writes its ⌘ label again and the observer rewrites it again.
import { dataFolderLabel, type DesktopPlatform } from '@shared/updateText'
import { hasMacShortcut, pcShortcutLabels } from '@shared/shortcutLabels'

export function detectPlatform(userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent): DesktopPlatform {
  if (/Windows/i.test(userAgent)) return 'win32'
  if (/Macintosh|Mac OS X/i.test(userAgent)) return 'darwin'
  return 'linux'
}

export const desktopPlatform: DesktopPlatform = detectPlatform()
export const isWindows = desktopPlatform === 'win32'

/** "~/Documents/total" on a Mac, "Documents\total" on Windows. */
export const dataFolder = dataFolderLabel(desktopPlatform)
/** The path separator shown in folder paths. */
export const pathSep = isWindows ? '\\' : '/'

const ATTRS = ['title', 'aria-label', 'placeholder'] as const

function rewriteText(node: Text): void {
  const v = node.nodeValue
  if (v && hasMacShortcut(v)) node.nodeValue = pcShortcutLabels(v)
}

function rewriteElement(el: Element): void {
  for (const a of ATTRS) {
    const v = el.getAttribute(a)
    if (v && hasMacShortcut(v)) el.setAttribute(a, pcShortcutLabels(v))
  }
}

function rewriteTree(root: Node): void {
  if (root.nodeType === Node.TEXT_NODE) return rewriteText(root as Text)
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_NODE) return
  if (root.nodeType === Node.ELEMENT_NODE) rewriteElement(root as Element)
  const doc = root.ownerDocument ?? (root as Document)
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) rewriteText(n as Text)
    else rewriteElement(n as Element)
  }
}

/** Rewrite the Mac shortcut labels under `root` now and whenever they change. Returns a stop
 *  function. A no-op on macOS. */
export function installPcShortcutLabels(root: Node = document.body, platform: DesktopPlatform = desktopPlatform): () => void {
  if (platform === 'darwin' || typeof MutationObserver === 'undefined') return () => {}
  rewriteTree(root)
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'characterData') rewriteText(r.target as Text)
      else if (r.type === 'attributes') rewriteElement(r.target as Element)
      else r.addedNodes.forEach(rewriteTree)
    }
  })
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: [...ATTRS] })
  return () => observer.disconnect()
}
