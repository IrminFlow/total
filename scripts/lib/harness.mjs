// E2E harness for the BUILT app (out/) — shared by every scripts/e2e/*.mjs scenario and by
// scripts/shots-site.mjs. Wraps playwright-core's _electron with the launch/retry/idle/testid
// conventions from src/renderer/src/lib/testids.ts:
//
//   launch()        Electron via require('electron'), args [cwd], mkdtemp TOTAL_DATA_DIR,
//                   TOTAL_SUPPRESS_SYNC_WARNING=1, one retry, viewport 1440x900, waits for
//                   window.total. WP 7.3: ELECTRON_RUN_AS_NODE is dropped from the env and
//                   TOTAL_APP_EXECUTABLE launches a packaged build instead (launchTarget).
//   invoke(ch, p)   window.total.invoke — throws on { ok: false }.
//   mode            WP 8.1: the company mode createCompanyUI / createDemoCompany leave the company
//                   in — 'accountant' (default: e2e 01–45 run in the full app) or 'simple'
//                   (constructor option, or per call). Accountant writes nothing (a missing `ui`
//                   key means accountant); simple switches through ui:mode:set and waits for the shell.
//   goto(name)      Expand the item's sidebar section if collapsed, click
//                   [data-testid="nav-<name>"], then wait for
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

/**
 * WP 7.3: what to launch. By default the Electron binary from node_modules with the checkout as
 * its app (out/ built by `npm run build`) — on every platform (`require('electron')` gives
 * `electron.exe` on Windows). TOTAL_APP_EXECUTABLE (absolute path) launches a PACKAGED app
 * instead — `dist/win-unpacked/Total.exe` on the Windows CI job — with no app-dir argument.
 */
export function launchTarget(appDir = process.cwd()) {
  const exe = process.env.TOTAL_APP_EXECUTABLE
  if (exe) return { executablePath: exe, args: [], packaged: true }
  return { executablePath: electronPath, args: [appDir], packaged: false }
}

/**
 * WP 7.3: the environment a scripted launch runs with. ELECTRON_RUN_AS_NODE is dropped (agent
 * shells and `npm run test:db` set it; with it the binary starts as plain Node and Playwright's
 * launch hangs — on Windows the env block is case-insensitive, so every casing goes). The update
 * check is off (a packaged build would otherwise ask GitHub and may open a dialog mid-run).
 */
export function launchEnv(extra = {}) {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[k]
  return { ...env, TOTAL_NO_UPDATE_CHECK: '1', ...extra }
}

/** Console noise that is not the app's fault — never fails a scenario. */
const CONSOLE_IGNORE = [
  /Autofill\./,
  /ERR_BLOCKED_BY_CLIENT/,
  /DevTools/i,
  /Electron Security Warning/i
]

