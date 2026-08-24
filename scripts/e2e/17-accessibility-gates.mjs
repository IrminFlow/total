// Scenario 17 — hermetic accessibility gate over representative built-app screens.
// Checks accessible names, text contrast in both themes, and sequential keyboard focus.
import { scenario, assert } from '../lib/harness.mjs'

async function audit(h, label) {
  const result = await h.page.evaluate(() => {
    const visible = (el) => {
      const style = getComputedStyle(el)
      const box = el.getBoundingClientRect()
      return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && box.width > 0 && box.height > 0
    }
    const textOf = (id) => document.getElementById(id)?.textContent?.trim() ?? ''
    const accessibleName = (el) => {
      const labelled = el.getAttribute('aria-labelledby')?.split(/\s+/).map(textOf).join(' ').trim()
      if (labelled) return labelled
      if (el.getAttribute('aria-label')?.trim()) return el.getAttribute('aria-label').trim()
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
        if (label?.textContent?.trim()) return label.textContent.trim()
      }
      const wrapping = el.closest('label')
      if (wrapping?.textContent?.trim()) return wrapping.textContent.trim()
      if (el.tagName === 'INPUT' && ['hidden', 'submit', 'button'].includes(el.type)) return el.value || el.type
      return el.textContent?.trim() || el.getAttribute('title')?.trim() || ''
    }
    const selector = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.getAttribute('data-testid') ? `[data-testid=${el.getAttribute('data-testid')}]` : ''}`
    const interactive = [...document.querySelectorAll('button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=checkbox],[role=tab]')]
      .filter(visible)
    const unnamed = interactive.filter((el) => !accessibleName(el)).map(selector)
    const imagesMissingAlt = [...document.querySelectorAll('img')].filter((el) => visible(el) && !el.hasAttribute('alt')).map(selector)

    const parse = (value) => {
      const match = value.match(/rgba?\((\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)[, ]+(\d+(?:\.\d+)?)(?:[, /]+(\d+(?:\.\d+)?))?\)/)
      return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : Number(match[4])] : null
    }
    const blend = (front, back) => {
      const a = front[3] + back[3] * (1 - front[3])
      return [0, 1, 2].map((i) => (front[i] * front[3] + back[i] * back[3] * (1 - front[3])) / a).concat(a)
    }
    const background = (el) => {
      let node = el
      let color = [255, 255, 255, 1]
      const layers = []
      while (node) {
        const parsed = parse(getComputedStyle(node).backgroundColor)
        if (parsed && parsed[3] > 0) layers.push(parsed)
        node = node.parentElement
      }
      for (const layer of layers.reverse()) color = blend(layer, color)
      return color
    }
    const luminance = (rgb) => {
      const values = rgb.slice(0, 3).map((part) => {
        const value = part / 255
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * values[0] + 0.7152 * values[1] + 0.0722 * values[2]
    }
    const contrast = (a, b) => {
      const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (light + 0.05) / (dark + 0.05)
    }
    const textNodes = [...document.querySelectorAll('body *')].filter((el) => {
      if (!visible(el) || ['SCRIPT', 'STYLE', 'SVG', 'PATH'].includes(el.tagName)) return false
      return [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim())
    })
    const lowContrast = textNodes.flatMap((el) => {
      const style = getComputedStyle(el)
      const foreground = parse(style.color)
      if (!foreground) return []
      const bg = background(el)
      const fg = blend(foreground, bg)
      const ratio = contrast(fg, bg)
      const size = Number.parseFloat(style.fontSize)
      const bold = Number(style.fontWeight) >= 700
      const threshold = size >= 24 || (size >= 18.66 && bold) ? 3 : 4.5
      return ratio + 0.05 < threshold ? [{ element: selector(el), text: el.textContent.trim().slice(0, 60), color: style.color, background: bg.slice(0, 3).map(Math.round).join(','), ratio: Number(ratio.toFixed(2)), required: threshold }] : []
    })
    return { unnamed, imagesMissingAlt, lowContrast }
  })
  assert(result.unnamed.length === 0, `${label}: unnamed controls ${JSON.stringify(result.unnamed.slice(0, 10))}`)
  assert(result.imagesMissingAlt.length === 0, `${label}: images missing alt ${JSON.stringify(result.imagesMissingAlt)}`)
  assert(result.lowContrast.length === 0, `${label}: low contrast ${JSON.stringify(result.lowContrast.slice(0, 12))}`)
}

async function keyboardFocusAudit(h, label) {
  await h.page.evaluate(() => document.body.focus())
  const failures = []
  for (let index = 0; index < 24; index++) {
    await h.page.keyboard.press('Tab')
    const state = await h.page.evaluate(() => {
      const el = document.activeElement
      if (!el || el === document.body) return { ok: false, tag: 'BODY' }
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return { ok: box.width > 0 && box.height > 0 && style.visibility !== 'hidden', tag: el.tagName, text: el.getAttribute('aria-label') || el.textContent?.trim().slice(0, 30) || el.getAttribute('data-testid') }
    })
    if (!state.ok) failures.push(state)
  }
  assert(failures.length === 0, `${label}: tab focus reached hidden/body elements ${JSON.stringify(failures)}`)
}

await scenario('17-accessibility-gates', async (h) => {
  await h.createCompanyUI('Accessible Books Co')
  await audit(h, 'gateway-light')
  await keyboardFocusAudit(h, 'gateway-light')
  await h.click('btn-customize-home')
  await audit(h, 'customize-gateway-light')
  await keyboardFocusAudit(h, 'customize-gateway-light')
  await h.page.keyboard.press('Escape')

  await h.goto('voucher-entry')
  await audit(h, 'voucher-light')
  await keyboardFocusAudit(h, 'voucher-light')

  await h.goto('trial-balance')
  await audit(h, 'trial-balance-light')

  await h.goto('month-close')
  await audit(h, 'month-close-light')
  await keyboardFocusAudit(h, 'month-close-light')

  await h.goto('collections')
  await audit(h, 'collections-light')

  await h.goto('task-inbox')
  await audit(h, 'task-inbox-light')
  await keyboardFocusAudit(h, 'task-inbox-light')

  await h.goto('supplier-dues')
  await audit(h, 'supplier-dues-light')

  await h.goto('settings')
  await audit(h, 'settings-light')

  await h.click('btn-theme')
  await h.page.waitForTimeout(250)
  await audit(h, 'settings-dark')
  await h.goto('gateway')
  await audit(h, 'gateway-dark')
  await h.shot('01-dark-accessible')
})
