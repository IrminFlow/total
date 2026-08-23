// E2E harness for the BUILT app (out/) — shared by every scripts/e2e/*.mjs scenario and by
// scripts/shots-site.mjs. Wraps playwright-core's _electron with the launch/retry/idle/testid
// conventions from src/renderer/src/lib/testids.ts:
//
//   launch()        Electron via require('electron'), args [cwd], mkdtemp TOTAL_DATA_DIR,
//                   TOTAL_SUPPRESS_SYNC_WARNING=1, one retry, viewport 1440x900, waits for
//                   window.total.
//   invoke(ch, p)   window.total.invoke — throws on { ok: false }.
//   goto(name)      Click [data-testid="nav-<name>"] then wait for
//                   [data-screen="<name>"][data-loading="false"].
//   waitIdle()      Wait for the current [data-screen] to report data-loading="false".
//   shot(name)      Screenshot into the scenario's out dir.
//   stubDialogs()   Patch dialog.show*Dialog/showMessageBox + shell.showItemInFolder/openPath
//                   in the MAIN process so no native chrome ever blocks a run.
//   console log     Collected from launch; assertNoConsoleErrors()/assertNoKeyWarnings() fail
//                   the scenario on real renderer errors / React "unique key" warnings.
//
// Run `npm run build` first — this launches out/, not the dev server.
import { _electron as electron } from 'playwright-core'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const require = createRequire(import.meta.url)
const electronPath = require('electron')

/** Console noise that is not the app's fault — never fails a scenario. */
const CONSOLE_IGNORE = [
  /Autofill\./,
  /ERR_BLOCKED_BY_CLIENT/,
  /DevTools/i,
  /Electron Security Warning/i
]

