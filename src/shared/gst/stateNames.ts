// Hindi names of the GST states (to-do "wizard state names", PR #105 leftover). Shown only where a
// SIMPLE screen lists states (the setup wizard); every accountant picker keeps `GST_STATE_LIST`'s
// English. Hinglish keeps the English names (they are written that way in Latin script).
// MACHINE-DRAFTED, pending a native speaker's review with the rest of the Hindi text (plan D6).
import type { Language } from '../i18n'
import { GST_STATE_LIST } from './states'

export const GST_STATE_NAMES_HI: Readonly<Record<string, string>> = {
  '01': 'जम्मू और कश्मीर',
  '02': 'हिमाचल प्रदेश',
  '03': 'पंजाब',
  '04': 'चंडीगढ़',
  '05': 'उत्तराखंड',
  '06': 'हरियाणा',
  '07': 'दिल्ली',
  '08': 'राजस्थान',
  '09': 'उत्तर प्रदेश',
  '10': 'बिहार',
  '11': 'सिक्किम',
  '12': 'अरुणाचल प्रदेश',
  '13': 'नागालैंड',
  '14': 'मणिपुर',
  '15': 'मिज़ोरम',
  '16': 'त्रिपुरा',
  '17': 'मेघालय',
  '18': 'असम',
  '19': 'पश्चिम बंगाल',
  '20': 'झारखंड',
  '21': 'ओडिशा',
  '22': 'छत्तीसगढ़',
  '23': 'मध्य प्रदेश',
  '24': 'गुजरात',
  '26': 'दादरा और नगर हवेली और दमन और दीव',
  '27': 'महाराष्ट्र',
  '29': 'कर्नाटक',
  '30': 'गोवा',
  '31': 'लक्षद्वीप',
  '32': 'केरल',
  '33': 'तमिलनाडु',
  '34': 'पुडुचेरी',
  '35': 'अंडमान और निकोबार द्वीपसमूह',
  '36': 'तेलंगाना',
  '37': 'आंध्र प्रदेश',
  '38': 'लद्दाख',
  '96': 'अन्य देश',
  '97': 'अन्य क्षेत्र'
}

/** A state's name in the reader's language: Hindi for `hi`, else the English name. */
export function stateNameIn(code: string, lang: Language | undefined): string {
  const en = GST_STATE_LIST.find(([c]) => c === code)?.[1] ?? code
  return lang === 'hi' ? (GST_STATE_NAMES_HI[code] ?? en) : en
}

/** `GST_STATE_LIST` (code order kept) with the names in the reader's language. */
export function stateListIn(lang: Language | undefined): readonly (readonly [code: string, name: string])[] {
  return GST_STATE_LIST.map(([code]) => [code, stateNameIn(code, lang)] as const)
}
