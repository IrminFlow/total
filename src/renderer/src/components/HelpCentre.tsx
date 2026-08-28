import { useMemo, useState } from "react";
import {
  BookOpenText,
  CheckCircle,
  MagnifyingGlass,
  Sparkle,
  WarningCircle,
  Wrench,
} from "@phosphor-icons/react";
import { localeGuidance } from "@shared/localeHelp";
import { Button, Modal } from "./ui";
import { api } from "../lib/client";
import { contextualHelp, HELP_ARTICLES, searchHelp, type HelpArticle } from "../lib/helpContent";
import { RELEASE_NOTES } from "../lib/productEducation";
import { SCREENS, screenDef } from "../lib/screens";
import { useFeatures } from "../lib/useFeatures";
import { useNav, useScreen, useSession } from "../state/stores";

type HelpTab = "context" | "search" | "troubleshoot" | "release";
type CheckStatus = "ready" | "attention" | "optional";
interface GuidedCheck {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  action?: "backups" | "ai" | "company" | "updates";
}

export function HelpCentre({
  onClose,
  initialTab = "context",
}: {
  onClose: () => void;
  initialTab?: HelpTab;
}): React.JSX.Element {
  const [tab, setTab] = useState<HelpTab>(initialTab);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<HelpArticle | null>(null);
  const [checks, setChecks] = useState<GuidedCheck[] | null>(null);
  const [checking, setChecking] = useState(false);
  const screen = useScreen();
  const nav = useNav();
  const { info } = useSession();
  const features = useFeatures();
  const contextArticles = contextualHelp(screen.name, features);
  const results = useMemo(() => searchHelp(query), [query]);
  const article = selected ?? results[0] ?? null;
  const guidance = info ? localeGuidance(info) : null;
  const enabledFeatures = Object.entries(features)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name.replace(/([A-Z])/g, " $1").toLowerCase());

  const goTo = (name: string): void => {
    const target = SCREENS.find((definition) => definition.name === name)?.screen;
    if (target) {
      nav.go(target);
      onClose();
    }
  };

  const runChecks = async (): Promise<void> => {
    setChecking(true);
    const next: GuidedCheck[] = [];
    const current = await api.company.current().catch(() => null);
    next.push({
      id: "database",
      title: "Database and native module",
      status: current ? "ready" : "attention",
      detail: current
        ? "The open company answered through the native SQLite service. The Electron / better-sqlite3 ABI path is working."
        : "The current company could not be read. Reopen it; if this follows an app rebuild, rebuild better-sqlite3 for Electron.",
      action: "company",
    });

    try {
      const backups = await api.backups.list();
      if (backups[0]) {
        const preview = await api.backups.preview(backups[0].file);
        next.push({
          id: "backup",
          title: "Latest backup",
          status: preview.valid && preview.integrity === "ok" ? "ready" : "attention",
          detail: preview.valid && preview.integrity === "ok"
            ? `Latest snapshot ${backups[0].file} opens cleanly and passed integrity preview.`
            : `Latest snapshot needs attention: ${preview.detail}.`,
          action: "backups",
        });
      } else
        next.push({ id: "backup", title: "Latest backup", status: "attention", detail: "No backup is available for this company yet.", action: "backups" });
    } catch (error) {
      next.push({ id: "backup", title: "Latest backup", status: "attention", detail: (error as Error).message, action: "backups" });
    }

    const aiConfig = await api.ai.getConfig().catch(() => null);
    next.push({
      id: "provider",
      title: "AI provider",
      status: !aiConfig?.enabled ? "optional" : aiConfig.hasApiKey || aiConfig.baseUrl?.includes("localhost") ? "ready" : "attention",
      detail: !aiConfig?.enabled
        ? "Assist is off; core accounting remains fully available offline."
        : aiConfig.hasApiKey || aiConfig.baseUrl?.includes("localhost")
          ? `${aiConfig.provider === "openai" ? "OpenAI" : "Compatible provider"} is configured for ${aiConfig.model}. Run its explicit connection test in Settings if requests fail.`
          : "The provider is enabled but has no stored key. Add a key or use a compatible localhost endpoint.",
      action: "ai",
    });

    const nic = await api.nic.status().catch(() => null);
    const filingRelevant = info?.gstRegistrationType === "regular";
    next.push({
      id: "filing",
      title: "GST filing configuration",
      status: !filingRelevant ? "optional" : nic?.configured ? "ready" : "attention",
      detail: !filingRelevant
        ? `${guidance?.registrationLabel ?? "This company"} does not require regular-scheme NIC credentials.`
        : nic?.configured
          ? "NIC credentials are configured. Return exports still require review before portal submission."
          : "This is a Regular GST company, but e-Invoice / e-Way credentials are not configured.",
      action: "company",
    });

    try {
      const update = await api.app.checkUpdates();
      next.push({
        id: "updates",
        title: "Update channel",
        status: update.status === "error" ? "attention" : "ready",
        detail:
          update.status === "available"
            ? `Version ${(update.latest ?? "").replace(/^v/, "")} is available; current is ${update.current}.`
            : update.status === "up-to-date"
              ? `Version ${update.current} is current and the update feed responded.`
              : update.status === "disabled"
                ? "Update checks are disabled for this isolated test build."
              : update.status === "dev"
                ? "This is a source build; packaged update checks are intentionally inactive."
                : "The update feed could not be reached. Accounting work is unaffected.",
        action: "updates",
      });
    } catch (error) {
      next.push({ id: "updates", title: "Update channel", status: "attention", detail: (error as Error).message, action: "updates" });
    }
    setChecks(next);
    setChecking(false);
  };

  return (
    <Modal title="Help centre" onClose={onClose} wide>
      <div data-testid="help-centre" className="min-h-[520px]">
        <div className="grid grid-cols-4 gap-1 rounded-md border border-line bg-panel2 p-1">
          {([
            ["context", "This screen"],
            ["search", "Search help"],
            ["troubleshoot", "Fix a problem"],
            ["release", "What's new"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              data-testid={`help-tab-${id}`}
              onClick={() => setTab(id)}
              className={`rounded px-2 py-2 text-[11.5px] font-medium ${tab === id ? "bg-panel text-ink panel-shadow" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "context" && (
          <div className="mt-4">
            <div className="rounded-lg border border-line bg-panel2 p-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-deep">Now · {screenDef(screen.name)?.title ?? screen.name}</p>
              <h2 className="mt-1 font-serif text-[20px] font-semibold text-ink">Help that matches the work in front of you</h2>
              <p className="mt-1 max-w-2xl text-[11.5px] leading-5 text-muted">
                {guidance ? `${guidance.registrationLabel} in ${guidance.stateName}. ` : ""}
                Enabled terminology: {enabledFeatures.slice(0, 6).join(", ")}.
              </p>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              {(contextArticles.length ? contextArticles : HELP_ARTICLES.slice(0, 4)).map((item) => (
                <ArticleCard key={item.id} article={item} />
              ))}
            </div>
            {guidance && ["gstr1", "gstr3b", "gstr2b", "payroll", "company-info", "settings"].includes(screen.name) && (
              <div className="mt-3 rounded-md border border-amber/25 bg-amber/5 px-3 py-2.5 text-[11px] leading-5 text-muted">
                {screen.name === "payroll" ? guidance.payroll : screen.name === "company-info" || screen.name === "settings" ? guidance.invoice : guidance.gst}
              </div>
            )}
          </div>
        )}

        {tab === "search" && (
          <div className="mt-4">
            <label className="relative block">
              <MagnifyingGlass size={16} className="absolute left-3 top-2.5 text-muted" />
              <input autoFocus value={query} onChange={(event) => { setQuery(event.target.value); setSelected(null); }} placeholder="Try ‘quarterly register’, ‘restore’ or ‘GSTR-2B’" className="w-full rounded-md border border-line bg-panel py-2 pl-9 pr-3 text-[13px] text-ink" />
            </label>
            <p className="mt-1.5 text-[10px] text-muted">Indexed inside Total. Search terms and help reading never leave this device.</p>
            <div className="mt-3 grid grid-cols-[230px_1fr] overflow-hidden rounded-lg border border-line">
              <div className="max-h-[385px] overflow-y-auto border-r border-line bg-panel2 p-1.5">
                {results.map((item) => (
                  <button key={item.id} onClick={() => setSelected(item)} className={`block w-full rounded px-2.5 py-2 text-left text-[11.5px] ${article?.id === item.id ? "bg-panel font-medium text-ink panel-shadow" : "text-muted hover:text-ink"}`}>{item.title}</button>
                ))}
                {results.length === 0 && <p className="px-3 py-5 text-[11px] text-muted">No offline article matches. Try a task name or contact support.</p>}
              </div>
              <div className="min-h-[385px] bg-panel p-5">{article ? <ArticleDetail article={article} /> : null}</div>
            </div>
          </div>
        )}

        {tab === "troubleshoot" && (
          <div className="mt-4">
            <div className="flex items-start justify-between gap-4 rounded-lg border border-line bg-panel2 p-4">
              <div><p className="flex items-center gap-2 text-[13px] font-semibold text-ink"><Wrench size={17} /> Guided system check</p><p className="mt-1 max-w-xl text-[11px] leading-5 text-muted">Checks the update path, native database response, latest backup, AI provider state and GST filing configuration. It sends no diagnostics to support.</p></div>
              <Button variant="primary" disabled={checking} onClick={() => void runChecks()}>{checking ? "Checking…" : checks ? "Run again" : "Run five checks"}</Button>
            </div>
            <div className="mt-3 space-y-2">
              {checks?.map((check) => (
                <div key={check.id} className="flex items-start gap-3 rounded-md border border-line bg-panel px-3 py-3">
                  {check.status === "attention" ? <WarningCircle size={18} className="mt-0.5 shrink-0 text-cr" weight="fill" /> : <CheckCircle size={18} className={`mt-0.5 shrink-0 ${check.status === "ready" ? "text-dr" : "text-muted"}`} weight="fill" />}
                  <div className="min-w-0 flex-1"><p className="text-[12px] font-medium text-ink">{check.title} · {check.status === "ready" ? "Ready" : check.status === "attention" ? "Needs attention" : "Optional"}</p><p className="mt-0.5 text-[10.5px] leading-4 text-muted">{check.detail}</p></div>
                  {check.action && check.action !== "updates" && <Button onClick={() => check.action === "backups" ? (nav.go({ name: "settings", tab: "backups" }), onClose()) : check.action === "ai" ? (nav.go({ name: "settings", tab: "ai" }), onClose()) : goTo("company-info")}>Open</Button>}
                </div>
              ))}
              {!checks && <div className="rounded-md border border-dashed border-line px-4 py-10 text-center text-[11.5px] text-muted">Run the checks to get specific next steps. No accounting data is changed.</div>}
            </div>
          </div>
        )}

        {tab === "release" && (
          <div className="mt-4">
            {RELEASE_NOTES.map((release) => (
              <div key={release.version}>
                <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-deep"><Sparkle size={15} weight="fill" /> Version {release.version} · {release.released}</p>
                <h2 className="mt-2 font-serif text-[23px] font-semibold text-ink">{release.title}</h2>
                <div className="mt-4 divide-y divide-line rounded-lg border border-line bg-panel">
                  {release.changes.map((change) => (
                    <div key={change.title} className="flex items-center gap-4 px-4 py-3.5"><div className="min-w-0 flex-1"><p className="text-[12px] font-medium text-ink">{change.title}</p><p className="mt-0.5 text-[10.5px] leading-4 text-muted">{change.detail}</p></div>{change.screen && <Button onClick={() => goTo(change.screen!)}>Show me</Button>}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

function ArticleCard({ article }: { article: HelpArticle }): React.JSX.Element {
  return <div className="rounded-md border border-line bg-panel p-3.5"><p className="flex items-center gap-2 text-[12px] font-medium text-ink"><BookOpenText size={16} /> {article.title}</p><p className="mt-1.5 text-[10.5px] leading-4 text-muted">{article.summary}</p><ol className="mt-2 list-decimal space-y-1 pl-4 text-[10.5px] leading-4 text-muted">{article.steps.map((step) => <li key={step}>{step}</li>)}</ol></div>;
}

function ArticleDetail({ article }: { article: HelpArticle }): React.JSX.Element {
  return <><p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-amber-deep">Offline guide</p><h2 className="mt-1 font-serif text-[21px] font-semibold text-ink">{article.title}</h2><p className="mt-2 text-[12px] leading-5 text-muted">{article.summary}</p><ol className="mt-4 space-y-3">{article.steps.map((step, index) => <li key={step} className="flex gap-3 text-[11.5px] leading-5 text-ink"><span className="num flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-amber/40 bg-amber/8 text-[9px] font-semibold">{index + 1}</span><span>{step}</span></li>)}</ol></>;
}
