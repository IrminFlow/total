import type { Metadata } from 'next'
import SiteNav from '@/components/SiteNav'
import CaptureClient from './CaptureClient'

export const metadata: Metadata = { title: 'Local receipt capture — Total', description: 'Capture receipts on your phone and share them to Total without uploading them to an accounting cloud.' }

export default function CapturePage(): React.JSX.Element {
  return <><SiteNav /><main className="wrap capture-page"><p className="eyebrow">Phone companion · local only</p><h1 className="serif">Capture here. Review in Total.</h1><p className="lede">Photograph receipts and supplier invoices on your phone, then use the native share sheet or AirDrop to move them to the desktop Assist inbox. No account, sync service or website upload.</p><CaptureClient /></main></>
}
