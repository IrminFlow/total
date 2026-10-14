// Scenario 64 — WP 10.4 Hindi and Hinglish complete.
//   1. First run: the wizard asks the language FIRST; choosing हिन्दी re-renders the wizard in
//      Hindi at once; the company is created with Hindi as its language (meta ui.language).
//   2. Home in Hindi (no English left on the simple screens, no banned word in either script),
//      Make a bill → the save card in Hindi → Print: the PDF's text layer carries the Hindi
//      labels and the amount in words in Hindi (Noto Sans Devanagari embedded, so no boxes).
//   3. Help opens its Hindi article; Ask Total "kitna udhaar hai" answers in Hindi.
//   4. Settings → How Total looks → Hinglish: Home reads Latin-script Hinglish.
// Light + dark screenshots; WP104_SHOTS=<dir> copies the review set (≤ 8).
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { scenario, assert, assertEq, PICKER_OPTION } from '../lib/harness.mjs'

// The plan §1 banned list + its Hindi / Hinglish spellings (shared/simple/bannedWords.ts).
const BANNED = [
  /\bvouchers?\b/i, /\bledgers?\b/i, /\bjournals?\b/i, /\bcontras?\b/i, /\b(?:Dr|Cr)\b/, /\bparticulars?\b/i, /\bnarrations?\b/i, /\bsundry\b/i,
  /\bgroups?\b/i, /\bITC\b/i, /\bset[- ]?offs?\b/i, /\bag(?:e)?ing\b/i, /\bBRS\b/i, /\bgodowns?\b/i, /\bBOMs?\b/i, /\bSOA\b/i,
  /वाउचर/, /लेजर|लेज़र/, /जर्नल/, /कॉन्ट्रा/, /नैरेशन/, /संड्री/, /ग्रुप/, /गोडाउन|गोदाम/, /एजिंग/, /आईटीसी/, /बीओएम/
]
const bannedWordsIn = (text) => BANNED.filter((re) => re.test(text)).map((re) => re.source)
const DEVANAGARI = /[ऀ-ॿ]/

const attached = (h, sel, timeout = 15000) => h.page.waitForSelector(sel, { state: 'attached', timeout })

/** The app's own PDF text reader (shared/capture/pdfText.ts), bundled for this script. */
async function pdfTextReader() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'total-e2e64-'))
  const out = path.join(dir, 'pdfText.mjs')
  execFileSync('npx', ['esbuild', 'src/shared/capture/pdfText.ts', '--bundle', '--format=esm', '--platform=node', `--outfile=${out}`, '--log-level=error'], { stdio: 'inherit' })
  const mod = await import(pathToFileURL(out).href)
  return { read: (file) => mod.extractPdfText(new Uint8Array(fs.readFileSync(file)), (d) => new Uint8Array(zlib.inflateSync(d))), dir }
}

