import type { Metadata } from 'next'
import SiteNav from '@/components/SiteNav'
import FeedbackBoard from './FeedbackBoard'

export const metadata: Metadata = { title: 'Customer ideas | Total' }

export default function FeedbackPage(): React.JSX.Element {
  return <><SiteNav /><main className="wrap feedback-page"><p className="eyebrow">Customer ideas</p><h1 className="serif">Help decide what Total builds next.</h1><p className="lede">Suggest an improvement, vote for useful work and follow an idea from review to release.</p><FeedbackBoard /></main></>
}
