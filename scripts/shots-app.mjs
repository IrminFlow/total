// Walk every screen in the registry and photograph it, in both themes.
//
// This is how the UI actually gets looked at. The E2E suite screenshots whatever a scenario
// happens to pass through, which is not the same as seeing every screen — and a screen nobody has
// looked at since it was written is where the ugly lives.
//
//   node scripts/shots-app.mjs            # light theme
//   node scripts/shots-app.mjs --dark     # dark theme
//   node scripts/shots-app.mjs --both
//
// Output: smoke-out/shots/<theme>/<screen>.png, plus a contact sheet per theme.
import { Harness } from './lib/harness.mjs'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
const themes = args.includes('--both') ? ['light', 'dark'] : args.includes('--dark') ? ['dark'] : ['light']
const outRoot = path.join(process.cwd(), 'smoke-out', 'shots')

// Screens reachable from the sidebar with no required parameters. Read from the registry rather
// than listed here, so a new screen is photographed the day it is added.
async function navigableScreens(h) {
  return h.page.$$eval('[data-testid^="nav-"]', (els) =>
    els.map((e) => e.getAttribute('data-testid').replace(/^nav-/, ''))
  )
}

const h = new Harness('shots-app')
try {
  await h.launch()
  await h.createDemoCompany()

  for (const theme of themes) {
    const dir = path.join(outRoot, theme)
    mkdirSync(dir, { recursive: true })

    // The toggle reports the theme it will switch TO, so it names the opposite of the current one.
    const current = await h.page.getAttribute('html', 'data-theme')
    if (current !== theme) await h.page.click('[data-testid="btn-theme"]')

    const screens = await navigableScreens(h)
    console.log(`${theme}: ${screens.length} screens`)

    for (const name of screens) {
      try {
        await h.goto(name)
        // Let queries settle so a panel is photographed with its data, not its skeleton.
        await h.page.waitForTimeout(400)
        await h.page.screenshot({ path: path.join(dir, `${name}.png`) })
      } catch (err) {
        console.log(`  ${name}: ${String(err).split('\n')[0]}`)
      }
    }

    // One contact sheet so a person can see the whole app at once and spot what does not match.
    const files = readdirSync(dir).filter((f) => f.endsWith('.png') && f !== 'contact-sheet.png')
    const cells = files
      .map((f) => `<figure><img src="${f}"><figcaption>${f.replace('.png', '')}</figcaption></figure>`)
      .join('')
    writeFileSync(
      path.join(dir, 'contact-sheet.html'),
      `<!doctype html><meta charset="utf-8"><title>Total — ${theme}</title>
       <style>body{margin:0;padding:24px;background:#8b8f99;font:13px/1.4 -apple-system,sans-serif;
       display:grid;grid-template-columns:repeat(auto-fill,minmax(420px,1fr));gap:20px}
       figure{margin:0}img{width:100%;display:block;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.25)}
       figcaption{color:#fff;padding-top:6px}</style>${cells}`
    )
    console.log(`  → ${dir}`)
  }
} finally {
  await h.close()
}
