import SiteFooter from '@/components/SiteFooter'
import SiteNav from '@/components/SiteNav'
import Sidebar from './Sidebar'

export default function DocsLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <SiteNav />
      <div className="wrap docs-grid">
        <Sidebar />
        <div className="docs-content">{children}</div>
      </div>
      <SiteFooter />
    </>
  )
}
