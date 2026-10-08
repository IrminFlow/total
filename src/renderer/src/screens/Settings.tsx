import type { Screen } from '../state/stores'
import { useNav } from '../state/stores'
import { TabBar } from '../components/TabBar'
import { Page, PageHeader } from '../components/ui'
import { BackupsSection } from './settings/BackupsSection'
import { BinSection } from './settings/BinSection'
import { UsersSection } from './settings/UsersSection'
import { AuditSection } from './settings/AuditSection'
import { NicSection } from './settings/NicSection'
import { FeaturesSection } from './settings/FeaturesSection'
import { InvoiceConfigSection } from './settings/InvoiceConfigSection'
import { ReceivablesSection } from './settings/ReceivablesSection'
import { AgentBridgeSection } from './settings/AgentBridgeSection'
import { AboutSection } from './settings/AboutSection'
import { AppearanceSection } from './settings/AppearanceSection'
import { PacksSection } from './settings/PacksSection'

export type SettingsTab = NonNullable<Extract<Screen, { name: 'settings' }>['tab']>

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'backups', label: 'Backups' },
  { id: 'bin', label: 'Bin' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'nic', label: 'NIC live filing' },
  { id: 'features', label: 'Features' },
  { id: 'invoice', label: 'Invoice templates' },
  { id: 'receivables', label: 'Receivables' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'agents', label: 'Agent access' },
  { id: 'packs', label: 'Scheduled packs' },
  { id: 'about', label: 'About' }
]

export function Settings({ tab }: { tab?: SettingsTab }): React.JSX.Element {
  const nav = useNav()
  const active = tab ?? 'backups'

  return (
    <Page>
      <div className="flex gap-6">
        <aside className="w-44 shrink-0">
          {/* The page title sits over the section list, level with each section's own heading. */}
          <PageHeader title="Settings" className="!mb-3" />

          {/* The active tab lives in the nav stack (not local state) so Esc/back retraces tabs
            and other screens can deep-link straight to a tab. */}
          <TabBar
            screen="settings"
            vertical
            label="Settings sections"
            tabs={TABS}
            active={active}
            onSelect={(t) => {
              if (t !== active) nav.go({ name: 'settings', tab: t })
            }}
          />
        </aside>
        <div className="min-w-0 flex-1">
          {active === 'backups' && <BackupsSection />}
          {active === 'bin' && <BinSection />}
          {active === 'users' && <UsersSection />}
          {active === 'audit' && <AuditSection />}
          {active === 'nic' && <NicSection />}
          {active === 'features' && <FeaturesSection />}
          {active === 'invoice' && <InvoiceConfigSection />}
          {active === 'receivables' && <ReceivablesSection />}
          {active === 'agents' && <AgentBridgeSection />}
          {active === 'packs' && <PacksSection />}
          {active === 'appearance' && <AppearanceSection />}
          {active === 'about' && <AboutSection />}
        </div>
      </div>
    </Page>
  )
}