await scenario('64-hindi', async (h) => {
  const { page } = h
  const review = process.env.WP104_SHOTS
  // The theme button lives in the shell; before a company is open (the wizard) the theme
  // attribute is set directly for the screenshot.
  const setTheme = async (want) => {
    if ((await page.evaluate(() => document.documentElement.dataset.theme)) === want) return
    if (await page.$('[data-testid="btn-theme"]')) await h.click('btn-theme')
    else await page.evaluate((w) => (document.documentElement.dataset.theme = w), want)
    await page.waitForFunction((w) => document.documentElement.dataset.theme === w, want)
  }
  const shoot = async (name, keep = false) => {
    for (const want of ['light', 'dark']) {
      await setTheme(want)
      await page.waitForTimeout(400)
      const file = await h.shot(`${name}-${want}`)
      if (review && keep) {
        fs.mkdirSync(review, { recursive: true })
        fs.copyFileSync(file, path.join(review, `${name}-${want}.png`))
      }
    }
    await setTheme('light')
  }
  const mainText = (sel = 'main') => page.evaluate((s) => document.querySelector(s)?.innerText ?? '', sel)
  const noBanned = async (where, sel = 'main') => {
    const found = bannedWordsIn(await mainText(sel))
    assert(found.length === 0, `no accounting words on ${where} (${found.join(', ')})`)
  }
  /** Buttons / chips whose text no longer fits (a longer Hindi string clipped or spilling). */
  const overflowing = (sel) =>
    page.evaluate((s) => {
      const root = document.querySelector(s)
      if (!root) return []
      return [...root.querySelectorAll('button, [role="radio"], a')]
        .filter((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 2 && getComputedStyle(el).overflowX !== 'auto')
        .map((el) => (el.textContent ?? '').trim().slice(0, 40))
    }, sel)

  // ================= 1. the wizard, in Hindi from its first question =================
  await h.waitScreen('company-select')
  await attached(h, '[data-testid="setup-wizard"]')
  await attached(h, '[data-testid="setup-language"]')
  assertEq(await page.getAttribute('[data-testid="setup-language-en"]', 'aria-checked'), 'true', 'English to start with on an English Mac')
  const englishLabel = await page.textContent('[data-testid="setup-step-label"]')
  await h.click('setup-language-hi')
  await page.waitForFunction((before) => document.querySelector('[data-testid="setup-step-label"]')?.textContent !== before, englishLabel)
  const wizardText = await mainText('[data-testid="setup-wizard"]')
  assert(DEVANAGARI.test(await page.textContent('[data-testid="setup-step-label"]')), 'the step label is Hindi at once')
  assert(DEVANAGARI.test(await page.textContent('[data-testid="setup-next"]')), 'the Next button is Hindi')
  assertEq(bannedWordsIn(wizardText).length, 0, 'no banned word in the Hindi wizard')
  assertEq((await overflowing('[data-testid="setup-wizard"]')).join(' | '), '', 'no Hindi button text spills out of the wizard')
  await shoot('01-wizard-hindi', true)
  await h.fill('setup-name', 'Sharma Kirana')
  await h.click('setup-next')
  await h.click('setup-type-retail')
  await h.click('setup-next')
  await h.click('setup-gst-no')
  await h.click('setup-next')
  await h.click('setup-stock-yes')
  await h.click('setup-next')
  await h.click('setup-start-fy')
  await h.click('setup-fresh-new')
  await h.click('setup-next')
  await h.click('setup-finish')
  await h.waitScreen('gateway', 30000)
  await attached(h, '[data-testid="simple-home"]', 20000)
  // The tour speaks Hindi too; Esc ends it.
  await attached(h, '[data-testid="tour"]')
  assert(DEVANAGARI.test((await page.textContent('[data-testid="tour"]')) ?? ''), 'the tour is in Hindi')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[data-testid="tour"]', { state: 'detached', timeout: 5000 })
  const cur = await h.invoke('company:current')
  assertEq(cur.ui.language, 'hi', 'the wizard wrote Hindi as the company language')
  assertEq(cur.ui.mode, 'simple', 'simple mode')

  // ================= 2. Home → Make a bill → save card → print =================
  await h.waitIdle()
  const home = await mainText()
  assert(DEVANAGARI.test(home), 'Home is in Hindi')
  await noBanned('Home (Hindi)')
  await noBanned('the simple sidebar', '[data-testid="simple-nav"]')
  await shoot('02-home-hindi', true)

  const units = await h.invoke('master:units:list')
  await h.invoke('master:stockItems:quickCreate', {
    item: { name: 'Sugar 1kg', groupId: null, unitId: units[0].id, hsn: null, gstRate: null, cessRate: null, openingQtyMilli: 50_000, openingValue: 100_000, barcode: null, reorderLevelMilli: null },
    sellingPricePaise: 4_500,
    purchasePricePaise: null
  })
  await h.app.evaluate(({ shell }) => {
    globalThis.__opened = []
    shell.openPath = async (p) => {
      globalThis.__opened.push(p)
      return ''
    }
  })
  await h.click('simple-task-sale')
  await h.waitScreen('simple-sell')
  const item = page.locator('[data-testid="picker-sell-item-0"]').first()
  await item.click()
  await item.fill('Sugar')
  await page.locator(PICKER_OPTION, { hasText: 'Sugar' }).first().click()
  const qty = page.locator('[data-testid="input-sell-qty-0"]').first()
  await qty.click()
  await qty.fill('2')
  await qty.blur()
  await h.click('sell-paid-cash')
  await page.waitForFunction(() => document.querySelector('[data-testid="sell-total"]')?.getAttribute('data-paise') === '9000', null, { timeout: 10000 })
  await page.waitForFunction(() => /[ऀ-ॿ]/.test(document.querySelector('[data-testid="sell-preview"]')?.textContent ?? ''), null, { timeout: 10000 })
  await noBanned('Make a bill (Hindi)')
  assertEq((await overflowing('main')).join(' | '), '', 'no Hindi button text spills on Make a bill')
  await shoot('03-make-bill-hindi', true)
  await page.keyboard.press('Meta+Enter')
  await attached(h, '[data-testid="save-card"]')
  await page.waitForFunction(() => /[ऀ-ॿ]/.test(document.querySelector('[data-testid="save-card-text"]')?.textContent ?? ''), null, { timeout: 10000 })
  await noBanned('the save card (Hindi)')
  await shoot('04-save-card-hindi')
  await h.click('btn-save-card-print')
  let opened = []
  for (let i = 0; i < 60 && opened.length === 0; i++) {
    await page.waitForTimeout(250)
    opened = await h.app.evaluate(() => globalThis.__opened ?? [])
  }
  assert(opened.length === 1 && opened[0].endsWith('.pdf'), `Print made the bill PDF (${opened.join(', ')})`)
  const reader = await pdfTextReader()
  try {
    const pdf = reader.read(opened[0])
    const text = pdf.pages.join('\n')
    assert(DEVANAGARI.test(text), 'the PDF text layer holds Devanagari (the font is embedded with its Unicode map)')
    assert(text.includes('रुपये') && text.includes('मात्र'), `the amount in words is Hindi (${text.slice(0, 200)})`)
    assert(text.includes('नब्बे'), 'ninety rupees in Hindi words')
    assert(!/Amount in words/.test(text), 'no English label left on the Hindi print')
    assert(!/�/.test(text), 'no replacement characters (no boxes)')
  } finally {
    fs.rmSync(reader.dir, { recursive: true, force: true })
  }

  // ================= 3. Help in Hindi, Ask Total =================
  await h.click('btn-save-card-new')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home"]')
  await h.click('btn-help')
  await attached(h, '[data-testid="help-panel"]')
  await attached(h, '[data-testid="help-article"]')
  assert(DEVANAGARI.test(await page.textContent('[data-testid="help-article-title"]')), 'the help article is in Hindi')
  assertEq(await page.$('[data-testid="help-in-english"]'), null, 'no "shown in English" note on a translated article')
  await h.fill('help-search', 'उधार')
  await page.waitForFunction(() => (document.querySelector('[data-testid="help-panel"]')?.textContent ?? '').length > 0)
  await page.waitForTimeout(400)
  await shoot('05-help-hindi')
  await h.click('btn-help')
  await page.waitForSelector('[data-testid="help-panel"]', { state: 'detached', timeout: 5000 })

  await h.click('btn-assistant')
  await attached(h, '[data-testid="ask-panel"]')
  await page.fill('[data-testid="ask-input"]', 'kitna udhaar hai')
  await h.click('ask-send')
  await attached(h, '[data-testid="ask-answer"]')
  const answer = await page.locator('[data-testid="ask-answer"]').last().innerText()
  assert(DEVANAGARI.test(answer), `Ask Total answers in Hindi (${answer})`)
  await noBanned('the Ask Total panel', '[data-testid="ask-panel"]')
  await shoot('06-ask-hindi')
  await h.click('btn-assistant')

  // ================= 4. switch to Hinglish =================
  await h.click('simple-nav-settings')
  await attached(h, '[data-testid="simple-entry-looks"]')
  await h.click('simple-entry-looks')
  await attached(h, '[data-testid="simple-looks"]')
  await h.click('btn-language-hinglish')
  await h.click('simple-nav-home')
  await attached(h, '[data-testid="simple-home"]')
  await h.waitIdle()
  const hg = await mainText()
  assert(!DEVANAGARI.test(hg.replace(/हिन्दी/g, '')), 'Hinglish Home has no Devanagari')
  assert(/Paise aaye|Lena baaki|Bill banayein/i.test(hg + (await mainText('[data-testid="simple-nav"]'))), 'Hinglish words on Home')
  await noBanned('Home (Hinglish)')
  assertEq((await overflowing('main')).join(' | '), '', 'no Hinglish button text spills on Home')
  await shoot('07-home-hinglish', true)
  assertEq((await h.invoke('company:current')).ui.language, 'hinglish', 'the owner’s choice is the company language')
})
