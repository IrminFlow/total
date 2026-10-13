import { describe, expect, it } from 'vitest'
import { DEFAULT_FEATURES, effectiveFeatures, mergeFeatures } from '../features'
import { DEFAULT_GROUPS, DEFAULT_UNITS } from '../seed'
import { bannedWordsIn } from './bannedWords'
import { CATEGORIES, CATEGORY_KEYS, expectedClass, groupForNewCategory, isCategoryKey } from './categories'
import { BASE_ACCOUNTS, BUSINESS_TYPES, EXTRA_UNITS, GST_ACCOUNTS, MODULES_OFF_AT_SETUP, PRESETS, presetAccounts, presetFeatures } from './presets'
import { en } from '../i18n'

const groupByName = new Map(DEFAULT_GROUPS.map((g) => [g.name, g]))

describe('categories', () => {
  it('every category sits under a standard group and its class matches the WP 5.6 classifier rule', () => {
    for (const key of CATEGORY_KEYS) {
      const c = CATEGORIES[key]
      const g = groupByName.get(c.group)
      expect(g, `${key} → ${c.group}`).toBeDefined()
      expect(expectedClass(g!.nature, c.name, 'taxType' in c ? c.taxType : null), key).toBe(c.cls)
      // Cash / bank / party groups are never category groups (they carry their own classes).
      expect(['Cash-in-Hand', 'Bank Accounts', 'Bank OD A/c', 'Sundry Debtors', 'Sundry Creditors']).not.toContain(c.group)
    }
  })

  it('sale accounts are income, purchase / expense accounts are expense, tax accounts are tagged under Duties & Taxes', () => {
    for (const key of CATEGORY_KEYS) {
      const c = CATEGORIES[key]
      if (c.use === 'sale' || c.use === 'income') expect(c.cls, key).toBe('income')
      if (c.use === 'purchase' || c.use === 'expense') expect(c.cls, key).toBe('expense')
      if (c.use === 'tax') expect(c.group === 'Duties & Taxes' && 'taxType' in c, key).toBe(true)
      if (c.use === 'owner') expect(c.group, key).toBe('Capital Account')
    }
  })

  it('names are unique, plain and free of banned words', () => {
    const names = CATEGORY_KEYS.map((k) => CATEGORIES[k].name)
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length)
    for (const n of names) expect(bannedWordsIn(n), n).toEqual([])
    // No name collides with a standard group (a picker would show both).
    for (const n of names) expect(groupByName.has(n), n).toBe(false)
  })

  it('the invoice editor finds the rounding account by its name', () => {
    expect(CATEGORIES.round_off.name.toLowerCase()).toBe('round off')
  })

  it('a new category asks one question → a group', () => {
    expect(groupForNewCategory('day_to_day')).toBe('Indirect Expenses')
    expect(groupForNewCategory('stock_you_sell')).toBe('Purchase Accounts')
    expect(groupForNewCategory('stock_you_sell', { makingCost: true })).toBe('Direct Expenses')
    expect(groupForNewCategory('use_for_years')).toBe('Fixed Assets')
    expect(isCategoryKey('rent')).toBe(true)
    expect(isCategoryKey('toString')).toBe(false)
  })
})

describe('presets', () => {
  it('six presets, one per wizard card, each with a catalogue label', () => {
    expect(BUSINESS_TYPES).toHaveLength(6)
    for (const t of BUSINESS_TYPES) {
      expect(PRESETS[t].id).toBe(t)
      expect((en as Record<string, string>)[`simple.setup.type.${t}`], t).toBeTruthy()
    }
  })

  it('every preset seeds the base accounts, its extras, GST accounts only when GST is charged — all carrying a category', () => {
    for (const t of BUSINESS_TYPES) {
      const plain = presetAccounts(t, false)
      const gst = presetAccounts(t, true)
      for (const k of BASE_ACCOUNTS) expect(plain).toContain(k)
      for (const k of PRESETS[t].extraAccounts) expect(plain).toContain(k)
      expect(plain.some((k) => CATEGORIES[k].use === 'tax')).toBe(false)
      expect(gst.filter((k) => CATEGORIES[k].use === 'tax')).toEqual([...GST_ACCOUNTS])
      expect(new Set(gst).size).toBe(gst.length)
      for (const k of gst) expect(isCategoryKey(k)).toBe(true)
      expect(plain).toContain(PRESETS[t].salesAccount)
      expect(CATEGORIES[PRESETS[t].salesAccount].use).toBe('sale')
    }
  })

  it('preset units exist in the seed or the extra units', () => {
    const symbols = new Set([...DEFAULT_UNITS.map((u) => u.symbol), ...EXTRA_UNITS.map((u) => u.symbol)])
    for (const t of BUSINESS_TYPES) {
      expect(PRESETS[t].units.length).toBeGreaterThan(0)
      for (const u of PRESETS[t].units) expect(symbols.has(u), `${t}: ${u}`).toBe(true)
    }
  })

  it('features are written explicitly: the listed modules off, stock as answered, manufacturing only for a manufacturer with stock', () => {
    for (const t of BUSINESS_TYPES) {
      for (const stock of [true, false]) {
        const f = presetFeatures(t, stock)
        for (const m of MODULES_OFF_AT_SETUP) if (m !== 'manufacturing') expect(f[m], `${t} ${m}`).toBe(false)
        expect(f.inventory).toBe(stock)
        expect(f.billWise).toBe(true)
        expect(f.manufacturing).toBe(t === 'manufacturer' && stock)
        expect('manufacturing' in f).toBe(true)
        // Round-trips through the stored-features reader unchanged.
        expect(mergeFeatures(JSON.parse(JSON.stringify(f)))).toEqual(f)
      }
    }
  })

  it('DEFAULT_FEATURES is unchanged and carries no manufacturing key (absent = follows inventory)', () => {
    expect(DEFAULT_FEATURES).toEqual({
      inventory: true, billWise: true, costCentres: true, tds: true, tcs: true, multiCurrency: true, payroll: true,
      preventNegativeStock: false, batches: false, enforceCreditLimit: false, orders: false
    })
    expect(mergeFeatures(null)).toEqual(DEFAULT_FEATURES)
    expect(effectiveFeatures(DEFAULT_FEATURES).manufacturing).toBe(true)
    expect(effectiveFeatures({ ...DEFAULT_FEATURES, inventory: false }).manufacturing).toBe(false)
    expect(effectiveFeatures({ ...DEFAULT_FEATURES, manufacturing: false }).manufacturing).toBe(false)
  })
})