export class Harness {
  /** @param {{ dataDir?: string, outDir?: string, appDir?: string }} [opts] */
  constructor(opts = {}) {
    this.appDir = opts.appDir ?? process.cwd()
    this.dataDir = opts.dataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'total-e2e-'))
    this.outDir = opts.outDir ?? process.env.SMOKE_OUT ?? path.join(os.tmpdir(), 'total-e2e-out')
    fs.mkdirSync(this.dataDir, { recursive: true })
    fs.mkdirSync(this.outDir, { recursive: true })
    this.app = null
    this.page = null
    /** @type {{ kind: 'console-error'|'page-error', text: string }[]} */
    this.consoleErrors = []
    /** @type {string[]} */
    this.keyWarnings = []
    this._shotSeq = 0
  }

  /** Launch the built app (one retry on a slow first boot). */
  async launch() {
    const attempt = async () => {
      const app = await electron.launch({
        executablePath: electronPath,
        args: [this.appDir],
        timeout: 60000,
        env: {
          ...process.env,
          // `npm run test:db` runs Electron as a plain Node process, and that variable leaking
          // into this environment makes electron.launch fail with a bare "Process failed to
          // launch!" -- the app's main entry sees `electron.app` as undefined and exits before
          // Playwright can attach. Clear it explicitly so the failure can never reappear as a
          // mystery in CI or on a developer's shell.
          ELECTRON_RUN_AS_NODE: undefined,
          TOTAL_DATA_DIR: this.dataDir,
          TOTAL_SUPPRESS_SYNC_WARNING: '1'
        }
      })
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30000 })
      return { app, page }
    }
    try {
      ;({ app: this.app, page: this.page } = await attempt())
    } catch (err) {
      console.log('[harness] launch failed, retrying once:', err instanceof Error ? err.message : String(err))
      try {
        await this.app?.close()
      } catch {
        /* ignore */
      }
      ;({ app: this.app, page: this.page } = await attempt())
    }
    this._collectConsole()
    return this
  }

  _collectConsole() {
    this.page.on('console', (msg) => {
      const text = msg.text()
      if (/unique "?key"? prop|Each child in a list should have a unique/i.test(text)) {
        this.keyWarnings.push(text)
        return
      }
      if (msg.type() === 'error' && !CONSOLE_IGNORE.some((re) => re.test(text))) {
        this.consoleErrors.push({ kind: 'console-error', text })
      }
    })
    this.page.on('pageerror', (err) => {
      this.consoleErrors.push({ kind: 'page-error', text: err.message })
    })
  }

  /** Close and relaunch against the SAME data dir (fresh renderer state, same books). */
  async relaunch() {
    await this.close()
    await this.launch()
  }

  /** window.total.invoke — throws when the handler answers { ok: false }. */
  async invoke(channel, payload) {
    const r = await this.page.evaluate(
      ([c, p]) => window.total.invoke(c, p),
      [channel, payload]
    )
    if (!r.ok) throw new Error(`${channel} failed: ${r.error}`)
    return r.data
  }

  /** Wait until the current screen marker reports data-loading="false". */
  async waitIdle(timeout = 15000) {
    await this.page.waitForSelector('[data-screen][data-loading="false"]', { state: 'attached', timeout })
  }

  /** Wait until a SPECIFIC screen is visible and idle. */
  async waitScreen(name, timeout = 15000) {
    await this.page.waitForSelector(`[data-screen="${name}"][data-loading="false"]`, {
      state: 'attached',
      timeout
    })
  }

  /** Sidebar navigation: click nav-<name>, wait for the screen to render + go idle. */
  async goto(name, timeout = 15000) {
    await this.page.click(`[data-testid="nav-${name}"]`, { timeout })
    await this.waitScreen(name, timeout)
  }

  /** Click any control by data-testid. */
  async click(testId, opts = {}) {
    await this.page.click(`[data-testid="${testId}"]`, { timeout: 10000, ...opts })
  }

  /** Click the first button/row whose text matches (exact button text preferred). */
  async clickText(text) {
    const result = await this.page.evaluate((t) => {
      const clickables = [...document.querySelectorAll('button, a, [role="button"], .kbar-row, [class*="cursor-pointer"]')]
      const el =
        clickables.find((e) => e.textContent?.trim() === t) ??
        clickables.find((e) => e.textContent?.includes(t))
      if (!el) return false
      el.click()
      return true
    }, text)
    if (!result) throw new Error(`clickText: nothing on screen matches ${JSON.stringify(text)}`)
  }

  /** Type into a data-testid'd input (clears it first). */
  async fill(testId, value) {
    await this.page.fill(`[data-testid="${testId}"]`, String(value), { timeout: 10000 })
  }

  /** From company-select: open a company by its display name; resolves to 'gateway' | 'lock'. */
  async openCompany(name, timeout = 20000) {
    await this.waitScreen('company-select', timeout)
    await this.clickText(name)
    const el = await this.page.waitForSelector(
      '[data-screen="gateway"][data-loading="false"], [data-screen="lock"]',
      { state: 'attached', timeout }
    )
    return el.getAttribute('data-screen')
  }

  /** From company-select: create a fresh (unregistered, default-state) company via the UI
   *  and land on the Gateway. */
  async createCompanyUI(name, timeout = 30000) {
    await this.waitScreen('company-select')
    await this.click('btn-company-create')
    await this.fill('input-company-name', name)
    await this.click('btn-company-save')
    await this.waitScreen('gateway', timeout)
  }

  /** From company-select: build the Demo Traders sample company and land on the Gateway. */
  async createDemoCompany(timeout = 60000) {
    await this.waitScreen('company-select')
    await this.clickText('Explore with sample data')
    await this.waitScreen('gateway', timeout)
  }

  /** Screenshot into the out dir; auto-numbered unless a name is given. */
  async shot(name) {
    const file = path.join(this.outDir, `${name ?? `shot-${String(++this._shotSeq).padStart(2, '0')}`}.png`)
    await this.page.screenshot({ path: file })
    return file
  }

  /**
   * Neutralize every native dialog / Finder reveal in the MAIN process:
   *   stubDialogs({ openPaths: ['/x.csv'], savePath: '/y.pdf', messageResponse: 0 })
   * Omitted openPaths/savePath answer as "canceled".
   */
  async stubDialogs(cfg = {}) {
    await this.app.evaluate(({ dialog, shell }, c) => {
      dialog.showOpenDialog = async () => ({ canceled: !c.openPaths?.length, filePaths: c.openPaths ?? [] })
      dialog.showOpenDialogSync = () => c.openPaths ?? []
      dialog.showSaveDialog = async () => ({ canceled: !c.savePath, filePath: c.savePath ?? '' })
      dialog.showSaveDialogSync = () => c.savePath
      dialog.showMessageBox = async () => ({ response: c.messageResponse ?? 0, checkboxChecked: false })
      dialog.showMessageBoxSync = () => c.messageResponse ?? 0
      shell.showItemInFolder = () => {}
      shell.openPath = async () => ''
    }, cfg)
  }

  /** Fails the scenario when any real console/page error was collected. */
  assertNoConsoleErrors() {
    if (this.consoleErrors.length > 0) {
      const list = this.consoleErrors.map((e) => `  [${e.kind}] ${e.text}`).join('\n')
      throw new Error(`console errors collected (${this.consoleErrors.length}):\n${list}`)
    }
  }

  /** Fails the scenario when React "unique key" warnings were collected. */
  assertNoKeyWarnings() {
    if (this.keyWarnings.length > 0) {
      throw new Error(`React key warnings collected (${this.keyWarnings.length}):\n  ${this.keyWarnings.join('\n  ')}`)
    }
  }

  async close() {
    try {
      await this.app?.close()
    } catch {
      /* ignore */
    }
    this.app = null
    this.page = null
  }
}

/** Simple assertion with a labeled failure. */
export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

export function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/**
 * Scenario wrapper: launches a fresh Harness, runs `fn(h)`, screenshots success/failure,
 * asserts a clean console (unless `opts.allowConsoleErrors`), and exits the process with
 * 0/1 — so every scenario file is standalone-runnable AND runner-friendly.
 *
 * Result protocol (read by scripts/run-e2e.mjs): the LAST stdout line is a JSON object
 * `{ scenario, ok, ms, error? }`.
 */
export async function scenario(name, fn, opts = {}) {
  const outRoot = process.env.SMOKE_OUT ?? path.join(os.tmpdir(), 'total-e2e-out')
  const h = new Harness({ outDir: path.join(outRoot, name), ...opts.harness })
  const started = Date.now()
  let ok = false
  let error
  try {
    await h.launch()
    await fn(h)
    if (!opts.allowConsoleErrors) h.assertNoConsoleErrors()
    h.assertNoKeyWarnings()
    await h.shot('99-success')
    ok = true
  } catch (err) {
    error = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`[${name}] FAILED:`, error)
    try {
      if (h.page) await h.shot('99-failure')
    } catch {
      /* ignore */
    }
  } finally {
    await h.close()
  }
  console.log(JSON.stringify({ scenario: name, ok, ms: Date.now() - started, ...(error ? { error } : {}) }))
  process.exit(ok ? 0 : 1)
}
