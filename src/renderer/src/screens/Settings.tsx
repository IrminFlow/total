import type { Screen } from '../state/stores'
import { useNav } from '../state/stores'
import { TabBar } from '../components/TabBar'
import { BackupsSection } from './settings/BackupsSection'
import { BinSection } from './settings/BinSection'
import { UsersSection } from './settings/UsersSection'
import { AuditSection } from './settings/AuditSection'
import { NicSection } from './settings/NicSection'
import { FeaturesSection } from './settings/FeaturesSection'
import { InvoiceConfigSection } from './settings/InvoiceConfigSection'
import { AgentBridgeSection } from './settings/AgentBridgeSection'
import { AiSection } from './settings/AiSection'
import { AboutSection } from './settings/AboutSection'

export type SettingsTab = NonNullable<Extract<Screen, { name: 'settings' }>['tab']>

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'backups', label: 'Backups' },
  { id: 'bin', label: 'Bin' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'nic', label: 'NIC live filing' },
  { id: 'features', label: 'Features' },
  { id: 'invoice', label: 'Invoice print' },
  { id: 'agents', label: 'Agent access' },
  { id: 'ai', label: 'AI assistant' },
  { id: 'about', label: 'About' }
]

export function Settings({ tab }: { tab?: SettingsTab }): React.JSX.Element {
  const nav = useNav()
  const active = tab ?? 'backups'

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <aside className="w-44 shrink-0">
        <h2 className="mb-3 font-serif text-[19px] font-semibold tracking-tight">Settings</h2>
        {/* The active tab lives in the nav stack (not local state) so Esc/back retraces tabs
            and other screens can deep-link straight to a tab. */}
        <TabBar
          screen="settings"
          vertical
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
        {active === 'agents' && <AgentBridgeSection />}
        {active === 'ai' && <AiSection />}
        {active === 'about' && <AboutSection />}
      </div>
    </div>
  )
}
