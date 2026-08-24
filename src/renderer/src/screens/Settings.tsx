import { lazy, Suspense } from "react";
import type { Screen } from "../state/stores";
import { useNav } from "../state/stores";
import { TabBar } from "../components/TabBar";
import { useAccessibilityPreferences } from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";

const BackupsSection = lazy(async () => ({ default: (await import("./settings/BackupsSection")).BackupsSection }));
const BinSection = lazy(async () => ({ default: (await import("./settings/BinSection")).BinSection }));
const UsersSection = lazy(async () => ({ default: (await import("./settings/UsersSection")).UsersSection }));
const AuditSection = lazy(async () => ({ default: (await import("./settings/AuditSection")).AuditSection }));
const NicSection = lazy(async () => ({ default: (await import("./settings/NicSection")).NicSection }));
const FeaturesSection = lazy(async () => ({ default: (await import("./settings/FeaturesSection")).FeaturesSection }));
const InvoiceConfigSection = lazy(async () => ({ default: (await import("./settings/InvoiceConfigSection")).InvoiceConfigSection }));
const AgentBridgeSection = lazy(async () => ({ default: (await import("./settings/AgentBridgeSection")).AgentBridgeSection }));
const AiSection = lazy(async () => ({ default: (await import("./settings/AiSection")).AiSection }));
const AboutSection = lazy(async () => ({ default: (await import("./settings/AboutSection")).AboutSection }));
const ControlsSection = lazy(async () => ({ default: (await import("./settings/ControlsSection")).ControlsSection }));
const IntegrationsSection = lazy(async () => ({ default: (await import("./settings/IntegrationsSection")).IntegrationsSection }));
const PrivacySection = lazy(async () => ({ default: (await import("./settings/PrivacySection")).PrivacySection }));
const DataHealthSection = lazy(async () => ({ default: (await import("./settings/DataHealthSection")).DataHealthSection }));
const AccessibilitySection = lazy(async () => ({ default: (await import("./settings/AccessibilitySection")).AccessibilitySection }));
const CommunitySection = lazy(async () => ({ default: (await import("./settings/CommunitySection")).CommunitySection }));

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
        <Suspense fallback={<div className="rounded-lg border border-line bg-panel p-5 text-[13px] text-muted" role="status">Loading settings…</div>}>
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
        </Suspense>
      </div>
    </div>
  );
}
