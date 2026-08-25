import { useEffect, useId, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNav, useSession, useToasts, type Screen } from "../state/stores";
import { api } from "../lib/client";
import { useKeyNav } from "./useKeyNav";
import { useFeatures } from "../lib/useFeatures";
import {
  NAVIGATION_COMMANDS,
  commandAvailable,
  effectiveBindings,
  formatShortcut,
  useShortcutOverrides,
} from "../lib/commands";
import type { CompanyFeatures } from "@shared/features";
import type { SearchHit } from "@shared/search";
import { readWorkspacePrefs } from "../lib/workspacePrefs";
import { financialQuarterOf, fyOf, todayISO } from "@shared/dates";
import { readRecentRecords, rememberRecentRecord } from "../lib/recentRecords";
import { useAccessibilityPreferences } from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";

interface Command {
  label: string;
  hint?: string;
  /** Extra search terms (from the screen registry). */
  keywords?: string[];
  /** Hidden (render-only) when this feature is off. */
  feature?: keyof CompanyFeatures;
  run: () => void | Promise<void>;
}

/** Flattened, keyboard-navigable row — either a static command or a books search hit. Dividers
 *  aren't part of this list (they're not navigable), just spliced in at render time. */
type NavItem =
  { type: "command"; cmd: Command } | { type: "hit"; hit: SearchHit };

const HIT_KIND_LABEL: Record<SearchHit["kind"], string> = {
  ledger: "Ledger",
  item: "Item",
  voucher: "Voucher",
};

