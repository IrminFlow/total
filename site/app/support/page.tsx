import type { Metadata } from 'next'
import SiteNav from '@/components/SiteNav'
import SupportForm from './SupportForm'
import CaseTracker from './CaseTracker'

export const metadata: Metadata = { title: 'Support', description: 'Contact Total support or track an existing accounting software support case.', alternates: { canonical: '/support' } }

export default function Support(): React.JSX.Element {
  return <><SiteNav /><main className="wrap support-page"><p className="eyebrow">Product support</p><h1 className="serif">Tell us what happened.</h1><p className="lede">Ask a question, report a broken workflow or share an idea directly with the product team.</p><SupportForm /><CaseTracker /></main></>
}
