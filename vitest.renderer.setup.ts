/**
 * Renderer test setup.
 *
 * Node 26 exposes `localStorage` on `globalThis` (as `undefined`, unless the process was
 * started with `--localstorage-file`). Vitest's jsdom environment copies window properties
 * onto the global with the rule "skip anything already present on the global unless it is on
 * vitest's own key list" — and `localStorage` is on neither list. The result is that jsdom's
 * real Storage is dropped and Node's undefined one wins, so `localStorage.getItem` throws for
 * every module that touches it at import time (state/stores.ts, lib/reportConfig.ts).
 *
 * Install a spec-shaped in-memory Storage before any test module loads. Each test file gets a
 * fresh jsdom global, so state never leaks between files.
 */
class MemoryStorage implements Storage {
  private map = new Map<string, string>()

  get length(): number {
    return this.map.size
  }

  clear(): void {
    this.map.clear()
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? (this.map.get(key) as string) : null
  }

  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.map.delete(key)
  }

  setItem(key: string, value: string): void {
    this.map.set(key, String(value))
  }
}

function install(name: 'localStorage' | 'sessionStorage'): void {
  const existing = (globalThis as Record<string, unknown>)[name]
  if (existing && typeof (existing as Storage).getItem === 'function') return
  Object.defineProperty(globalThis, name, {
    value: new MemoryStorage(),
    configurable: true,
    writable: true
  })
}

install('localStorage')
install('sessionStorage')
