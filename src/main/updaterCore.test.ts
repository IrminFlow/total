import { describe, expect, it, vi } from 'vitest'
import { createUpdater, type UpdateEngine, type UpdaterDeps } from './updaterCore'
import type { UpdateNotice, UpdateSettings } from '@shared/updates'

type Listener = (arg: never) => void

function setup(opts: { settings?: Partial<UpdateSettings>; latest?: { version: string; downloadUrl: string } | null; current?: string } = {}) {
  let settings: UpdateSettings = { autoCheck: true, skippedVersion: null, ...opts.settings }
  const listeners = new Map<string, Listener>()
  const timers: (() => void)[] = []
  const engine = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    checkForUpdates: vi.fn(async () => undefined),
    downloadUpdate: vi.fn(async () => undefined),
    quitAndInstall: vi.fn(),
    on: (ev: string, fn: Listener) => void listeners.set(ev, fn)
  } satisfies UpdateEngine
  const published: (UpdateNotice | null)[] = []
  const opened: string[] = []
  const fetchLatest = vi.fn(async () => (opts.latest === undefined ? null : opts.latest))
  const deps: UpdaterDeps = {
    engine,
    currentVersion: opts.current ?? '0.12.0',
    releasesUrl: 'https://example.test/releases',
    readSettings: () => settings,
    writeSettings: (patch) => (settings = { ...settings, ...patch }),
    fetchLatest,
    openExternal: (u) => void opened.push(u),
    publish: (n) => void published.push(n),
    log: () => {},
    setTimer: (fn) => void timers.push(fn)
  }
  const u = createUpdater(deps)
  const emit = (ev: string, arg: unknown): void => (listeners.get(ev) as (a: unknown) => void)(arg)
  return { u, engine, emit, timers, published, opened, fetchLatest, settings: () => settings }
}

describe('update consent flow', () => {
  it('never downloads or installs on its own: both engine flags are forced off', () => {
    const t = setup()
    t.u.init()
    expect(t.engine.autoDownload).toBe(false)
    expect(t.engine.autoInstallOnAppQuit).toBe(false)
  })

  it('available -> download now -> downloaded -> restart', () => {
    const t = setup()
    t.u.init()
    t.emit('update-available', { version: '0.13.0' })
    expect(t.u.view().notice).toEqual({ phase: 'available', version: '0.13.0', via: 'engine' })
    expect(t.engine.downloadUpdate).not.toHaveBeenCalled()

    t.u.act('download')
    expect(t.engine.downloadUpdate).toHaveBeenCalledTimes(1)
    expect(t.u.view().notice?.phase).toBe('downloading')

    t.emit('update-downloaded', { version: '0.13.0' })
    expect(t.u.view().notice).toEqual({ phase: 'ready', version: '0.13.0', via: 'engine' })
    expect(t.engine.quitAndInstall).not.toHaveBeenCalled()

    t.u.act('install')
    expect(t.engine.quitAndInstall).toHaveBeenCalledTimes(1)
  })

  it('"install when I quit" is the only thing that turns on install-on-quit', () => {
    const t = setup()
    t.u.init()
    t.emit('update-available', { version: '0.13.0' })
    t.u.act('download')
    t.emit('update-downloaded', { version: '0.13.0' })
    expect(t.engine.autoInstallOnAppQuit).toBe(false)
    t.u.act('installOnQuit')
    expect(t.engine.autoInstallOnAppQuit).toBe(true)
    expect(t.engine.quitAndInstall).not.toHaveBeenCalled()
  })

  it('actions that do not fit the phase do nothing', () => {
    const t = setup()
    t.u.init()
    t.u.act('download')
    t.u.act('install')
    t.u.act('skip')
    expect(t.engine.downloadUpdate).not.toHaveBeenCalled()
    expect(t.engine.quitAndInstall).not.toHaveBeenCalled()
    expect(t.settings().skippedVersion).toBeNull()
  })

  it('skip this version is remembered: automatic checks stay quiet, a newer one shows, Check now still shows it', async () => {
    const t = setup({ latest: { version: '0.13.0', downloadUrl: 'https://example.test/dl' } })
    t.u.init()
    t.emit('update-available', { version: '0.13.0' })
    t.u.act('skip')
    expect(t.settings().skippedVersion).toBe('0.13.0')
    expect(t.u.view().notice).toBeNull()

    t.emit('update-available', { version: 'v0.13.0' })
    expect(t.u.view().notice).toBeNull()

    t.emit('update-available', { version: '0.14.0' })
    expect(t.u.view().notice?.version).toBe('0.14.0')

    t.u.act('skip')
    const r = await t.u.checkNow() // the user asked: shown even though 0.13.0 was skipped
    expect(r.status).toBe('available')
    expect(t.u.view().notice?.version).toBe('0.13.0')
  })

  it('the site fallback only offers a link (no engine download), same notice', async () => {
    const t = setup({ latest: { version: 'v0.13.0', downloadUrl: 'https://example.test/dl' } })
    t.u.init()
    t.emit('error', new Error('no signature'))
    await vi.waitFor(() => expect(t.u.view().notice).toEqual({ phase: 'available', version: '0.13.0', via: 'site' }))
    t.u.act('download')
    expect(t.opened).toEqual(['https://example.test/dl'])
    expect(t.engine.downloadUpdate).not.toHaveBeenCalled()
    expect(t.u.view().notice).toBeNull()
  })

  it('a failed engine download hands over the release page', async () => {
    const t = setup()
    t.engine.downloadUpdate.mockRejectedValueOnce(new Error('boom'))
    t.u.init()
    t.emit('update-available', { version: '0.13.0' })
    t.u.act('download')
    await vi.waitFor(() => expect(t.opened).toEqual(['https://example.test/releases']))
    expect(t.u.view().notice).toBeNull()
  })

  it('Check now reports up-to-date / error', async () => {
    expect((await setup({ latest: { version: '0.12.0', downloadUrl: 'x' } }).u.checkNow()).status).toBe('up-to-date')
    expect((await setup({ latest: null }).u.checkNow()).status).toBe('error')
  })
})

describe('"Check for updates automatically" gate', () => {
  it('on: the launch check runs after the delay', () => {
    const t = setup()
    t.u.init()
    expect(t.timers).toHaveLength(1)
    t.timers[0]!()
    expect(t.engine.checkForUpdates).toHaveBeenCalledTimes(1)
  })

  it('off: no check is scheduled or made at launch, and an engine error makes no site request', () => {
    const t = setup({ settings: { autoCheck: false }, latest: { version: '9.9.9', downloadUrl: 'x' } })
    t.u.init()
    expect(t.timers).toHaveLength(0)
    t.emit('error', new Error('x'))
    expect(t.engine.checkForUpdates).not.toHaveBeenCalled()
    expect(t.fetchLatest).not.toHaveBeenCalled()
  })

  it('switched off during the launch delay: the delayed check does not run', () => {
    const t = setup()
    t.u.init()
    t.u.setAutoCheck(false)
    t.timers[0]!()
    expect(t.engine.checkForUpdates).not.toHaveBeenCalled()
    expect(t.u.view().settings.autoCheck).toBe(false)
  })

  it('off: Check now still works when the user asks', async () => {
    const t = setup({ settings: { autoCheck: false }, latest: { version: '0.13.0', downloadUrl: 'x' } })
    t.u.init()
    expect((await t.u.checkNow()).status).toBe('available')
    expect(t.fetchLatest).toHaveBeenCalledTimes(1)
  })
})
