/**
 * Amount-in-words in the invoice's chosen language (roadmap I-199).
 *
 * The Indian numbering system, in Devanagari: करोड़ / लाख / हज़ार / सौ. This is a sibling of
 * `amountInWords` in ../money, not a replacement — the English implementation stays the only one,
 * and 'none' delegates to it rather than reproducing it, so the two can never drift.
 *
 * Money is integer paise. Everything below is integer division and modulo; no float ever touches
 * an amount here, and there is no `toFixed`, no `/ 100` that keeps a remainder.
 */

import { amountInWords } from '../money'
import type { InvoiceLanguage } from './invoiceLabels'

/**
 * 0–99 spelled out, one entry per number.
 *
 * Devanagari numerals above twenty are irregular (21 is इक्कीस, not "twenty one"), so a
 * tens-plus-ones generator like the English one produces words that do not exist. The table is
 * the only honest way to do this, and it is small enough to read.
 */
const HI_ONES = [
  '', 'एक', 'दो', 'तीन', 'चार', 'पाँच', 'छह', 'सात', 'आठ', 'नौ',
  'दस', 'ग्यारह', 'बारह', 'तेरह', 'चौदह', 'पंद्रह', 'सोलह', 'सत्रह', 'अठारह', 'उन्नीस',
  'बीस', 'इक्कीस', 'बाईस', 'तेईस', 'चौबीस', 'पच्चीस', 'छब्बीस', 'सत्ताईस', 'अट्ठाईस', 'उनतीस',
  'तीस', 'इकतीस', 'बत्तीस', 'तैंतीस', 'चौंतीस', 'पैंतीस', 'छत्तीस', 'सैंतीस', 'अड़तीस', 'उनतालीस',
  'चालीस', 'इकतालीस', 'बयालीस', 'तैंतालीस', 'चौवालीस', 'पैंतालीस', 'छियालीस', 'सैंतालीस', 'अड़तालीस', 'उनचास',
  'पचास', 'इक्यावन', 'बावन', 'तिरपन', 'चौवन', 'पचपन', 'छप्पन', 'सत्तावन', 'अट्ठावन', 'उनसठ',
  'साठ', 'इकसठ', 'बासठ', 'तिरसठ', 'चौंसठ', 'पैंसठ', 'छियासठ', 'सड़सठ', 'अड़सठ', 'उनहत्तर',
  'सत्तर', 'इकहत्तर', 'बहत्तर', 'तिहत्तर', 'चौहत्तर', 'पचहत्तर', 'छिहत्तर', 'सतहत्तर', 'अठहत्तर', 'उन्यासी',
  'अस्सी', 'इक्यासी', 'बयासी', 'तिरासी', 'चौरासी', 'पचासी', 'छियासी', 'सत्तासी', 'अट्ठासी', 'नवासी',
  'नब्बे', 'इक्यानवे', 'बानवे', 'तिरानवे', 'चौरानवे', 'पंचानवे', 'छियानवे', 'सत्तानवे', 'अट्ठानवे', 'निन्यानवे'
]

const MR_ONES = [
  '', 'एक', 'दोन', 'तीन', 'चार', 'पाच', 'सहा', 'सात', 'आठ', 'नऊ',
  'दहा', 'अकरा', 'बारा', 'तेरा', 'चौदा', 'पंधरा', 'सोळा', 'सतरा', 'अठरा', 'एकोणीस',
  'वीस', 'एकवीस', 'बावीस', 'तेवीस', 'चोवीस', 'पंचवीस', 'सव्वीस', 'सत्तावीस', 'अठ्ठावीस', 'एकोणतीस',
  'तीस', 'एकतीस', 'बत्तीस', 'तेहतीस', 'चौतीस', 'पस्तीस', 'छत्तीस', 'सदतीस', 'अडतीस', 'एकोणचाळीस',
  'चाळीस', 'एक्केचाळीस', 'बेचाळीस', 'त्रेचाळीस', 'चव्वेचाळीस', 'पंचेचाळीस', 'सेहेचाळीस', 'सत्तेचाळीस', 'अठ्ठेचाळीस', 'एकोणपन्नास',
  'पन्नास', 'एकावन्न', 'बावन्न', 'त्रेपन्न', 'चौपन्न', 'पंचावन्न', 'छप्पन्न', 'सत्तावन्न', 'अठ्ठावन्न', 'एकोणसाठ',
  'साठ', 'एकसष्ट', 'बासष्ट', 'त्रेसष्ट', 'चौसष्ट', 'पासष्ट', 'सहासष्ट', 'सदुसष्ट', 'अडुसष्ट', 'एकोणसत्तर',
  'सत्तर', 'एकाहत्तर', 'बाहत्तर', 'त्र्याहत्तर', 'चौऱ्याहत्तर', 'पंच्याहत्तर', 'शहात्तर', 'सत्त्याहत्तर', 'अठ्ठ्याहत्तर', 'एकोणऐंशी',
  'ऐंशी', 'एक्याऐंशी', 'ब्याऐंशी', 'त्र्याऐंशी', 'चौऱ्याऐंशी', 'पंच्याऐंशी', 'शहाऐंशी', 'सत्त्याऐंशी', 'अठ्ठ्याऐंशी', 'एकोणनव्वद',
  'नव्वद', 'एक्याण्णव', 'ब्याण्णव', 'त्र्याण्णव', 'चौऱ्याण्णव', 'पंच्याण्णव', 'शहाण्णव', 'सत्त्याण्णव', 'अठ्ठ्याण्णव', 'नव्याण्णव'
]

