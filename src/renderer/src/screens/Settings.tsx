import { lazy, Suspense, useMemo, useState } from "react";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { useNav, useSession, type Screen } from "../state/stores";
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
const EmailDeliverySection = lazy(async () => ({ default: (await import("./settings/EmailDeliverySection")).EmailDeliverySection }));
const PrivacySection = lazy(async () => ({ default: (await import("./settings/PrivacySection")).PrivacySection }));
const DataHealthSection = lazy(async () => ({ default: (await import("./settings/DataHealthSection")).DataHealthSection }));
const AccessibilitySection = lazy(async () => ({ default: (await import("./settings/AccessibilitySection")).AccessibilitySection }));
const CommunitySection = lazy(async () => ({ default: (await import("./settings/CommunitySection")).CommunitySection }));

export type SettingsTab = NonNullable<
  Extract<Screen, { name: "settings" }>["tab"]
>;

interface SettingsDestination {
  id: SettingsTab;
  label: string;
  description: string;
  keywords?: string;
}

export interface SettingsGroup {
  id: string;
  label: string;
  items: readonly SettingsDestination[];
}

export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: "company-documents",
    label: "Company & documents",
    items: [
      { id: "invoice", label: "Invoice print", description: "Branding, layout and document numbering", keywords: "pdf template logo" },
      { id: "features", label: "Features", description: "Company modules and working preferences", keywords: "company options modules" },
    ],
  },
  {
    id: "data-recovery",
    label: "Data & recovery",
    items: [
      { id: "backups", label: "Backups", description: "Snapshots, complete backups and restore drills", keywords: "export restore recovery" },
      { id: "bin", label: "Bin", description: "Recover or permanently remove deleted vouchers", keywords: "trash deleted" },
      { id: "health", label: "Data health", description: "Integrity checks and company diagnostics", keywords: "repair database check" },
    ],
  },
  {
    id: "people-permissions",
    label: "People & permissions",
    items: [
      { id: "users", label: "Users", description: "Local accounts, roles and access windows", keywords: "owner accountant viewer pin" },
      { id: "controls", label: "Controls", description: "Approvals, locks and sensitive actions", keywords: "permissions policy security" },
      { id: "audit", label: "Audit trail", description: "Review changes and operator activity", keywords: "history events logs" },
    ],
  },
  {
    id: "automation-ai",
    label: "Automation & AI",
    items: [
      { id: "ai", label: "AI copilot", description: "Provider, model and optional AI access", keywords: "openai compatible key model" },
      { id: "agents", label: "Agent access", description: "Local MCP and agent permission controls", keywords: "mcp claude tools sdk" },
    ],
  },
  {
    id: "integrations-delivery",
    label: "Integrations & delivery",
    items: [
      { id: "integrations", label: "Integrations", description: "Connected services and local extensions", keywords: "connectors plugins" },
      { id: "email", label: "Email delivery", description: "Send invoices and reminders from your account", keywords: "smtp mail statements" },
      { id: "nic", label: "NIC live filing", description: "Optional e-Invoice and e-Way filing connection", keywords: "gst einvoice eway credentials" },
    ],
  },
  {
    id: "privacy-accessibility",
    label: "Privacy & accessibility",
    items: [
      { id: "privacy", label: "Privacy centre", description: "Data sharing, retention and local privacy choices", keywords: "consent telemetry delete" },
      { id: "accessibility", label: "Accessibility", description: "Language, motion, contrast and display preferences", keywords: "hindi reduced motion theme text" },
    ],
  },
  {
    id: "product-support",
    label: "Product & support",
    items: [
      { id: "community", label: "Community & learning", description: "Guides, feedback and ways to get help", keywords: "support docs feedback training" },
      { id: "about", label: "About", description: "Version, updates and product information", keywords: "release licence app" },
    ],
  },
];

