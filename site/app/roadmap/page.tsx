import type { Metadata } from 'next'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { ROADMAP, ROADMAP_REVIEWED } from '@/lib/roadmap'
import { SALES_EMAIL } from '@/lib/product'

export const metadata: Metadata = {
  title: 'Roadmap — Total',
  description:
    'What is in the current build of Total, what is being written now, what comes next, and what has been asked for and declined.'
}

export default function RoadmapPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Roadmap</h1>
          <p className="sub">
            Five lists, in descending order of certainty. There are no dates on any of them, because a date on
            a small project is a guess wearing a suit.
          </p>
          <p className="reviewed num">Last reviewed {ROADMAP_REVIEWED}</p>

          {ROADMAP.map((group) => (
            <div className="road-group" key={group.key}>
              <h2>{group.heading}</h2>
              <p className="sub">{group.note}</p>
              <dl className="road-list">
                {group.items.map((item) => (
                  <div key={item.title}>
                    <dt>{item.title}</dt>
                    <dd>{item.detail}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Changing the order</h2>
          <p className="prose">
            The list moves when somebody says which item is stopping them buying. That is more useful than a
            vote and considerably more useful than a survey, so write to{' '}
            <a href={`mailto:${SALES_EMAIL}`}>{SALES_EMAIL}</a> and say which one it is.
          </p>
          <p className="prose">
            What shipped and when is on the <Link href="/changelog">changelog</Link>, taken from the releases
            themselves rather than written up afterwards.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
