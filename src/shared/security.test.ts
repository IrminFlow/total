// WP 7.2: capability flags (defaults = today's roles), the external-link allow-list, profit redaction.
import { describe, expect, it } from 'vitest'
import { effectiveCapabilities, normaliseFlags, parseFlags, ROLE_DEFAULTS } from './capabilities'
import { allowedExternalUrl } from './externalLinks'
import { redactDashboardSeries, redactHome, PROFIT_HIDDEN_MESSAGE } from './profitRedaction'
import type { SimpleHomeData } from './simple/home'
import type { DashboardSeries } from './dashboard'

describe('capability flags', () => {
  it('no flag = the role, exactly', () => {
    for (const role of ['viewer', 'accountant', 'owner'] as const) {
      expect(effectiveCapabilities(role, null)).toEqual(ROLE_DEFAULTS[role])
      expect(effectiveCapabilities(role, {})).toEqual(ROLE_DEFAULTS[role])
    }
  })

  it('a flag grants or takes away; owners are never restricted', () => {
    expect(effectiveCapabilities('viewer', { canPost: true }).canPost).toBe(true)
    expect(effectiveCapabilities('accountant', { canPost: false }).canPost).toBe(false)
    expect(effectiveCapabilities('owner', { canPost: false, canSeeProfit: false })).toEqual(ROLE_DEFAULTS.owner)
  })

  it('only flags that differ from the role are stored; junk is ignored', () => {
    expect(normaliseFlags('accountant', { canPost: true, canExport: false })).toEqual({ canExport: false })
    expect(normaliseFlags('accountant', { canPost: true })).toBeNull()
    expect(normaliseFlags('owner', { canPost: false })).toBeNull()
    expect(parseFlags('{"canPost":true,"nope":1,"canExport":"x"}')).toEqual({ canPost: true })
    expect(parseFlags('not json')).toBeNull()
    expect(parseFlags(null)).toBeNull()
  })
})

describe('external links (window.open allow-list)', () => {
  it('opens the help pages, mailto: and WhatsApp chats only', () => {
    expect(allowedExternalUrl('https://www.gst.gov.in/help')).toBe('https://www.gst.gov.in/help')
    expect(allowedExternalUrl('mailto:a@b.in?subject=Statement')).toBe('mailto:a@b.in?subject=Statement')
    expect(allowedExternalUrl('https://wa.me/919876543210?text=Hi')).toBe('https://wa.me/919876543210?text=Hi')
  })

  it('refuses everything else', () => {
    for (const bad of [
      'https://evil.example/',
      'http://www.gst.gov.in/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://wa.me.evil.example/x',
      'https://user:pw@wa.me/1',
      'https://wa.me:8443/1',
      'smb://server/share',
      'not a url'
    ]) {
      expect(allowedExternalUrl(bad)).toBeNull()
    }
  })
})

describe('profit redaction', () => {
  it('the dashboard series keeps everything but the trade (profit) section', () => {
    const d = { trade: { ok: true, data: { periodNetProfit: 5 } }, cash: { ok: true, data: { x: 1 } } } as unknown as DashboardSeries
    const r = redactDashboardSeries(d)
    expect(r.trade).toEqual({ ok: false, error: PROFIT_HIDDEN_MESSAGE })
    expect(r.cash).toBe(d.cash)
  })

  it('Home says the profit is hidden and carries no profit figure', () => {
    const lines = { sales: 9, openingStock: 1, purchases: 2, closingStock: 3, costOfGoods: 4, profitOnGoods: 5, otherIncome: 6, expenses: 7, profit: 8 }
    const period = { from: 'a', to: 'b', netProfit: 123, openingStock: 1, closingStock: 2, lines, topExpense: { name: 'Rent', amount: 5 } }
    const home = { profit: { month: { ...period, month: '2026-09' }, year: period, previousMonth: { from: 'a', to: 'b', lines } } } as unknown as SimpleHomeData
    const r = redactHome(home)
    expect(r.profitHidden).toBe(true)
    expect(JSON.stringify(r.profit)).not.toMatch(/:(?!0[,}])\d/)
    expect(r.profit.year.topExpense).toBeNull()
  })
})
