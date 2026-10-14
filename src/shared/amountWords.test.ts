// WP 10.4: amount in words in Hindi and Hinglish (lakh / crore grouping), against hand-written
// cases. English stays exactly what it was (bulkPayments / cheque tests pin it too).
import { describe, expect, it } from 'vitest'
import { amountInWords } from './money'

const rs = (rupees: number, paise = 0): number => rupees * 100 + paise

describe('amountInWords — Hindi', () => {
  const hi = (p: number): string => amountInWords(p, 'hi')

  it('zero, one rupee and one paisa (singular forms)', () => {
    expect(hi(0)).toBe('शून्य रुपये केवल')
    expect(hi(rs(1))).toBe('एक रुपया केवल')
    expect(hi(1)).toBe('शून्य रुपये और एक पैसा केवल')
  })

  it('11–19 and the irregular two-digit words', () => {
    const teens = ['ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस']
    teens.forEach((word, i) => expect(hi(rs(11 + i))).toBe(`${word} रुपये केवल`))
    expect(hi(rs(21))).toBe('इक्कीस रुपये केवल')
    expect(hi(rs(45))).toBe('पैंतालीस रुपये केवल')
    expect(hi(rs(59))).toBe('उनसठ रुपये केवल')
    expect(hi(rs(79))).toBe('उन्यासी रुपये केवल')
    expect(hi(rs(99))).toBe('निन्यानवे रुपये केवल')
  })

  it('hundreds, thousands, lakh and crore', () => {
    expect(hi(rs(100))).toBe('एक सौ रुपये केवल')
    expect(hi(rs(1234, 50))).toBe('एक हज़ार दो सौ चौंतीस रुपये और पचास पैसे केवल')
    expect(hi(rs(100000))).toBe('एक लाख रुपये केवल')
    expect(hi(rs(120000))).toBe('एक लाख बीस हज़ार रुपये केवल')
    expect(hi(rs(10000000))).toBe('एक करोड़ रुपये केवल')
    expect(hi(rs(2050000))).toBe('बीस लाख पचास हज़ार रुपये केवल')
  })

  it('the largest grouped amount: 99,99,99,999.99', () => {
    expect(hi(rs(999999999, 99))).toBe('निन्यानवे करोड़ निन्यानवे लाख निन्यानवे हज़ार नौ सौ निन्यानवे रुपये और निन्यानवे पैसे केवल')
  })

  it('a negative amount says so', () => {
    expect(hi(-rs(5))).toBe('ऋण पाँच रुपये केवल')
  })
})

describe('amountInWords — Hinglish', () => {
  const hg = (p: number): string => amountInWords(p, 'hinglish')

  it('zero, one rupee and one paisa', () => {
    expect(hg(0)).toBe('Shunya rupaye')
    expect(hg(rs(1))).toBe('Ek rupaya')
    expect(hg(1)).toBe('Shunya rupaye aur ek paisa')
  })

  it('11–19, 21 and 100', () => {
    const teens = ['Gyaarah', 'Baarah', 'Terah', 'Chaudah', 'Pandrah', 'Solah', 'Satrah', 'Athaarah', 'Unnees']
    teens.forEach((word, i) => expect(hg(rs(11 + i))).toBe(`${word} rupaye`))
    expect(hg(rs(21))).toBe('Ikkees rupaye')
    expect(hg(rs(100))).toBe('Ek sau rupaye')
  })

  it('lakh and crore', () => {
    expect(hg(rs(100000))).toBe('Ek lakh rupaye')
    expect(hg(rs(120000))).toBe('Ek lakh bees hazaar rupaye')
    expect(hg(rs(10000000))).toBe('Ek crore rupaye')
    expect(hg(rs(1234, 50))).toBe('Ek hazaar do sau chauntees rupaye aur pachaas paise')
    expect(hg(rs(999999999, 99))).toBe('Ninyaanve crore ninyaanve lakh ninyaanve hazaar nau sau ninyaanve rupaye aur ninyaanve paise')
  })
})

describe('amountInWords — English unchanged', () => {
  it('no language, en or an unknown language give the English words', () => {
    expect(amountInWords(rs(120000))).toBe('One Lakh Twenty Thousand Rupees Only')
    expect(amountInWords(rs(120000), 'en')).toBe('One Lakh Twenty Thousand Rupees Only')
    expect(amountInWords(rs(0))).toBe('Zero Rupees Only')
    expect(amountInWords(rs(999999999, 99))).toBe(
      'Ninety Nine Crore Ninety Nine Lakh Ninety Nine Thousand Nine Hundred Ninety Nine Rupees and Ninety Nine Paise Only'
    )
  })
})
