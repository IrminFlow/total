import { TESTIMONIALS } from '@/lib/testimonials'

/**
 * Renders nothing while there are no testimonials, which is the state this ships in.
 *
 * The alternative, a placeholder quote from a person who does not exist, is a false statement
 * about a named firm on a page that sells accounting software. See lib/testimonials.ts for what
 * has to be true before an entry goes in.
 */
export default function Testimonials(): React.JSX.Element | null {
  if (TESTIMONIALS.length === 0) return null

  return (
    <section className="folio">
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