interface Vocabulary {
  ones: string[]
  zero: string
  hundred: string
  thousand: string
  lakh: string
  crore: string
  rupees: string
  paise: string
  /** Joins the rupee part to the paise part — English's "and". */
  and: string
  /** English's trailing "Only", which closes the amount so nothing can be appended to it. */
  only: string
  /** English's leading "Minus". */
  minus: string
}

const VOCAB: Record<'hi' | 'mr', Vocabulary> = {
  hi: {
    ones: HI_ONES,
    zero: 'शून्य',
    hundred: 'सौ',
    thousand: 'हज़ार',
    lakh: 'लाख',
    crore: 'करोड़',
    // Always plural, exactly as the English implementation always prints "Rupees" (even for one).
    // The two lines are printed beside each other; matching their shape matters more than the
    // singular "एक रुपया" being marginally better Hindi on its own.
    rupees: 'रुपये',
    paise: 'पैसे',
    and: 'और',
    only: 'मात्र',
    minus: 'ऋण' // VERIFY: "ऋण" is the arithmetic term; ledgers often print the loanword "माइनस".
  },
  mr: {
    ones: MR_ONES,
    zero: 'शून्य',
    // VERIFY: Marathi normally fuses the hundred onto the digit (दोनशे, तीनशे) and uses शंभर
    // standing alone. Kept as a separate word so the generator stays one code path; a Marathi
    // bookkeeper should confirm "दोन शे" is acceptable on a printed bill before this is settled.
    hundred: 'शे',
    thousand: 'हजार',
    lakh: 'लाख',
    crore: 'कोटी',
    rupees: 'रुपये',
    paise: 'पैसे',
    and: 'आणि',
    only: 'फक्त',
    minus: 'उणे'
  }
}

function twoDigits(n: number, v: Vocabulary): string {
  return v.ones[n] ?? ''
}

function threeDigits(n: number, v: Vocabulary): string {
  const h = Math.trunc(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (h) parts.push(`${v.ones[h]} ${v.hundred}`)
  if (rest) parts.push(twoDigits(rest, v))
  return parts.join(' ')
}

/** Indian grouping: crore, lakh, thousand, then the last three digits. Recurses for the crore
 *  part so amounts above 99 crore ("नौ सौ निन्यानवे करोड़") still read correctly. */
function integerWords(n: number, v: Vocabulary): string {
  if (n === 0) return v.zero
  const crore = Math.trunc(n / 10000000)
  const lakh = Math.trunc((n % 10000000) / 100000)
  const thousand = Math.trunc((n % 100000) / 1000)
  const rest = n % 1000
  const parts: string[] = []
  if (crore) parts.push(`${integerWords(crore, v)} ${v.crore}`)
  if (lakh) parts.push(`${twoDigits(lakh, v)} ${v.lakh}`)
  if (thousand) parts.push(`${twoDigits(thousand, v)} ${v.thousand}`)
  if (rest) parts.push(threeDigits(rest, v))
  return parts.join(' ')
}

/**
 * Amount in words for the chosen invoice language.
 *
 * 'none' delegates to `amountInWords` so there is exactly one English implementation — this
 * function must never be the place an English wording quietly diverges from the rest of the app.
 *
 * @param paise integer paise (negative allowed; the minus becomes a word, never a sign)
 */
export function amountInWordsIn(paise: number, lang: InvoiceLanguage): string {
  if (lang === 'none') return amountInWords(paise)
  const v = VOCAB[lang]
  // An unknown language must still print something a reader can act on, so fall back to English
  // rather than to an empty amount-in-words line.
  if (!v) return amountInWords(paise)

  const n = Math.trunc(paise)
  const negative = n < 0
  const abs = Math.abs(n)
  const rupees = Math.trunc(abs / 100)
  const p = abs % 100

  let words = `${integerWords(rupees, v)} ${v.rupees}`
  if (p) words += ` ${v.and} ${twoDigits(p, v)} ${v.paise}`
  words += ` ${v.only}`
  return (negative ? `${v.minus} ` : '') + words
}
