import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { SEO_PAGES, seoPageBySlug } from '@/lib/seo-pages'

/**
 * The answer pages, at the top level of the site because that is the shape of URL people share.
 *
 * `dynamicParams = false` means only the slugs in lib/seo-pages.ts exist; anything else at the
 * root is a 404 rather than a soft page, so this route cannot quietly swallow a typo in a link.
 */
export const dynamicParams = false

export function generateStaticParams(): { slug: string }[] {
  return SEO_PAGES.map((p) => ({ slug: p.slug }))
}

export async function generateMetadata({
  params
}: {
  params: Promise<{ slug: string }>
}): Promise<Metadata> {
  const { slug } = await params
  const page = seoPageBySlug(slug)
  if (!page) return {}
  return {
    title: page.title,
    description: page.description,
    alternates: { canonical: `/${page.slug}` },
    openGraph: { title: page.title, description: page.description }
  }
}

export default async function AnswerPage({
  params
}: {
  params: Promise<{ slug: string }>
}): Promise<React.JSX.Element> {
  const { slug } = await params
  const page = seoPageBySlug(slug)
  if (!page) notFound()

  // A question-and-answer block that search engines can read. The answers are the same ones on
  // the page, word for word; a schema that says something the page does not is a lie with markup
  // around it.
  const faqSchema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: page.faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a }
    }))
  }

  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">{page.h1}</h1>
          <p className="sub">{page.lede}</p>

          <div className="callout warn" style={{ marginTop: 26 }}>
            <p>
              <b>The short answer.</b> {page.shortAnswer}
            </p>
          </div>

          {page.sections.map((section) => (
            <div key={section.h}>
              <h2>{section.h}</h2>
              {section.p.map((paragraph) => (
                <p className="prose" key={paragraph.slice(0, 32)}>
                  {paragraph}
                </p>
              ))}
            </div>
          ))}
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Questions</h2>
          <dl className="road-list">
            {page.faq.map((item) => (
              <div key={item.q}>
                <dt>{item.q}</dt>
                <dd>{item.a}</dd>
              </div>
            ))}
          </dl>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <div className="get">
          <h2 className="serif">Thirty days, no account</h2>
          <p className="sub">
            No card and no email address. Open your books and see whether the figures agree with yours.
          </p>
          <div className="hero-ctas" style={{ justifyContent: 'center' }}>
            <Link className="btn" href="/download">
              Download Total
            </Link>
            {page.related.map((link) => (
              <Link className="btn ghost" href={link.href} key={link.href}>
                {link.label}
              </Link>
            ))}
          </div>
        </div>
      </div>
      <SiteFooter />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqSchema) }} />
    </>
  )
}
