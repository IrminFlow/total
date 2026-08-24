import type { Metadata } from 'next'
import SiteNav from '@/components/SiteNav'
import FeedbackBoard from './FeedbackBoard'

export const metadata: Metadata = { title: 'Customer ideas — Total' }

export default function FeedbackPage(): React.JSX.Element {
  return <><SiteNav /><main className="wrap feedback-page"><p className="eyebrow">Built in public</p><h1 className="serif">A roadmap customers can hold us to.</h1><p className="lede">Suggest an improvement, vote for work that matters, and see what moved from considering to released.</p><FeedbackBoard /></main></>
}
