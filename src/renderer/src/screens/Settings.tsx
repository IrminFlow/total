import type { Screen } from '../state/stores'
import { useNav } from '../state/stores'
import { TabBar } from '../components/TabBar'
import { SectionTitle } from '../components/ui'
import { AppearanceSection } from './settings/AppearanceSection'
import { BackupsSection } from './settings/BackupsSection'
import { BinSection } from './settings/BinSection'
import { UsersSection } from './settings/UsersSection'
import { AuditSection } from './settings/AuditSection'
import { ApprovalsSection } from './settings/ApprovalsSection'
import { AuditorSection } from './settings/AuditorSection'
import { NicSection } from './settings/NicSection'
import { FeaturesSection } from './settings/FeaturesSection'
import { InvoiceConfigSection } from './settings/InvoiceConfigSection'
import { CustomFieldsSection } from './settings/CustomFieldsSection'
import { AgentBridgeSection } from './settings/AgentBridgeSection'
import { CollectionsSection } from './settings/CollectionsSection'
import { SchedulesSection } from './settings/SchedulesSection'
import { AiSection } from './settings/AiSection'
import { LicenseSection } from './settings/LicenseSection'
import { AboutSection } from './settings/AboutSection'

export type SettingsTab = NonNullable<Extract<Screen, { name: 'settings' }>['tab']>

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'backups', label: 'Backups' },
  { id: 'bin', label: 'Bin' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'auditor', label: 'Auditor & digest' },
  { id: 'nic', label: 'NIC live filing' },
  { id: 'features', label: 'Features' },
  { id: 'invoice', label: 'Invoice print' },
  { id: 'customFields', label: 'Custom fields' },
  { id: 'collections', label: 'Collections' },
  { id: 'schedules', label: 'Scheduled reports' },
  { id: 'agents', label: 'Agent access' },
  { id: 'ai', label: 'AI assistant' },
  { id: 'license', label: 'Licence' },
  { id: 'about', label: 'About' }
]

export function Settings({ tab }: { tab?: SettingsTab }): React.JSX.Element {
  const nav = useNav()
  const active = tab ?? 'backups'

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <aside className="w-44 shrink-0">
        <SectionTitle>Settings</SectionTitle>
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
        {active === 'appearance' && <AppearanceSection />}
        {active === 'backups' && <BackupsSection />}
        {active === 'bin' && <BinSection />}
        {active === 'users' && <UsersSection />}
        {active === 'audit' && <AuditSection />}
        {active === 'approvals' && <ApprovalsSection />}
        {active === 'auditor' && <AuditorSection />}
        {active === 'nic' && <NicSection />}
        {active === 'features' && <FeaturesSection />}
        {active === 'invoice' && <InvoiceConfigSection />}
        {active === 'customFields' && <CustomFieldsSection />}
        {active === 'collections' && <CollectionsSection />}
        {active === 'schedules' && <SchedulesSection />}
        {active === 'agents' && <AgentBridgeSection />}
        {active === 'ai' && <AiSection />}
        {active === 'license' && <LicenseSection />}
        {active === 'about' && <AboutSection />}
      </div>
    </div>
  )
}
