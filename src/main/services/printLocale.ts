// WP 10.4: prints in the company language. A SIMPLE-mode company whose language (meta
// `ui.language`, set by its owner in How Total looks or by the setup wizard) is Hindi or
// Hinglish prints its bills, receipts, statements and reminders with labels and the amount in
// words in that language; a Hindi print embeds Noto Sans Devanagari. Everything else — every
// accountant-mode company, every English company — gets exactly the options it always had, so
// those prints are byte-identical. If the Devanagari face can't be loaded the print falls back
// to English labels (never boxes for missing glyphs).
import { translator, type Language } from '@shared/i18n'
import { localiseTemplate, printLabelsFor } from '@shared/print/labels'
import type { RenderOptions } from '@shared/print/render'
import type { PrintTemplate } from '@shared/printTemplates'
import type { DB } from '../db/connection'
import { companyLanguage } from '../i18n'
import { getUi } from './config'
import { DEVANAGARI_FAMILY, devanagariFontFaceCss, plexFontFaceCss } from './printFonts'

export interface PrintLocale {
  /** The language the print is in ('en' = not localised). */
  lang: Language
  opts: RenderOptions
  /** The template with its default English words translated (identity when 'en'). */
  template: (t: PrintTemplate) => PrintTemplate
}

const ENGLISH: PrintLocale = { lang: 'en', opts: { fontFaceCss: plexFontFaceCss }, template: (t) => t }

export function printLocale(db: DB): PrintLocale {
  let lang: Language
  try {
    if (getUi(db).mode !== 'simple') return ENGLISH
    lang = companyLanguage(db)
  } catch {
    return ENGLISH
  }
  if (lang === 'en') return ENGLISH
  let scriptFont: RenderOptions['scriptFont']
  if (lang === 'hi') {
    const css = devanagariFontFaceCss()
    if (!css) return ENGLISH
    scriptFont = { css, family: DEVANAGARI_FAMILY }
  }
  const t = translator(lang)
  return {
    lang,
    opts: { fontFaceCss: plexFontFaceCss, labels: printLabelsFor(t), ...(scriptFont ? { scriptFont } : {}) },
    template: (tpl) => localiseTemplate(tpl, t)
  }
}
