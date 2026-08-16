import type { Metadata } from 'next'
import { listReleases } from '@/lib/release'
import { mdToHtml } from '@/lib/md'
import SiteNav from '@/components/SiteNav'

export const revalidate = 300

export const metadata: Metadata = {
  title: 'Changelog — Total'
}

function formatDate(iso: string): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

export default async function ChangelogPage(): Promise<React.JSX.Element> {
  const releases = await listReleases()

  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section>
          <h1 className="serif">Changelog</h1>
          <p className="sub">Every published release, straight from GitHub — nothing rewritten after the fact.</p>

          {releases.length === 0 ? (
            <p className="notes">Release notes will appear here once published.</p>
          ) : (
            <div className="notes">
              {releases.map((r) => (
                <article key={r.version} className="release">
                  <div className="release-head">
                    <span className="release-version serif num">v{r.version}</span>
                    <span className="release-date num">{formatDate(r.date)}</span>
                  </div>
                  <div dangerouslySetInnerHTML={{ __html: mdToHtml(r.body || '_No notes for this release._') }} />
                </article>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
