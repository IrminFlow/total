import { chromium } from 'playwright-core'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const site = join(root, 'site')
const out = resolve(process.env.SITE_VISUAL_OUT ?? join(root, 'smoke-out', 'site-routes'))
const profile = mkdtempSync(join(tmpdir(), 'total-site-capture-'))
const routes = [
  '/', '/capture', '/changelog', '/compare', '/docs', '/docs/ai-data', '/docs/backups',
  '/docs/coming-from-tally', '/docs/faq', '/docs/gst-returns', '/feedback', '/pricing',
  '/privacy', '/security', '/support', '/terms'
]
const headings = {
  '/': 'Your books stay local.', '/capture': 'Capture here. Review in Total.',
  '/changelog': 'Changelog', '/compare': 'Total vs TallyPrime', '/docs': 'Getting started',
  '/docs/ai-data': 'AI and your accounting data', '/docs/backups': 'Backups & data',
  '/docs/coming-from-tally': 'Coming from Tally', '/docs/faq': 'Frequently asked questions',
  '/docs/gst-returns': 'GST returns', '/feedback': 'Help decide what Total builds next.',
  '/pricing': 'Own the software. Always own the books.', '/privacy': 'Privacy, in plain language.',
  '/security': 'Local by default. Reviewable by design.', '/support': 'Tell us what happened.',
  '/terms': 'Terms of use.'
}
const viewports = [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]
const commit = process.env.TOTAL_CAPTURE_COMMIT ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()

if (!existsSync(join(site, '.next', 'BUILD_ID'))) throw new Error('site/.next is missing; run `npm --prefix site run build` first')
mkdirSync(out, { recursive: true })

async function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolvePort(address.port))
    })
  })
}
const port = await reservePort()
const automationPort = await reservePort()
const baseUrl = `http://127.0.0.1:${port}`
const server = spawn('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', String(port)], {
  cwd: site, stdio: ['ignore', 'pipe', 'pipe']
})
let serverLog = ''
for (const stream of [server.stdout, server.stderr]) stream.on('data', (chunk) => { serverLog = (serverLog + chunk).slice(-12000) })

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { if ((await fetch(baseUrl)).ok) return } catch { /* server is still starting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`site server did not become ready\n${serverLog}`)
}

async function ready(page) {
  await page.waitForLoadState('networkidle')
  // Walk the document once so native lazy-loaded images enter the preload margin before the
  // full-page capture. Merely waiting on `complete` can deadlock for images never approached.
  await page.evaluate(async () => {
    await document.fonts?.ready
    const step = Math.max(window.innerHeight * 0.8, 400)
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y)
      await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    }
    window.scrollTo(0, 0)
  })
  await page.waitForFunction(() => [...document.images].every((image) => image.complete), null, { timeout: 20000 })
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
}

let browser
let shellProcess
const captures = []
try {
  await waitForServer()
  const { ELECTRON_RUN_AS_NODE: _ignored, ...env } = process.env
  shellProcess = spawn(require('electron'), [
    `--remote-debugging-port=${automationPort}`,
    `--user-data-dir=${profile}`,
    join(root, 'scripts', 'lib', 'site-capture-shell.cjs'),
    baseUrl,
  ], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let shellLog = ''
  for (const stream of [shellProcess.stdout, shellProcess.stderr]) {
    stream.on('data', (chunk) => { shellLog = (shellLog + chunk).slice(-12000) })
  }
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      if ((await fetch(`http://127.0.0.1:${automationPort}/json/version`)).ok) break
    } catch { /* Electron is still starting */ }
    if (attempt === 119) throw new Error(`site capture shell did not become ready\n${shellLog}`)
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${automationPort}`)
  const context = browser.contexts()[0]
  if (!context) throw new Error('site capture shell has no browser context')
  const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 30000 })
  await page.waitForLoadState('domcontentloaded')
  await page.route('**/api/feedback', (route) => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ ideas: [{ id: 'capture-fixture', title: 'Keyboard workflow improvements', detail: 'Deterministic visual fixture.', status: 'planned', votes: 12, releaseVersion: 'v5.1' }] })
  }))
  for (const viewport of viewports) {
    await page.setViewportSize(viewport)
    const viewportDir = join(out, `${viewport.width}x${viewport.height}`)
    mkdirSync(viewportDir, { recursive: true })
    for (const route of routes) {
      const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'domcontentloaded' })
      if (!response?.ok()) throw new Error(`${route} returned ${response?.status() ?? 'no response'}`)
      await page.getByRole('heading', { level: 1, name: headings[route], exact: true }).waitFor()
      await ready(page)
      const slug = route === '/' ? 'home' : route.slice(1).replaceAll('/', '--')
      const file = join(viewportDir, `${slug}.png`)
      await page.screenshot({ path: file, fullPage: true })
      captures.push({ schemaVersion: 1, capturedAt: new Date().toISOString(), commit,
        scenario: 'site-route-catalog', file: relative(out, file), theme: 'light', viewport,
        route, fixture: route === '/feedback' ? 'mock-feedback-idea' : 'local-production-build', state: 'ready' })
    }
  }
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, captures }, null, 2))
  console.log(JSON.stringify({ ok: true, routes: routes.length, captures: captures.length, out }))
} finally {
  await browser?.close().catch(() => {})
  shellProcess?.kill('SIGTERM')
  server.kill('SIGTERM')
  rmSync(profile, { recursive: true, force: true })
}
