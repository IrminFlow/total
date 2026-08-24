// Node 25+ exposes an experimental global `localStorage` getter that resolves to undefined unless
// --localstorage-file is supplied. It can shadow jsdom's fully functional storage object, so pin
// renderer tests to the browser implementation explicitly.
const values = new Map<string, string>()
const storage: Storage = {
  get length() { return values.size },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => { values.delete(key) },
  setItem: (key, value) => { values.set(key, String(value)) }
}
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage })
Object.defineProperty(window, 'localStorage', { configurable: true, value: storage })
