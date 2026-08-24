/**
 * The public roadmap.
 *
 * Curated by hand from the internal catalogue rather than generated from it. The internal list
 * runs to several hundred entries and most of them are one-line refinements nobody outside the
 * project should have to read. What belongs here is the small number of things a buyer would
 * change their mind over.
 *
 * Two rules for anything added below. Nothing appears under "Being built" that is not actually
 * being worked on, and nothing appears under "Shipped" that is not in a released build. A
 * roadmap that quietly promotes wishes to plans is how software gets a reputation.
 */

export interface RoadmapItem {
  title: string
  detail: string
}

export interface RoadmapGroup {
  key: string
  heading: string
  note: string
  items: RoadmapItem[]
}

/** OPERATOR: update this whenever the groups below change. It is shown on the page. */
export const ROADMAP_REVIEWED = '2026-08-24'

export const ROADMAP: RoadmapGroup[] = [
  {
    key: 'shipped',
    heading: 'In the current build',
    note: 'Downloadable today. If one of these does not do what you need, that is a bug, not a plan.',
    items: [
      { title: 'Double-entry books', detail: 'Every voucher type, audit log, soft delete with a bin, opening balances, year end.' },
      { title: 'GST returns', detail: 'GSTR-1 and GSTR-3B on screen, exported as JSON the portal accepts, plus GSTR-2B matching.' },
      { title: 'e-Invoice and e-Way bill', detail: 'Offline JSON for the government tools, with HSN and credit and debit note references.' },
      { title: 'Invoicing and PDF', detail: 'GST tax invoice with tax breakup, amount in words, and your own logo and terms.' },
      { title: 'Stock and manufacturing', detail: 'Bills of materials, batches with expiry, godowns, FIFO and weighted average, price levels.' },
      { title: 'Banking', detail: 'Statement CSV import, matching by amount and date, reconciliation statement, cheque printing.' },
      { title: 'Payroll', detail: 'Pay heads, EPF, ESI and professional tax, TDS on salary, Form 16 and payslip PDFs.' },
      { title: 'Tally import', detail: "Masters and vouchers from Tally's XML export, with a report of what came across." },
      { title: 'Cost centres and budgets', detail: 'Allocation on entry, variance against budget, consolidated reports across companies.' }
    ]
  },
  {
    key: 'building',
    heading: 'Being built now',
    note: 'Work in progress in the repository as this page was last reviewed.',
    items: [
      {
        title: 'MSME payment terms',
        detail:
          'Section 43B(h) has made the 45-day clock a tax question rather than a courtesy. Supplier classification, the due-date calculation and the disallowance report.'
      },
      {
        title: 'Collections',
        detail: 'Chasing money treated as a job of work: a follow-up list, promised dates, and a record of what was said.'
      }
    ]
  },
  {
    key: 'next',
    heading: 'Next, in roughly this order',
    note: 'Committed to, not dated. A date on a one-person project is a guess wearing a suit.',
    items: [
      {
        title: 'Signed and notarised builds',
        detail:
          'Installers are unsigned today, so macOS and Windows both warn on first launch. This is a certificate and a build secret away, and it is the next thing bought.'
      },
      {
        title: 'The full test suite on Windows',
        detail:
          'Unit, database and smoke tests already run there. The end-to-end suite that drives the real UI does not yet.'
      },
      { title: 'Visual regression snapshots', detail: 'Every screen in both themes, so a layout cannot break quietly between releases.' }
    ]
  },
  {
    key: 'considering',
    heading: 'Under consideration',
    note: 'Genuinely undecided. If one of these is what stops you buying, say so and it moves.',
    items: [
      {
        title: 'Multi-user over a network',
        detail:
          'Today Total has local users and roles on one machine. Two people posting at once is a different product, and a decision to make rather than a feature to add.'
      },
      {
        title: 'Live filing to the NIC portal',
        detail:
          'The client is written to the published specification but has never run against the real portal, because there are no credentials to run it with. It ships switched off and labelled as an experiment.'
      },
      { title: 'Voucher templates and bulk edit', detail: 'Save any voucher as a named template; change a narration on many vouchers at once.' }
    ]
  },
  {
    key: 'declined',
    heading: 'Asked for and declined',
    note: 'With the reason, because a no with a reason is more useful than a maybe.',
    items: [
      {
        title: 'Cloud sync',
        detail:
          'The promise is that your books are a folder on your disk. A sync service would be a second copy on somebody else’s, and then the promise is gone.'
      },
      {
        title: 'Type-to-filter on list screens',
        detail:
          'Any letter typed would start filtering, which sounds helpful until it eats the single-letter accelerators. Pressing V to reach voucher entry from any screen is the whole navigation model. Command-F is one keystroke away and costs nothing.'
      }
    ]
  }
]
