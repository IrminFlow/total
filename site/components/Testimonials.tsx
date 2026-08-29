import Link from 'next/link'
import { TESTIMONIALS } from '@/lib/testimonials'

/**
 * Real quotes when there are any, and something that can actually be checked when there are not.
 *
 * There are none. Inventing one would be a false statement about a named firm on a page selling
 * accounting software, and lib/testimonials.ts says what has to be true before an entry goes in.
 * But rendering nothing at all wasted the strongest position on the page. So the empty state says
 * plainly that nobody has written one yet, and then points at the four things a stranger can
 * verify for themselves in the next ten minutes — which is better evidence than a stock photograph
 * and a sentence somebody's marketing department wrote.
 */

const INSTEAD = [
  {
    head: 'The screenshots are the app',
    body: 'Every screen on this site is the real thing on the demo books, not a mockup. The GSTR-1 in the picture was computed from the vouchers above it.',
    href: '/demo',
    link: 'The same screens, step by step'
  },
  {
    head: 'The roadmap is public',
    body: 'Including the things that were asked for and declined, with the reason on the line. What is being built is separated from what already ships.',
    href: '/roadmap',
    link: 'Read the roadmap'
  },
  {
    head: 'So is what Tally does better',
    body: 'Four of them, written by the people who make the competitor. If any one of them is what your business runs on, the page tells you to buy Tally.',
    href: '/compare',
    link: 'Total against TallyPrime'
  },
  {
    head: 'And you can just try it',
    body: 'Thirty days of the whole app with no account and no card. Import a Tally export, run last quarter, and check the figures against what you filed.',
    href: '/download',
    link: 'Download it'
  }
]

export default function Testimonials(): React.JSX.Element {
  if (TESTIMONIALS.length > 0) {
    return (
      <section className="folio" data-reveal>
        <h2 className="serif">What people running it say</h2>
        <p className="sub">Published with permission, in their words, trimmed but not rewritten.</p>
        <div className="quotes">
          {TESTIMONIALS.map((t) => (
            <figure key={t.name}>
              <blockquote>{t.quote}</blockquote>
              <figcaption>
                <b>{t.name}</b>
                <span>{t.place ? `${t.role}, ${t.place}` : t.role}</span>
              </figcaption>
            </figure>
          ))}
        </div>
        <div className="folio-close" aria-hidden="true" />
      </section>
    )
  }

  return (
    <section className="folio" data-reveal>
      <h2 className="serif">Nobody has written us a testimonial yet</h2>
      <p className="sub">
        Total is new, and a quote from a firm that does not exist is not marketing — it is a lie
        with a company name attached to it. Here are four things you can check instead, none of
        which need you to trust a stranger&rsquo;s face.
      </p>
      <div className="instead">
        {INSTEAD.map((item) => (
          <div key={item.head}>
            <h3>{item.head}</h3>
            <p>{item.body}</p>
            <Link href={item.href}>{item.link}</Link>
          </div>
        ))}
      </div>
      <div className="folio-close" aria-hidden="true" />
    </section>
  )
}
