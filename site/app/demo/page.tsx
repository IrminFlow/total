import type { Metadata } from 'next'
import Image from 'next/image'
import Link from 'next/link'
import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import gstr1Light from '@/public/gstr1-light.jpg'

export const metadata: Metadata = {
  title: 'Watch a GSTR-1 export — Total',
  description: 'Ninety seconds: one sales invoice entered by keyboard, and the GSTR-1 JSON that comes out of it.'
}

/**
 * The recording slot.
 *
 * OPERATOR: set NEXT_PUBLIC_DEMO_VIDEO_URL and this page becomes the video. Until then it shows
 * a still and says plainly that the recording does not exist, because a play button over a
 * poster that does nothing is a worse first impression than an empty shelf. The script for the
 * recording is in content/screencast-shot-list.md.
 */
const VIDEO = process.env.NEXT_PUBLIC_DEMO_VIDEO_URL ?? ''
const POSTER = process.env.NEXT_PUBLIC_DEMO_VIDEO_POSTER ?? ''

export default function DemoPage(): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap">
        <section className="folio">
          <h1 className="serif">One invoice in, one GSTR-1 out</h1>
          <p className="sub">
            Ninety seconds of the real app on real books. A sales invoice entered without touching the mouse,
            then the return it produces and the JSON file the portal takes.
          </p>

          {VIDEO ? (
            <div className="video">
              <video controls preload="metadata" poster={POSTER || undefined} playsInline>
                <source src={VIDEO} type="video/mp4" />
                Your browser will not play this file. Download it instead: <a href={VIDEO}>the recording</a>.
              </video>
            </div>
          ) : (
            <div className="video-pending">
              <Image
                src={gstr1Light}
                alt="The GSTR-1 screen in Total, showing the B2B, B2C and total sections computed from voucher entries"
                sizes="(max-width: 1020px) 100vw, 972px"
                priority
              />
              <div className="callout">
                <p>
                  <b>The recording has not been made yet.</b>
                </p>
                <p>
                  Rather than a play button over a still that does nothing, here is the still: the GSTR-1
                  screen on the demo books, which is shot five of nine in the script. Everything on this page
                  describes what the recording will show, and the screenshots are from the same app on the same
                  data.
                </p>
              </div>
            </div>
          )}
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">What happens in it</h2>
          <ol className="steps">
            <li>
              <b>Gateway, then V.</b> One letter of every menu item is red. Pressing it goes there, from
              anywhere.
            </li>
            <li>
              <b>F8, then the invoice.</b> Date shorthand, three letters of the party name, item, quantity,
              rate. The CGST and SGST lines compute themselves and are never typed.
            </li>
            <li>
              <b>Enter accepts.</b> The voucher is posted. There is no separate save.
            </li>
            <li>
              <b>Press 1.</b> GSTR-1 opens, computed from the vouchers, including the one entered forty seconds
              earlier.
            </li>
            <li>
              <b>Change the period to the quarter.</b> The figures repopulate in place, because nothing was
              stored to go stale.
            </li>
            <li>
              <b>Export portal JSON.</b> The file the government offline tool accepts, with a CSV summary
              beside it, in a folder on your own disk.
            </li>
          </ol>
          <div className="folio-close" aria-hidden="true" />
        </section>

        <section className="folio">
          <h2 className="serif">In the meantime</h2>
          <p className="prose">
            The thirty-day trial has no account, no card and no email address, so watching a recording is
            slower than trying it. Import a Tally export, run last quarter, and compare the figures with what
            you filed.
          </p>
          <div className="hero-ctas">
            <Link className="btn" href="/download">
              Download Total
            </Link>
            <Link className="btn ghost" href="/docs/gst-returns">
              Read how returns work
            </Link>
          </div>
          <div className="folio-close" aria-hidden="true" />
        </section>
      </div>
      <SiteFooter />
    </>
  )
}