export function CommandPalette({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const nav = useNav();
  const toast = useToasts();
  const { clearCompany, setPeriod, slug, user } = useSession();
  const features = useFeatures();
  const shortcutOverrides = useShortcutOverrides();
  const language = useAccessibilityPreferences((state) => state.language);
  const [query, setQuery] = useState("");
  const listboxId = useId();
  const [recentRecords, setRecentRecords] = useState(() =>
    readRecentRecords(slug),
  );
  useEffect(() => setRecentRecords(readRecentRecords(slug)), [slug]);

  const commands = useMemo<Command[]>(() => {
    const go = (screen: Screen) => () => nav.go(screen);
    // Every navigable screen comes from the single registry; action commands are appended below.
    const prefs = readWorkspacePrefs(slug);
    const defs = NAVIGATION_COMMANDS.filter(
      (command) =>
        command.navigationTarget &&
        commandAvailable(command, features, user?.role ?? "owner"),
    );
    const recentDefs = prefs.recent.flatMap((name) => {
      const found = defs.find((command) => command.navigationTarget?.name === name);
      return found ? [found] : [];
    });
    const orderedDefs = [
      ...recentDefs,
      ...defs.filter((command) => !prefs.recent.includes(command.navigationTarget!.name)),
    ];
    const screenCommands: Command[] = orderedDefs.map((command) => ({
      label: localizedLabel(command.label, language),
      hint: prefs.recent.includes(command.navigationTarget!.name)
        ? "Recent"
        : effectiveBindings(command, shortcutOverrides)
            .filter((binding) => binding.context === "global")
            .map(formatShortcut)[0],
      keywords: command.keywords,
      feature: command.feature,
      run:
        command.navigationTarget!.name === "gateway"
          ? () => nav.home()
          : go(command.navigationTarget!),
    }));
    const today = todayISO();
    const currentMonth = (() => {
      const prefix = today.slice(0, 7);
      const [year, month] = prefix.split("-").map(Number);
      const last = new Date(Date.UTC(year!, month!, 0)).getUTCDate();
      return {
        from: `${prefix}-01`,
        to: `${prefix}-${String(last).padStart(2, "0")}`,
      };
    })();
    const previousMonth = (() => {
      const date = new Date(`${currentMonth.from}T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() - 1);
      const prefix = date.toISOString().slice(0, 7);
      const last = new Date(
        Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
      ).getUTCDate();
      return {
        from: `${prefix}-01`,
        to: `${prefix}-${String(last).padStart(2, "0")}`,
      };
    })();
    const periodCommand = (
      label: string,
      period: { from: string; to: string },
      keywords: string[],
    ): Command => ({
      label,
      keywords,
      run: () => {
        setPeriod(period.from, period.to);
        toast.push("success", `${label.replace("Set period — ", "")} selected`);
      },
    });
    return [
      { label: "New voucher", hint: "V", run: go({ name: "voucher-entry" }) },
      { label: "New task", run: go({ name: "task-inbox", compose: true }) },
      {
        label: "New sales invoice",
        run: go({ name: "voucher-entry", kindHint: "sales" }),
      },
      {
        label: "New purchase",
        run: go({ name: "voucher-entry", kindHint: "purchase" }),
      },
      {
        label: "New payment",
        run: go({ name: "voucher-entry", kindHint: "payment" }),
      },
      {
        label: "New receipt",
        run: go({ name: "voucher-entry", kindHint: "receipt" }),
      },
      periodCommand("Set period — this month", currentMonth, [
        "date",
        "month",
        "change period",
      ]),
      periodCommand("Set period — previous month", previousMonth, [
        "date",
        "last month",
        "change period",
      ]),
      periodCommand("Set period — current quarter", financialQuarterOf(today), [
        "date",
        "quarter",
        "q1",
        "q2",
        "q3",
        "q4",
      ]),
      periodCommand("Set period — current financial year", fyOf(today), [
        "date",
        "fy",
        "financial year",
      ]),
      ...screenCommands,
      {
        label: "Stock items",
        feature: "inventory",
        run: go({ name: "masters", tab: "items" }),
      },
      { label: "Currencies", run: go({ name: "masters", tab: "currencies" }) },
      {
        label: "New manufacture (stock journal)",
        feature: "inventory",
        run: go({ name: "voucher-entry", kindHint: "stock_journal" }),
      },
      {
        label: "Export CA pack",
        run: async () => {
          try {
            const { from, to } = useSession.getState();
            const r = await api.exporter.caPack(from, to);
            toast.push("success", `Saved to ${r.path}`);
          } catch (err) {
            toast.push("error", (err as Error).message);
          }
        },
      },
      {
        label: "Export Tally XML",
        run: async () => {
          try {
            const { from, to } = useSession.getState();
            const r = await api.exporter.tallyXml(from, to);
            toast.push("success", `Saved to ${r.path}`);
          } catch (err) {
            toast.push("error", (err as Error).message);
          }
        },
      },
      { label: "Backups", run: go({ name: "settings", tab: "backups" }) },
      { label: "Bin", run: go({ name: "settings", tab: "bin" }) },
      { label: "Audit trail", run: go({ name: "settings", tab: "audit" }) },
      { label: "Users", run: go({ name: "settings", tab: "users" }) },
      { label: "Features", run: go({ name: "settings", tab: "features" }) },
      { label: "Invoice print", run: go({ name: "settings", tab: "invoice" }) },
      {
        label: "Back up company now",
        run: async () => {
          try {
            await api.company.backup();
            toast.push("success", "Backup saved");
          } catch (err) {
            toast.push("error", (err as Error).message);
          }
        },
      },
      {
        label: "Show exports in Finder",
        run: async () => {
          try {
            await api.company.revealExports();
          } catch (err) {
            toast.push("error", (err as Error).message);
          }
        },
      },
      {
        label: "Switch company",
        run: async () => {
          try {
            await api.company.close();
            clearCompany();
            nav.home();
          } catch (err) {
            toast.push("error", (err as Error).message);
          }
        },
      },
    ];
  }, [nav, toast, clearCompany, setPeriod, slug, language, features, user, shortcutOverrides]);

  const filtered = useMemo(() => {
    const visible = commands.filter((c) => !c.feature || features[c.feature]);
    const normalize = (value: string): string =>
      value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const q = normalize(query);
    if (!q) return visible;
    const tokens = q.split(/\s+/);
    return visible.filter((command) => {
      const haystack = normalize(
        [command.label, ...(command.keywords ?? [])].join(" "),
      );
      return tokens.every((token) => haystack.includes(token));
    });
  }, [commands, query, features]);

  // Books search: debounced 150ms, only fires once the query is meaningfully specific (2+ chars).
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(t);
  }, [query]);
  const searchEnabled = debounced.length >= 2;
  const { data: hits = [] } = useQuery({
    queryKey: ["search", debounced],
    queryFn: () => api.search.global(debounced),
    enabled: searchEnabled,
  });
  // Recent records are a zero-query affordance only. Hide them immediately on the first
  // keystroke (before the 150ms books-search debounce), otherwise Enter could execute a stale
  // recent row while the user is visibly filtering for a command.
  const visibleHits: SearchHit[] = query.trim() ? hits : recentRecords;

  const navItems = useMemo<NavItem[]>(
    () => [
      ...visibleHits.map((hit) => ({ type: "hit" as const, hit })),
      ...filtered.map((cmd) => ({ type: "command" as const, cmd })),
    ],
    [filtered, visibleHits],
  );

  const { active, setActive } = useKeyNav(navItems.length, () => {}, false);

  const runItem = (item: NavItem | undefined): void => {
    if (!item) return;
    onClose();
    if (item.type === "command") {
      void item.cmd.run();
      return;
    }
    const { hit } = item;
    setRecentRecords(rememberRecentRecord(slug, hit));
    if (hit.kind === "ledger")
      nav.go({ name: "ledger-statement", ledgerId: hit.id });
    else if (hit.kind === "item") nav.go({ name: "masters", tab: "items" });
    else nav.go({ name: "voucher-entry", voucherId: hit.id });
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-start justify-center bg-black/50 pt-[14vh]"
      onMouseDown={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search books and commands"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          role="combobox"
          aria-autocomplete="list"
          aria-expanded="true"
          aria-controls={listboxId}
          aria-activedescendant={
            navItems[active] ? `${listboxId}-option-${active}` : undefined
          }
          data-testid="input-palette"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive(Math.min(navItems.length - 1, active + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive(Math.max(0, active - 1));
            } else if (e.key === "Enter") runItem(navItems[active]);
          }}
          placeholder="Type a command — voucher, report, GST…"
          className="w-full border-b border-line bg-transparent px-5 py-3.5 text-[14px] outline-none placeholder:text-muted/60"
        />
        <div
          id={listboxId}
          role="listbox"
          className="max-h-80 overflow-auto py-1"
        >
          {visibleHits.length > 0 && (
            <p className="px-5 pb-1 pt-2 text-[10.5px] font-medium uppercase tracking-wide text-muted">
              {searchEnabled ? "In your books" : "Recent records"}
            </p>
          )}
          {visibleHits.map((hit, i) => (
            <div
              key={`${hit.kind}-${hit.id}`}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === active}
              data-active={i === active}
              className="kbar-row flex cursor-pointer items-center justify-between gap-3 px-5 py-2 text-[13.5px]"
              onMouseEnter={() => setActive(i)}
              onClick={() => runItem(navItems[i])}
            >
              <div className="flex min-w-0 flex-col">
                <span className="truncate">{hit.label}</span>
                <span className="truncate text-[11px] text-muted">
                  {hit.sub}
                </span>
              </div>
              <span className="shrink-0 text-[11px] text-muted">
                {HIT_KIND_LABEL[hit.kind]}
              </span>
            </div>
          ))}
          {visibleHits.length > 0 && filtered.length > 0 && (
            <p className="px-5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-wide text-muted">
              Commands
            </p>
          )}
          {filtered.map((cmd, i) => (
            <div
              key={cmd.label}
              id={`${listboxId}-option-${visibleHits.length + i}`}
              role="option"
              aria-selected={visibleHits.length + i === active}
              data-active={visibleHits.length + i === active}
              className="kbar-row flex cursor-pointer items-center justify-between px-5 py-2 text-[13.5px]"
              onMouseEnter={() => setActive(visibleHits.length + i)}
              onClick={() => runItem(navItems[visibleHits.length + i])}
            >
              <span>{cmd.label}</span>
              {cmd.hint && (
                <span className="text-[11px] text-muted">{cmd.hint}</span>
              )}
            </div>
          ))}
          {navItems.length === 0 && (
            <p className="px-5 py-6 text-center text-[13px] text-muted">
              No commands or matches
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
