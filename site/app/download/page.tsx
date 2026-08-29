import type { Metadata } from 'next'
import Link from 'next/link'
import ReminderForm from '@/components/ReminderForm'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import { latestRelease, releaseChecksums, RELEASES_PAGE } from '@/lib/release'

export const metadata: Metadata = {
  title: 'Download Total',
  description:
    'Download Total for macOS or Windows, with the SHA-512 of every installer and a plain account of what is signed and what is not.'
}

export const revalidate = 300

function megabytes(bytes: number | undefined): string {
  if (!bytes) return ''
  return `${(bytes / 1_048_576).toFixed(1)} MB`
}

export default async function DownloadPage(): Promise<React.JSX.Element> {
  const release = await latestRelease()
  const checksums = await releaseChecksums()

  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">Download Total</h1>
          <p className="sub">
            Thirty days of everything, with no account, no card and no email address. Then a key, or not.
          </p>
          <div className="hero-ctas">
            <a className="btn" href="/api/download?platform=mac">
              macOS
            </a>
            <a className="btn ghost" href="/api/download?platform=win">
              Windows
            </a>
          </div>
          <p className="fine num" style={{ marginTop: 14 }}>
            {release ? `Version ${release.version}` : 'No release published yet'}
            {release ? ' · macOS 12 or later, Apple Silicon and Intel · Windows 10 or later' : ''}
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Signing, honestly</h2>
          <p className="prose">
            <b>The installers are not signed yet.</b> That is not a detail we would rather you found out
            after downloading, so here is exactly what happens and why.
          </p>
          <p className="prose">
            On macOS, Gatekeeper will refuse to open the app on first launch and say it cannot check it for
            malicious software. Open the folder, right-click the app, choose Open, and confirm. You only do
            it once. On Windows, SmartScreen shows a blue panel; choose More info, then Run anyway.
          </p>
          <p className="prose">
            The reason is an Apple Developer ID and a Windows code-signing certificate, which are a yearly
            cost and an identity check rather than a technical problem. The build already runs under the
            hardened runtime with the entitlements notarisation needs, so the day the certificates exist the
            next release is signed and notarised and none of this applies. It is the next thing bought, and
            it is on the <Link href="/roadmap">roadmap</Link> in those words.
          </p>
          <p className="prose">
            Until then, the checksums below are how you satisfy yourself that the file you have is the file
            we published. They are worth doing on a machine that is about to hold your books.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">Checksums</h2>
          <p className="sub">
            SHA-512, base64, read from the update manifest published beside the installers. The app&rsquo;s own
            updater checks the same values, so this page cannot quote a hash the updater disagrees with.
          </p>

          {checksums.length > 0 ? (
            <div className="ledger" style={{ marginTop: 22 }}>
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>SHA-512 (base64)</th>
                    <th className="r">Size</th>
                  </tr>
                </thead>
                <tbody>
                  {checksums.map((c) => (
                    <tr key={c.name}>
                      <td className="f">{c.name}</td>
                      <td className="p hash num">{c.sha512}</td>
                      <td className="r amt">{megabytes(c.bytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="callout" style={{ marginTop: 22 }}>
              <p>
                No checksums to show. Either nothing has been released yet, or the manifest could not be read
                from this deployment. The <a href={RELEASES_PAGE}>releases page</a> has the files themselves.
              </p>
            </div>
          )}

          <h3>Checking one</h3>
          <p className="prose">On macOS or Linux:</p>
          <pre>
            <code>openssl dgst -sha512 -binary Total.dmg | openssl base64 -A</code>
          </pre>
          <p className="prose">In Windows PowerShell:</p>
          <pre>
            <code>
              [Convert]::ToBase64String([Security.Cryptography.SHA512]::Create().ComputeHash([IO.File]::ReadAllBytes(&quot;Total-Setup.exe&quot;)))
            </code>
          </pre>
          <p className="prose">
            The output should match the row above character for character. If it does not, delete the file and
            download it again rather than opening it.
          </p>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">A reminder before day thirty</h2>
          <p className="sub">
            Only if you ask for it here. Total makes no network call, so it cannot tell us you installed it and
            it will never ask you for an address.
          </p>
          <ReminderForm />
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