export class Harness {
  /** @param {{ dataDir?: string, outDir?: string, appDir?: string, mode?: 'accountant'|'simple' }} [opts] */
  constructor(opts = {}) {
    this.appDir = opts.appDir ?? process.cwd()
    /** WP 8.1: the mode new companies are put in (see the header). */
    this.mode = opts.mode ?? 'accountant'
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
      const { executablePath, args } = launchTarget(this.appDir)
      const app = await electron.launch({
        executablePath,
        args,
        timeout: 60000,
        env: launchEnv({
          TOTAL_DATA_DIR: this.dataDir,
          TOTAL_SUPPRESS_SYNC_WARNING: '1',
          // Non-secure test cipher for the secret store (services/secretStore.ts) so runs never
          // touch the real keychain; honoured only together with TOTAL_DATA_DIR in an unpackaged
          // build (a packaged Windows run uses DPAPI, which needs no prompt).
          TOTAL_INSECURE_TEST_SECRETS: '1'
        })
      })
      const page = await app.firstWindow()
      await page.setViewportSize({ width: 1440, height: 900 })
      await page.waitForLoadState('domcontentloaded')
      await page.waitForFunction(() => Boolean(window.total), null, { timeout: 30000 })
      if (process.env.TOTAL_E2E_TODAY) await assertShiftedClock(app, page)
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

  /** Sidebar navigation: click nav-<name>, wait for the screen to render + go idle. Items in a
   *  collapsed sidebar section are in the DOM but hidden — expand the section first. */
  async goto(name, timeout = 15000) {
    await this.page.waitForSelector(`[data-testid="nav-${name}"]`, { state: 'attached', timeout })
    await this.page.evaluate((n) => {
      const list = document.querySelector(`[data-testid="nav-${n}"]`)?.closest('[hidden]')
      if (list?.id) document.querySelector(`[aria-controls="${list.id}"]`)?.click()
    }, name)
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
   *  and land on the Gateway, in `mode` (default the harness mode, 'accountant'). `opts.gstin`
   *  registers it (Regular) — WP 8.0: only a regular registration may charge GST, so scenarios
   *  that post tax lines pass one. `opts.coverDaysBack: N` begins the books early enough that a
   *  bill N days old is inside them (`booksStartCovering`; the form's FY picker), so a scenario's
   *  relative dates keep their age on every calendar day. */
  async createCompanyUI(name, timeout = 30000, opts = {}) {
    if (typeof timeout === 'object') [opts, timeout] = [timeout, 30000]
    const mode = opts.mode ?? this.mode
    await this.waitScreen('company-select')
    await this.click('btn-company-create')
    await this.fill('input-company-name', name)
    if (opts.gstin) await this.fill('input-company-gstin', opts.gstin)
    const early = opts.coverDaysBack == null ? null : booksStartCovering(opts.coverDaysBack)
    if (early) await this.page.getByLabel('Books begin (FY)').selectOption(String(fyStartYearOf(early)))
    await this.click('btn-company-save')
    await this.waitScreen('gateway', timeout)
    await this.setMode(mode)
  }

  /** From company-select: build the Demo Traders sample company and land on the Gateway. WP 8.3:
   *  "Try with sample data" opens it in simple mode (D2); the accountant link "Sample data in the
   *  full app" is the 0.10 path (no `ui` meta), used for the default accountant mode. */
  async createDemoCompany(timeout = 60000, { mode = this.mode } = {}) {
    await this.waitScreen('company-select')
    await this.click(mode === 'simple' ? 'btn-company-demo' : 'btn-company-demo-full')
    await this.waitScreen('gateway', timeout)
    await this.setMode(mode)
  }

  /** WP 8.1: put the open company in `mode`. Accountant is what a company without `ui` meta
   *  already is, so it writes nothing (no audit row) unless the company says otherwise. */
  async setMode(mode) {
    const current = (await this.invoke('company:current'))?.ui?.mode ?? 'accountant'
    if (current === mode) return
    // Through Settings → How Total looks, like the owner would (the session follows ui:mode:set).
    if (current === 'simple') await this.click('simple-nav-settings')
    else await this.goto('settings')
    if (current === 'simple') await this.click('simple-entry-looks')
    else await this.click('tab-settings-appearance')
    await this.click(`btn-mode-${mode}`)
    await this.page.waitForSelector(mode === 'simple' ? '[data-testid="simple-nav"]' : 'nav[aria-label="Main"]', { state: 'attached', timeout: 10000 })
    await this.click(mode === 'simple' ? 'simple-nav-home' : 'nav-gateway')
    await this.waitScreen('gateway')
  }

  /** The OPEN company's books begin early enough for a bill `daysBack` days old (the owner's
   *  company:updateInfo, as Company details saves it) — for companies made outside the form, e.g.
   *  the demo seed. Nothing is written when the current FY already covers it. */
  async coverDaysBack(daysBack) {
    const early = booksStartCovering(daysBack)
    if (!early) return
    const info = (await this.invoke('company:current')).info
    await this.invoke('company:updateInfo', { ...info, booksFrom: Math.min(info.booksFrom, fyStartYearOf(early)) })
  }

  /** WP 7.4, the setup wizard's start-date step: "Start of this financial year" unless dates
   *  `daysBack` days ago would fall before it — then "Earlier" with a date that covers them
   *  (`booksStartCovering`), so relative bills keep their age on every day of the year. */
  async pickSetupStart(daysBack) {
    const start = booksStartCovering(daysBack)
    if (!start) {
      await this.click('setup-start-fy')
      return fyStartOf()
    }
    await this.click('setup-start-earlier')
    await this.fill('setup-start-date', `${start.slice(8, 10)}-${start.slice(5, 7)}-${start.slice(0, 4)}`)
    await this.page.press('[data-testid="setup-start-date"]', 'Enter')
    return start
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
/** WP 8.4: a picker's real options — never its "Create …" row (role="option" data-create="true"),
 *  which a bare `[role="option"]` wait would also match while a typed name has no match yet. */
export const OPTION = '[role="option"]:not([data-create])'
export const PICKER_OPTION = `[role="listbox"] ${OPTION}`

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`)
}

export function assertEq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`assertion failed: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

/** TOTAL_E2E_TODAY: both the main process and the renderer must see the faked day (shared/e2eClock.ts),
 *  or the run would silently test the real date. */
async function assertShiftedClock(app, page) {
  const mainDay = await app.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  const rendererDay = await page.evaluate(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  })
  if (mainDay !== localToday() || rendererDay !== localToday()) {
    throw new Error(`TOTAL_E2E_TODAY=${process.env.TOTAL_E2E_TODAY} not in force: main ${mainDay}, renderer ${rendererDay}`)
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

// ---------------- WP 7.4: dates the way the app sees them ----------------
// The app's "today" is the LOCAL date of the machine it runs on (`todayISO()` in shared/dates.ts;
// the renderer's working date starts there). Scripts must never use `toISOString()` for today —
// that is the UTC date, a day behind between 00:00 and 05:30 IST. CI runs the e2e job with
// TZ=Asia/Kolkata so local runs and CI agree.

/** A Date's LOCAL calendar day as YYYY-MM-DD. */
export function isoLocal(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** Today, as the app sees it (local date). TOTAL_E2E_TODAY=YYYY-MM-DD shifts the APP's clock to
 *  that day (shared/e2eClock.ts — honoured with TOTAL_DATA_DIR in an unpackaged build, which the
 *  harness always launches), so the scripts' today follows it: a scenario can be run as if on
 *  5 April or 10 May to prove its dates hold on any calendar day. */
export function localToday() {
  const fake = process.env.TOTAL_E2E_TODAY
  if (fake && /^\d{4}-\d{2}-\d{2}$/.test(fake)) return fake
  return isoLocal(new Date())
}

/** The day this scenario started on — one anchor for every relative date in a run, so a
 *  scenario that crosses midnight keeps its dates consistent with each other. */
export const fixedToday = localToday()

/** `days` after `from` (negative = before), pure calendar arithmetic on an ISO date. */
export function relativeDate(days, from = fixedToday) {
  const d = new Date(`${from}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** The Indian financial year (April–March) containing `iso`: its starting calendar year. */
export function fyStartYearOf(iso = fixedToday) {
  const y = Number(iso.slice(0, 4))
  return Number(iso.slice(5, 7)) >= 4 ? y : y - 1
}

/** 1 April of the FY containing `iso`. */
export function fyStartOf(iso = fixedToday) {
  return `${fyStartYearOf(iso)}-04-01`
}

/** A books-begin date early enough that `daysBack` days ago is inside the books — or null when
 *  the current FY start already covers it (then a scenario starts the books on the FY start as
 *  before). Relative dates are never clamped to the FY start (that turned "40 days ago" into
 *  "today-ish" every 1 April – mid May and broke the overdue checks); the books begin earlier
 *  instead. TOTAL_E2E_EARLY_BOOKS=1 forces the early branch so it can be exercised on any day. */
export function booksStartCovering(daysBack, from = fixedToday) {
  const wanted = relativeDate(-(daysBack + 5), from)
  if (process.env.TOTAL_E2E_EARLY_BOOKS === '1') {
    const dayBeforeFy = relativeDate(-1, fyStartOf(from))
    return wanted < dayBeforeFy ? wanted : dayBeforeFy
  }
  return relativeDate(-daysBack, from) < fyStartOf(from) ? wanted : null
}
