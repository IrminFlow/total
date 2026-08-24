import SiteNav from '@/components/SiteNav'
import SupportForm from './SupportForm'

export default function Support(): React.JSX.Element {
  return <><SiteNav /><main className="wrap support-page"><p className="eyebrow">Real people, useful answers</p><h1 className="serif">Tell us where Total can be better.</h1><p className="lede">Questions, broken workflows, or an idea you wish accounting software understood—send it directly to the product team.</p><SupportForm /><p className="support-email">Prefer email? <a href="mailto:total@irminflow.com">total@irminflow.com</a></p></main></>
}
