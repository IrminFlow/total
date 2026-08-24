import type { Screen } from "../state/stores";
import { useNav } from "../state/stores";
import { TabBar } from "../components/TabBar";
import { BackupsSection } from "./settings/BackupsSection";
import { BinSection } from "./settings/BinSection";
import { UsersSection } from "./settings/UsersSection";
import { AuditSection } from "./settings/AuditSection";
import { NicSection } from "./settings/NicSection";
import { FeaturesSection } from "./settings/FeaturesSection";
import { InvoiceConfigSection } from "./settings/InvoiceConfigSection";
import { AgentBridgeSection } from "./settings/AgentBridgeSection";
import { AiSection } from "./settings/AiSection";
import { AboutSection } from "./settings/AboutSection";
import { ControlsSection } from "./settings/ControlsSection";
import { IntegrationsSection } from "./settings/IntegrationsSection";
import { PrivacySection } from "./settings/PrivacySection";
import { DataHealthSection } from "./settings/DataHealthSection";
import { AccessibilitySection } from "./settings/AccessibilitySection";
import { CommunitySection } from "./settings/CommunitySection";
import { useAccessibilityPreferences } from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";

export type SettingsTab = NonNullable<
  Extract<Screen, { name: "settings" }>["tab"]
>;

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "backups", label: "Backups" },
  { id: "bin", label: "Bin" },
  { id: "users", label: "Users" },
  { id: "controls", label: "Controls" },
  { id: "audit", label: "Audit trail" },
  { id: "nic", label: "NIC live filing" },
  { id: "features", label: "Features" },
  { id: "invoice", label: "Invoice print" },
  { id: "ai", label: "AI copilot" },
  { id: "agents", label: "Agent access" },
  { id: "integrations", label: "Integrations" },
  { id: "privacy", label: "Privacy centre" },
  { id: "health", label: "Data health" },
  { id: "accessibility", label: "Accessibility" },
  { id: "community", label: "Community & learning" },
  { id: "about", label: "About" },
];

export function Settings({ tab }: { tab?: SettingsTab }): React.JSX.Element {
  const nav = useNav();
  const language = useAccessibilityPreferences((state) => state.language);
  const active = tab ?? "backups";

  return (
    <div className="mx-auto flex max-w-5xl gap-6">
      <aside className="w-44 shrink-0">
        <h2 className="mb-3 text-[20px] font-semibold tracking-[-0.015em]">
          {localizedLabel("Settings", language)}
        </h2>
        {/* The active tab lives in the nav stack (not local state) so Esc/back retraces tabs
            and other screens can deep-link straight to a tab. */}
        <TabBar
          screen="settings"
          vertical
          tabs={TABS.map((item) => ({
            ...item,
            label: localizedLabel(item.label, language),
          }))}
          active={active}
          onSelect={(t) => {
            if (t !== active) nav.go({ name: "settings", tab: t });
          }}
        />
      </aside>
      <div className="min-w-0 flex-1">
        {active === "backups" && <BackupsSection />}
        {active === "bin" && <BinSection />}
        {active === "users" && <UsersSection />}
        {active === "controls" && <ControlsSection />}
        {active === "audit" && <AuditSection />}
        {active === "nic" && <NicSection />}
        {active === "features" && <FeaturesSection />}
        {active === "invoice" && <InvoiceConfigSection />}
        {active === "ai" && <AiSection />}
        {active === "agents" && <AgentBridgeSection />}
        {active === "integrations" && <IntegrationsSection />}
        {active === "privacy" && <PrivacySection />}
        {active === "health" && <DataHealthSection />}
        {active === "accessibility" && <AccessibilitySection />}
        {active === "community" && <CommunitySection />}
        {active === "about" && <AboutSection />}
      </div>
    </div>
  );
}
