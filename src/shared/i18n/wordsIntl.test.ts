import { describe, it, expect } from 'vitest'
import { amountInWords } from '../money'
import { amountInWordsIn } from './wordsIntl'

describe("amountInWordsIn — 'none'", () => {
  it('is byte-identical to amountInWords, so English has exactly one implementation', () => {
    const samples = [0, 1, 99, 100, 12345, 100000_00, 1_00_00_000_00, 123456_78, -50_00, 999999999999]
    for (const paise of samples) {
      expect(amountInWordsIn(paise, 'none'), String(paise)).toBe(amountInWords(paise))
    }
  })
})

describe('amountInWordsIn — Hindi', () => {
  it('writes zero as शून्य रुपये, not as an empty amount', () => {
    expect(amountInWordsIn(0, 'hi')).toBe('शून्य रुपये मात्र')
  })

  it('writes one rupee, mirroring the English line that also always says Rupees', () => {
    expect(amountInWordsIn(100, 'hi')).toBe('एक रुपये मात्र')
  })

  it('writes a bare paise amount with no rupee words lost', () => {
    expect(amountInWordsIn(99, 'hi')).toBe('शून्य रुपये और निन्यानवे पैसे मात्र')
  })

  it('uses the irregular Devanagari numerals above twenty', () => {
    expect(amountInWordsIn(2100, 'hi')).toBe('इक्कीस रुपये मात्र')
    expect(amountInWordsIn(9900, 'hi')).toBe('निन्यानवे रुपये मात्र')
  })

  it('breaks at the lakh boundary exactly', () => {
    expect(amountInWordsIn(99999 * 100, 'hi')).toBe('निन्यानवे हज़ार नौ सौ निन्यानवे रुपये मात्र')
    expect(amountInWordsIn(100000 * 100, 'hi')).toBe('एक लाख रुपये मात्र')
  })

  it('breaks at the crore boundary exactly', () => {
    expect(amountInWordsIn(9999999 * 100, 'hi')).toBe(
      'निन्यानवे लाख निन्यानवे हज़ार नौ सौ निन्यानवे रुपये मात्र'
    )
    expect(amountInWordsIn(10000000 * 100, 'hi')).toBe('एक करोड़ रुपये मात्र')
  })

  it('joins rupees and paise with और', () => {
    expect(amountInWordsIn(123456_78, 'hi')).toBe(
      'एक लाख तेईस हज़ार चार सौ छप्पन रुपये और अठहत्तर पैसे मात्र'
    )
  })

  it('turns a negative amount into a leading word, never a sign', () => {
    expect(amountInWordsIn(-150_50, 'hi')).toBe('ऋण एक सौ पचास रुपये और पचास पैसे मात्र')
    expect(amountInWordsIn(-150_50, 'hi')).not.toMatch(/-/)
  })

  it('handles the largest amount an invoice realistically carries (99,99,99,999.99)', () => {
    const out = amountInWordsIn(9999999999_99, 'hi')
    expect(out).toBe(
      'नौ सौ निन्यानवे करोड़ निन्यानवे लाख निन्यानवे हज़ार नौ सौ निन्यानवे रुपये और निन्यानवे पैसे मात्र'
    )
  })

  it('never emits undefined or NaN for any amount across the whole range', () => {
    for (let rupees = 0; rupees <= 100000; rupees += 977) {
      const out = amountInWordsIn(rupees * 100 + (rupees % 100), 'hi')
      expect(out).not.toMatch(/undefined|NaN/)
      expect(out.trim()).toBe(out)
      expect(out).not.toMatch(/ {2}/)
    }
  })
})

describe('amountInWordsIn — Marathi', () => {
  it('writes zero as शून्य रुपये', () => {
    expect(amountInWordsIn(0, 'mr')).toBe('शून्य रुपये फक्त')
  })

  it('writes one rupee', () => {
    expect(amountInWordsIn(100, 'mr')).toBe('एक रुपये फक्त')
  })

  it('breaks at the lakh and कोटी boundaries exactly', () => {
    expect(amountInWordsIn(100000 * 100, 'mr')).toBe('एक लाख रुपये फक्त')
    expect(amountInWordsIn(10000000 * 100, 'mr')).toBe('एक कोटी रुपये फक्त')
  })

  it('joins rupees and paise with आणि and closes with फक्त', () => {
    expect(amountInWordsIn(123456_78, 'mr')).toBe(
      'एक लाख तेवीस हजार चार शे छप्पन्न रुपये आणि अठ्ठ्याहत्तर पैसे फक्त'
    )
  })

  it('turns a negative amount into उणे, never a sign', () => {
    expect(amountInWordsIn(-150_50, 'mr')).toBe('उणे एक शे पन्नास रुपये आणि पन्नास पैसे फक्त')
    expect(amountInWordsIn(-150_50, 'mr')).not.toMatch(/-/)
  })

  it('handles 99,99,99,999.99', () => {
    expect(amountInWordsIn(9999999999_99, 'mr')).toBe(
      'नऊ शे नव्याण्णव कोटी नव्याण्णव लाख नव्याण्णव हजार नऊ शे नव्याण्णव रुपये आणि नव्याण्णव पैसे फक्त'
    )
  })

  it('never emits undefined or NaN for any amount across the whole range', () => {
    for (let rupees = 0; rupees <= 100000; rupees += 977) {
      const out = amountInWordsIn(rupees * 100 + (rupees % 100), 'mr')
      expect(out).not.toMatch(/undefined|NaN/)
      expect(out).not.toMatch(/ {2}/)
    }
  })
})

describe('amountInWordsIn — integer discipline', () => {
  it('reads paise off the integer, so 1999 paise is nineteen rupees and ninety-nine paise', () => {
    expect(amountInWordsIn(1999, 'hi')).toBe('उन्नीस रुपये और निन्यानवे पैसे मात्र')
  })

  it('treats a value and its negation as the same words plus the minus word', () => {
    const positive = amountInWordsIn(4567_89, 'hi')
    expect(amountInWordsIn(-4567_89, 'hi')).toBe('ऋण ' + positive)
  })
})
