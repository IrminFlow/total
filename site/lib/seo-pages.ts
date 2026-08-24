/**
 * Landing pages for the things people actually type into a search box.
 *
 * Not keyword pages in the usual sense. Each one answers a question a real person has, tells
 * them where Total does not fit before it tells them where it does, and links to the
 * documentation rather than looping back to the download button. If somebody reads one of these
 * and decides to stay on Tally, the page did its job.
 *
 * Every route lives at the top level of the site because that is the shape of URL people share.
 */

export interface SeoSection {
  h: string
  p: string[]
}

export interface SeoPage {
  slug: string
  /** Title tag. Written for a result listing, not for the page. */
  title: string
  description: string
  h1: string
  lede: string
  /** The answer, before the argument for it. */
  shortAnswer: string
  sections: SeoSection[]
  faq: { q: string; a: string }[]
  related: { href: string; label: string }[]
}

export const SEO_PAGES: SeoPage[] = [
  {
    slug: 'tally-alternative-for-mac',
    title: 'Tally for Mac: what to use instead',
    description:
      'TallyPrime has no macOS build. The options are a Windows virtual machine, Wine, or a native Mac accounting app. What each one costs you.',
    h1: 'There is no Tally for Mac',
    lede: 'The usual answers are a Windows virtual machine, Wine, or a native app. Here is what each one costs.',
    shortAnswer:
      'TallyPrime is a Windows program. On a Mac you either run Windows underneath it or you use something else. Total is the something else: a native Mac app with the same function keys and the same double-entry books.',
    sections: [
      {
        h: 'Running Windows underneath it',
        p: [
          'Parallels or VMware plus a Windows licence plus Tally comes to a real yearly bill, and every one of those three has to be kept current. It works, and thousands of accountants do it, but you are maintaining two operating systems to keep one ledger.',
          'On Apple Silicon you also need the ARM build of Windows, which narrows what runs cleanly inside it.'
        ]
      },
      {
        h: 'Wine and the free wrappers',
        p: [
          'Tally under Wine gets as far as the gateway for most people and falls over somewhere between printing and the ODBC connector. It is fine for looking at last year. It is not somewhere to keep this year.'
        ]
      },
      {
        h: 'A native app',
        p: [
          'Total is built for macOS and Windows and keeps the muscle memory: F4 to F9 for contra, payment, receipt, journal, sales and purchase, Enter walking the voucher field by field, a red accelerator letter on every menu item.',
          'It reads Tally XML exports, so masters and vouchers come across rather than being retyped. Where it is behind Tally, the comparison page says so, item by item.'
        ]
      }
    ],
    faq: [
      {
        q: 'Can I open my existing Tally company on a Mac?',
        a: 'Not the company folder itself. Export from Tally as XML and import that. Masters and vouchers come across with a report of anything that did not.'
      },
      {
        q: 'Do the Tally function keys work?',
        a: 'F4 to F9 are where twenty years of habit left them, and Enter chains through a voucher with an accept bar at the end.'
      },
      {
        q: 'Is my data in the cloud?',
        a: 'No. Every company is a SQLite file under ~/Documents/total on your own machine. The app has no account and makes no network call for your books.'
      }
    ],
    related: [
      { href: '/compare', label: 'Total against TallyPrime, row by row' },
      { href: '/docs/coming-from-tally', label: 'Coming from Tally' }
    ]
  },
  {
    slug: 'gst-billing-software-for-small-business',
    title: 'GST billing software for a small business',
    description:
      'What GST billing software has to do to be worth installing: a compliant tax invoice, HSN, place of supply, and a return you can file without retyping.',
    h1: 'GST billing software for a small business',
    lede: 'Four things separate billing software that helps from billing software that becomes another place to retype figures.',
    shortAnswer:
      'A tax invoice with the fields the rules require, HSN and place of supply captured at entry, a return computed from those invoices rather than typed again, and books that stay yours when the subscription ends.',
    sections: [
      {
        h: 'The invoice has to be a tax invoice',
        p: [
          'Rule 46 lists what a tax invoice carries: both GSTINs, a serial number in an unbroken series, place of supply, HSN, the rate and amount of each tax shown separately, and the value in words. Software that prints a pretty bill missing three of those has not saved you anything.',
          'Total prints the tax breakup, the HSN summary and the amount in words, and checks the GSTIN check digit as you type it.'
        ]
      },
      {
        h: 'The return has to come from the invoices',
        p: [
          'The retyping is the expensive part. If GSTR-1 is assembled from a spreadsheet at the end of the month, every month contains a chance to get it wrong.',
          'Every report in Total is computed from voucher lines when you open it, so the return and the sales register cannot disagree.'
        ]
      },
      {
        h: 'Watch what happens when you stop paying',
        p: [
          'Most billing software is a subscription to a server, and when the subscription ends the books go behind a paywall or leave as a CSV. Ask before you start, not in year three.',
          'Total stores each company as one SQLite file in a folder you can copy. If a licence lapses the app still opens every company, prints, exports and backs up. Only posting new entries pauses.'
        ]
      }
    ],
    faq: [
      {
        q: 'Does it file the return for me?',
        a: 'It produces the JSON the government offline tool accepts, and you upload that. Nothing is transmitted from your machine without you doing it.'
      },
      {
        q: 'Does it handle e-invoicing?',
        a: 'It produces the e-invoice and e-way bill JSON the government tools accept. Direct filing to the NIC portal exists but has never been run against the live portal, so it ships as an experiment.'
      },
      { q: 'Is there a per-user charge?', a: 'No. The licence covers the business, not the person at the keyboard.' }
    ],
    related: [
      { href: '/docs/gst-returns', label: 'How GST returns work in Total' },
      { href: '/pricing', label: 'What it costs' }
    ]
  },
  {
    slug: 'gstr-1-json-for-the-offline-tool',
    title: 'Making a GSTR-1 JSON file for the offline tool',
    description:
      'How to produce a GSTR-1 JSON the GST offline utility will accept, what the common rejections mean, and how to check the figures before you upload.',
    h1: 'Making a GSTR-1 JSON the offline tool accepts',
    lede: 'The file is the easy half. The rejections are almost always something upstream in the invoices.',
    shortAnswer:
      'Export GSTR-1 as JSON from your books, open the GST offline utility, import it, and upload the generated file on the portal. If the utility rejects it, the fault is nearly always a GSTIN, a place of supply, or an invoice number that repeats.',
    sections: [
      {
        h: 'Check the figures before the file',
        p: [
          'Open the return on screen first and read it against your sales register for the same period. The two are computed from the same voucher lines, so a difference means a voucher is misclassified rather than that the export is wrong.',
          'B2B, B2C large, B2C small, credit and debit notes, exports and nil rated each have their own section, and an invoice in the wrong one passes validation and fails reconciliation later.'
        ]
      },
      {
        h: 'What the common rejections mean',
        p: [
          'An invalid GSTIN is a check-digit failure, which means the number was mistyped when the party was created rather than at export. Fix the master and export again.',
          'A duplicate invoice number usually means the same number appears in two financial years, or a manual voucher reused a number after a cancellation.',
          'A place of supply mismatch means an intra-state invoice carrying IGST or the reverse. That is a tax calculation to correct, not an export setting.'
        ]
      },
      {
        h: 'Keep the file',
        p: [
          'Save the JSON you actually uploaded alongside the return. When a notice arrives eighteen months later, the question is what you filed, and the only honest answer is the file itself.'
        ]
      }
    ],
    faq: [
      {
        q: 'Does Total upload the return for me?',
        a: 'No. It writes the JSON and you upload it, the way offline Tally users have always filed. Nothing leaves your machine on its own.'
      },
      {
        q: 'Which sections does the export cover?',
        a: 'B2B, B2C large and small, credit and debit notes, exports, nil rated and exempt, and the HSN summary.'
      },
      { q: 'What about GSTR-3B?', a: 'Computed on the same screen from the same vouchers, with the values to key into the portal.' }
    ],
    related: [
      { href: '/docs/gst-returns', label: 'GST returns, in full' },
      { href: '/demo', label: 'Watch a GSTR-1 export' }
    ]
  },
  {
    slug: 'accounting-software-without-a-subscription',
    title: 'Accounting software you buy once, without a subscription',
    description:
      'What a one-time licence actually means, the questions to ask before buying, and what happens to your books when you stop paying.',
    h1: 'Accounting software without a subscription',
    lede: 'The phrase covers three quite different arrangements. Only one of them still works in year five.',
    shortAnswer:
      'Ask two questions. Does the software keep running when payment stops, and are the books in a format you can open without it? If either answer is no, you are renting whether or not the invoice says subscription.',
    sections: [
      {
        h: 'The three arrangements',
        p: [
          'A subscription to a server: stop paying and the books are behind a login you no longer have. Your escape route is an export, and you should test it in the first month rather than the last.',
          'A yearly licence for software on your machine: stop paying and it keeps running, or it does not, depending entirely on what the vendor decided. Ask.',
          'A perpetual licence: the version you bought keeps working, and you pay again only for newer versions. Rarer every year.'
        ]
      },
      {
        h: 'The format question is the bigger one',
        p: [
          'Software outlives its vendor about as often as it does not. If the books are in a proprietary format, the vendor going quiet is your problem. If they are in something standard, it is an inconvenience.',
          'Total keeps each company as one SQLite file, which is an open, documented format any developer can read, and takes an automatic snapshot every time the books open.'
        ]
      },
      {
        h: 'What Total does when a licence lapses',
        p: [
          'It keeps opening every company, reading every report, printing, exporting to PDF, CSV and Tally XML, and taking backups. Only posting new entries pauses until you renew.',
          'That is written down here so it can be held against us. Nobody should be shut out of their own accounts because a payment failed.'
        ]
      }
    ],
    faq: [
      { q: 'Is there a perpetual licence?', a: 'Yes, with a year of updates included. Renew afterwards only if you want newer versions.' },
      { q: 'What happens on a new computer?', a: 'Copy the ~/Documents/total folder across and paste the same key. There is no activation server to ask.' },
      { q: 'Is there a trial?', a: 'Thirty days, with no account, no card and no email address.' }
    ],
    related: [
      { href: '/pricing', label: 'Prices and the fail-soft promise' },
      { href: '/docs/backups', label: 'Backups and where your data lives' }
    ]
  },
  {
    slug: 'e-invoice-json-format-generator',
    title: 'Generating e-invoice JSON for the IRP',
    description:
      'The e-invoice schema, which fields trip people up, and how to produce a JSON the government offline tool accepts without a filing subscription.',
    h1: 'Generating e-invoice JSON',
    lede: 'The schema is public and the offline tool is free. What most people are paying for is the typing.',
    shortAnswer:
      'Produce the JSON from the invoice you already raised, validate it in the government offline tool, and register it. A filing subscription buys convenience, not permission.',
    sections: [
      {
        h: 'Where the JSON usually fails',
        p: [
          'HSN missing on a line. The schema requires it, and an item master created in a hurry is where it goes missing.',
          'Place of supply against the wrong state code, which makes the tax split disagree with the addresses.',
          'A unit of measure outside the permitted list. The schema takes a fixed set of codes, not whatever the item card says.',
          'Credit and debit notes without the original invoice reference, which the schema needs to attach them to something.'
        ]
      },
      {
        h: 'The e-way bill is the same data twice',
        p: [
          'Most of an e-way bill is already on the invoice: parties, values, HSN, distance and transport details. If your software makes you enter it again, it is not reading its own invoice.',
          'Total produces both from the same voucher, with the credit and debit note references carried through.'
        ]
      },
      {
        h: 'On live filing',
        p: [
          'Total has a client for the NIC APIs, written to the published specification. It has never been run against the real portal, because there are no credentials to run it with, and it is labelled an experiment inside the app for exactly that reason.',
          'The offline JSON path is the one that is tested, and it is the one to rely on.'
        ]
      }
    ],
    faq: [
      { q: 'Do I need a paid service to generate e-invoice JSON?', a: 'No. The schema is published and the government offline tool is free.' },
      { q: 'Does Total register the invoice and return the IRN?', a: 'Not reliably. The live client is untested against the portal and ships switched off. Use the offline tool.' },
      { q: 'Are e-way bills included?', a: 'Yes, built from the same voucher as the invoice.' }
    ],
    related: [
      { href: '/docs/gst-returns', label: 'GST returns and e-documents' },
      { href: '/compare', label: 'Where Tally is still ahead' }
    ]
  }
]

export function seoPageBySlug(slug: string): SeoPage | undefined {
  return SEO_PAGES.find((p) => p.slug === slug)
}