export function filterSettingsGroups(
  groups: readonly SettingsGroup[],
  query: string,
): SettingsGroup[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return groups.map((group) => ({ ...group, items: [...group.items] }));

  return groups.flatMap((group) => {
    const groupMatches = group.label.toLocaleLowerCase().includes(normalized);
    const items = groupMatches
      ? [...group.items]
      : group.items.filter((item) =>
          `${item.label} ${item.description} ${item.keywords ?? ""}`
            .toLocaleLowerCase()
            .includes(normalized),
        );
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}

export function Settings({ tab }: { tab?: SettingsTab }): React.JSX.Element {
  const nav = useNav();
  const language = useAccessibilityPreferences((state) => state.language);
  const user = useSession((state) => state.user);
  const owner = !user || user.role === "owner";
  const active = tab ?? "backups";
  const [query, setQuery] = useState("");
  const visibleGroups = useMemo(
    () => SETTINGS_GROUPS.map((group) => ({
      ...group,
      items: group.items.filter((item) => owner || item.id !== "email"),
    })).filter((group) => group.items.length > 0),
    [owner],
  );
  const filteredGroups = useMemo(
    () => filterSettingsGroups(visibleGroups, query),
    [query, visibleGroups],
  );
  const activeGroup = visibleGroups.find((group) =>
    group.items.some((item) => item.id === active),
  );
  const activeItem = activeGroup?.items.find((item) => item.id === active);

  return (
    <div className="mx-auto grid max-w-6xl grid-cols-[minmax(13rem,15rem)_minmax(0,1fr)] gap-7">
      <aside className="min-w-0 border-r border-line pr-5">
        <h1 className="text-[22px] font-semibold tracking-[-0.025em]">
          {localizedLabel("Settings", language)}
        </h1>
        <p className="mt-1 text-[12.5px] leading-5 text-muted">
          Configure this company and the app on this device.
        </p>
        <div className="relative mt-4">
          <MagnifyingGlass
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted"
            size={15}
            weight="bold"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a setting"
            aria-label="Find a setting"
            className="w-full rounded-md border border-line bg-panel py-2 pl-8 pr-8 text-[12.5px] text-ink outline-none transition-colors placeholder:text-muted/70 focus:border-amber focus:ring-2 focus:ring-amber/15"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label="Clear settings search"
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:bg-panel2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              <X aria-hidden="true" size={14} weight="bold" />
            </button>
          )}
        </div>
        {/* The active tab lives in the nav stack (not local state) so Esc/back retraces tabs
            and other screens can deep-link straight to a tab. */}
        <nav aria-label="Settings sections" className="mt-5 space-y-5">
          {filteredGroups.map((group) => (
            <section key={group.id} aria-labelledby={`settings-group-${group.id}`}>
              <h2
                id={`settings-group-${group.id}`}
                className="mb-1.5 px-2 text-[10.5px] font-semibold uppercase tracking-[0.09em] text-muted"
              >
                {group.label}
              </h2>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const selected = item.id === active;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`tab-settings-${item.id}`}
                      aria-current={selected ? "page" : undefined}
                      onClick={() => {
                        if (!selected) nav.go({ name: "settings", tab: item.id });
                      }}
                      className={`group w-full rounded-md border-l-2 px-2.5 py-1.5 text-left text-[12.5px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40 ${
                        selected
                          ? "border-amber bg-amber/10 font-semibold text-ink"
                          : "border-transparent text-muted hover:bg-panel2 hover:text-ink"
                      }`}
                    >
                      {localizedLabel(item.label, language)}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
          {filteredGroups.length === 0 && (
            <div className="rounded-md border border-dashed border-line bg-panel2/45 px-3 py-4" role="status">
              <p className="text-[12.5px] font-medium text-ink">No settings found</p>
              <p className="mt-1 text-[11.5px] leading-4 text-muted">
                Try a feature name, task or service.
              </p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-2 text-[11.5px] font-semibold text-amber hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber/40"
              >
                Clear search
              </button>
            </div>
          )}
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="mb-5 border-b border-line pb-4">
          <p className="text-[11px] font-semibold uppercase tracking-[0.09em] text-amber">
            {localizedLabel("Settings", language)}
          </p>
          <h2 className="mt-1 font-serif text-[21px] font-semibold tracking-[-0.015em] text-ink">
            {activeGroup?.label ?? "Settings"}
          </h2>
          {activeItem && (
            <p className="mt-1 max-w-[65ch] text-[12.5px] leading-5 text-muted">
              {activeItem.description}
            </p>
          )}
        </header>
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
          {active === "email" && <EmailDeliverySection />}
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
