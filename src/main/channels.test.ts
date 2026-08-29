import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative, resolve } from 'path'

/**
 * The two sides of the IPC boundary agree on what the channels are (roadmap Q #332).
 *
 * The roadmap asked for a typed registry generated from one source. This is the same guarantee
 * arrived at the other way round: rather than generating both sides from a third file, the two
 * sides that already exist are checked against each other. The reason is not laziness — a
 * generated registry is a file that every branch touching IPC rewrites, and there are 488
 * channels and several branches in flight at any time. A check has the same failure mode and no
 * merge cost.
 *
 * What it prevents is a real bug that has already happened here twice. A channel name is a
 * STRING on both sides: `api.drafts.get()` calling `'draft:get'` when main registers nothing of
 * that name compiles, typechecks, passes every unit test, and fails at runtime with "No handler
 * registered for total:draft:get" — in front of the user, on the one screen that uses it. It was
 * caught the first time by an E2E scenario and the second time by a different E2E scenario, both
 * of which is luck rather than coverage.
 *
 * Read out of the source with a regex rather than by importing either side, because importing
 * main means importing better-sqlite3, and `npm test` must never do that.
 */

const ROOT = resolve(__dirname, '../..')
const IPC = readFileSync(join(ROOT, 'src/main/ipc.ts'), 'utf8')
const CLIENT = readFileSync(join(ROOT, 'src/renderer/src/lib/client.ts'), 'utf8')

/** Comments stripped, so a channel named in prose is never mistaken for one in code. */
const code = (src: string): string => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

/** `handle('name', …)` — every channel main answers. */
function registered(): Set<string> {
  return new Set([...code(IPC).matchAll(/\bhandle\(\s*'([^']+)'/g)].map((m) => m[1]!))
}

/** `call<T>('name', …)` — every channel the renderer's typed client asks for. */
function calledByClient(): Set<string> {
  return new Set([...code(CLIENT).matchAll(/\bcall<[^>]*>\(\s*'([^']+)'/g)].map((m) => m[1]!))
}

/** Every `'a:b'`-shaped string handed to `invoke(` anywhere in the renderer or the E2E scripts. */
function calledElsewhere(): { channel: string; where: string }[] {
  const dirs = [join(ROOT, 'src/renderer/src'), join(ROOT, 'scripts')]
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) {
        if (name !== 'node_modules') walk(full)
      } else if (/\.(ts|tsx|mjs)$/.test(name) && full !== join(ROOT, 'src/renderer/src/lib/client.ts')) {
        files.push(full)
      }
    }
  }
  dirs.forEach(walk)

  const found: { channel: string; where: string }[] = []
  for (const file of files) {
    for (const m of code(readFileSync(file, 'utf8')).matchAll(/\binvoke\(\s*'([a-z][a-zA-Z0-9]*:[^']+)'/g)) {
      found.push({ channel: m[1]!, where: relative(ROOT, file) })
    }
  }
  return found
}

describe('the IPC channel registry', () => {
  const handlers = registered()
  const client = calledByClient()

  it('found both sides', () => {
    // Floors well under today's numbers, so a regex that stops matching leaves this file failing
    // rather than passing while checking nothing.
    expect(handlers.size).toBeGreaterThan(300)
    expect(client.size).toBeGreaterThan(300)
  })

  it('has a handler for every channel the client calls', () => {
    expect([...client].filter((c) => !handlers.has(c)).sort()).toEqual([])
  })

  it('has a handler for every channel anything else invokes', () => {
    // The E2E scenarios drive the app through `window.total.invoke` directly, which is how they
    // set up state without clicking through six screens — and they are just as able to name a
    // channel that no longer exists.
    const strays = calledElsewhere()
      .filter(({ channel }) => !handlers.has(channel))
      .map(({ channel, where }) => `${where} → ${channel}`)
    expect([...new Set(strays)].sort()).toEqual([])
  })

  it('registers each channel exactly once', () => {
    // A second `handle('x', …)` silently replaces the first in Electron, so the losing
    // implementation is dead code that still reads as live.
    const names = [...code(IPC).matchAll(/\bhandle\(\s*'([^']+)'/g)].map((m) => m[1]!)
    const seen = new Set<string>()
    const twice = names.filter((n) => (seen.has(n) ? true : (seen.add(n), false)))
    expect([...new Set(twice)].sort()).toEqual([])
  })

  it('every channel is named scope:action', () => {
    // The preload validates the shape of a channel name; this validates the convention, which is
    // what makes the 488 of them navigable at all.
    expect([...handlers].filter((c) => !/^[a-z][a-zA-Z0-9]*(:[a-zA-Z0-9]+)+$/.test(c)).sort()).toEqual([])
  })
})
