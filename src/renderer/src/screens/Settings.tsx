import { useState } from 'react'
import type { Screen } from '../state/stores'
import { BackupsSection } from './settings/BackupsSection'
import { BinSection } from './settings/BinSection'
import { UsersSection } from './settings/UsersSection'
import { AuditSection } from './settings/AuditSection'
import { NicSection } from './settings/NicSection'
import { AboutSection } from './settings/AboutSection'

export type SettingsTab = NonNullable<Extract<Screen, { name: 'settings' }>['tab']>

const TABS: { id: SettingsTab; label: string }[] = [
  { id: 'backups', label: 'Backups' },
  { id: 'bin', label: 'Bin' },
  { id: 'users', label: 'Users' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'nic', label: 'NIC live filing' },
  { id: 'about', label: 'About' }
]

export function Settings({ tab: initialTab }: { tab?: SettingsTab }): React.JSX.Element {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? 'backups')

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <aside className="w-44 shrink-0">
        <h2 className="mb-3 font-serif text-[19px] font-semibold tracking-tight">Settings</h2>
        <nav className="flex flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                tab === t.id ? 'bg-amberbar/20 font-medium text-ink' : 'text-muted hover:bg-panel2 hover:text-ink'
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        {tab === 'backups' && <BackupsSection />}
        {tab === 'bin' && <BinSection />}
        {tab === 'users' && <UsersSection />}
        {tab === 'audit' && <AuditSection />}
        {tab === 'nic' && <NicSection />}
        {tab === 'about' && <AboutSection />}
      </div>
    </div>
  )
}
