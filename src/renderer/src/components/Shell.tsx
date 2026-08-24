import { useEffect, useRef, useState, type ReactNode } from "react";
import { useIsFetching, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useNav,
  useScreen,
  useSession,
  useTheme,
  useToasts,
} from "../state/stores";
import { api } from "../lib/client";
import { Button, DateInput, Kbd, Modal } from "./ui";
import { isAnyModalOpen } from "./modalRegistry";
import { MnemonicText } from "./MnemonicText";
import { SupportLink } from "./SupportLink";
import {
  toDisplayDate,
  fyOf,
  fyFromStartYear,
  parsePeriodExpression,
  todayISO,
} from "@shared/dates";
import { useFeatures } from "../lib/useFeatures";
import {
  NAV_SECTIONS,
  SCREENS,
  SCREEN_SHORTCUTS,
  screenDef,
} from "../lib/screens";
import {
  readWorkspacePrefs,
  rememberWorkspaceScreen,
  saveWorkspaceProfile,
  screenInWorkspace,
  toggleWorkspaceFavorite,
  workspaceIdentity,
  WORKSPACE_PROFILES,
  type WorkspacePrefs,
  type WorkspaceProfile,
} from "../lib/workspacePrefs";
import {
  ArrowLeft,
  ArrowRight,
  ArrowsLeftRight,
  CaretDown,
  ClockCounterClockwise,
  CornersIn,
  CornersOut,
  LockKey,
  MagnifyingGlass,
  Moon,
  PushPin,
  PushPinSlash,
  Question,
  Sparkle,
  Sun,
} from "@phosphor-icons/react";
import {
  continuationRouteKey,
  readContinuation,
  rememberContinuation,
} from "../lib/continuation";
import { navigationLabel } from "../lib/navigationLabels";
import { useAccessibilityPreferences } from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";
import { FeatureDiscovery } from "./FeatureDiscovery";
import { recordCohortEvent } from "../lib/commercialOps";

/** Sidebar derived from the single screen registry (lib/screens.ts). */
const NAV = NAV_SECTIONS.map((section) => ({
  ...section,
  items: SCREENS.filter(
    (s) => s.navSection === section.id && s.screen != null,
  ).map((s) => ({
    label: s.navLabel ?? s.title,
    screen: s.screen!,
    feature: s.feature,
  })),
}));

const FOCUS_SCREENS = new Set([
  "voucher-entry",
  "banking",
  "gstr1",
  "gstr3b",
  "gstr2b",
  "edocs",
  "month-close",
]);

const SCROLL_INTENT_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  " ",
]);

export function Shell({
  children,
  onOpenPalette,
  onOpenCopilot,
  onOpenHelp,
}: {
  children: ReactNode;
  onOpenPalette: () => void;
  onOpenCopilot: () => void;
  onOpenHelp: () => void;
}): React.JSX.Element {
  const {
    info,
    from,
    to,
    clearCompany,
    user,
    setUser,
    setLocked,
    slug,
    setCompany,
    setPeriod,
    setIntegrityWarning,
  } = useSession();
  const screen = useScreen();
  const nav = useNav();
  const toast = useToasts();
  const queryClient = useQueryClient();
  const { theme, toggle } = useTheme();
  const language = useAccessibilityPreferences((state) => state.language);
  const identity = workspaceIdentity(user);
  const [periodOpen, setPeriodOpen] = useState(false);
  const [companySwitcherOpen, setCompanySwitcherOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(),
  );
  const [workspace, setWorkspace] = useState<WorkspacePrefs>(() =>
    readWorkspacePrefs(slug, identity),
  );
  const mainRef = useRef<HTMLElement>(null);
  const restoreKey = `${slug}:${continuationRouteKey(screen)}`;
  const scrollRestoreRef = useRef({
    key: "",
    slug: "",
    screenName: "",
    target: 0,
    complete: true,
  });
  if (scrollRestoreRef.current.key !== restoreKey) {
    const hadRoute = scrollRestoreRef.current.key !== "";
    const sameScreenRouteChange =
      hadRoute &&
      scrollRestoreRef.current.slug === (slug ?? "") &&
      scrollRestoreRef.current.screenName === screen.name;
    const target =
      slug && screen.name !== "voucher-entry" && !sameScreenRouteChange
        ? (readContinuation(slug)?.scrollByScreen[screen.name] ?? 0)
        : 0;
    scrollRestoreRef.current = {
      key: restoreKey,
      slug: slug ?? "",
      screenName: screen.name,
      target,
      // A route transition with no saved position still needs one explicit scrollTo(0),
      // because React reuses the same scrolling element across screens and tabs.
      complete: !slug || screen.name === "voucher-entry" || (!hadRoute && target <= 0),
    };
  }
  const fetching = useIsFetching();
  const features = useFeatures();
  const visibleNav = NAV.filter((s) => !s.feature || features[s.feature])
    .map((s) => ({
      ...s,
      items: s.items.filter(
        (i) =>
          (!i.feature || features[i.feature]) &&
          screenInWorkspace(workspace.profile, i.screen.name),
      ),
    }))
    .filter((section) => section.items.length > 0);
  const pinned = workspace.favorites.flatMap((name) => {
    const def = screenDef(name);
    return def?.screen && (!def.feature || features[def.feature]) ? [def] : [];
  });
  const currentTitle = localizedLabel(
    screenDef(screen.name)?.title ?? "Total",
    language,
  );
  const canFocus = FOCUS_SCREENS.has(screen.name);
  const focusActive = focusMode && canFocus;

  useEffect(() => {
    const activeSection = visibleNav.find((section) =>
      section.items.some((item) => item.screen.name === screen.name),
    );
    if (!activeSection?.title) return;
    setExpandedSections((current) => {
      if (current.has(activeSection.id)) return current;
      return new Set([...current, activeSection.id]);
    });
  }, [screen.name, visibleNav]);

  useEffect(() => {
    setWorkspace(rememberWorkspaceScreen(slug, screen.name, identity));
    if (screen.name === "registers")
      recordCohortEvent(localStorage, "first_register_opened");
  }, [slug, screen.name, identity]);

  useEffect(() => {
    if (!slug || screen.name === "voucher-entry") return;
    const canonical = screenDef(screen.name)?.screen;
    if (!canonical) return;
    rememberContinuation(slug, { screen: canonical, from, to });
  }, [slug, screen.name, from, to]);

  useEffect(() => {
    if (!slug || screen.name === "voucher-entry") return;
    const restoration = scrollRestoreRef.current;
    if (restoration.key !== restoreKey || restoration.complete) return;
    const scrollTop = restoration.target;
    let frame = 0;
    let attempts = 0;
    const restore = (): void => {
      const main = mainRef.current;
      if (!main) return;
      main.scrollTo({ top: scrollTop });
      // Dashboard rows arrive asynchronously. Keep the saved reading position until the
      // scroller is tall enough instead of letting the browser clamp the one-shot restore to 0.
      if (Math.abs(main.scrollTop - scrollTop) <= 1) {
        restoration.complete = true;
        return;
      }
      // Stay pending after this bounded burst. A later query-layout transition can retry,
      // while direct user input below always cancels restoration immediately.
      if (attempts >= 120) return;
      attempts += 1;
      frame = requestAnimationFrame(restore);
    };
    frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [slug, screen.name, restoreKey, fetching]);

  useEffect(() => {
    if (!canFocus) setFocusMode(false);
  }, [canFocus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (isAnyModalOpen()) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.matches('input, select, textarea, [contenteditable="true"]') ||
          target.closest('[contenteditable="true"]'))
      )
        return;
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        e.key.toLowerCase() === "f" &&
        canFocus
      ) {
        e.preventDefault();
        setFocusMode((value) => !value);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "[") {
        e.preventDefault();
        nav.back();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "]") {
        e.preventDefault();
        nav.forward();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === ",") {
        e.preventDefault();
        nav.go({ name: "settings" });
        return;
      }
      if (!e.altKey || e.metaKey || e.ctrlKey) return;
      const key = e.key.toLowerCase();
      const item = visibleNav
        .flatMap((section) => section.items)
        .find((candidate) => {
          const shortcut = SCREEN_SHORTCUTS[candidate.screen.name];
          return shortcut?.key === key && !!shortcut.shift === e.shiftKey;
        });
      if (item) {
        e.preventDefault();
        nav.go(item.screen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, visibleNav, canFocus]);

  return (
    <div
      className="flex h-full flex-col"
      onKeyDownCapture={(event) => {
        if (
          !event.altKey &&
          !event.ctrlKey &&
          !event.metaKey &&
          SCROLL_INTENT_KEYS.has(event.key) &&
          scrollRestoreRef.current.key === restoreKey
        ) {
          scrollRestoreRef.current.complete = true;
        }
      }}
    >
      <header
        className={`drag-region flex h-12 shrink-0 items-center gap-3 border-b border-line bg-panel pr-4 panel-shadow ${
          window.total.platform === "darwin" ? "pl-24" : "pl-4"
        }`}
      >
        <span className="font-serif text-[15px] font-semibold tracking-tight">
          Total
        </span>
        <span className="h-4 w-px bg-line" aria-hidden="true" />
        <div className="no-drag flex items-center gap-0.5">
          <button
            data-testid="btn-history-back"
            aria-label="Go back"
            title="Back (Command+[)"
            disabled={nav.stack.length <= 1}
            onClick={nav.back}
            className="rounded p-1 text-muted hover:bg-panel2 hover:text-ink disabled:opacity-30"
          >
            <ArrowLeft size={15} />
          </button>
          <button
            data-testid="btn-history-forward"
            aria-label="Go forward"
            title="Forward (Command+])"
            disabled={nav.future.length === 0}
            onClick={nav.forward}
            className="rounded p-1 text-muted hover:bg-panel2 hover:text-ink disabled:opacity-30"
          >
            <ArrowRight size={15} />
          </button>
          <button
            data-testid="btn-history-timeline"
            aria-label="Open navigation history"
            title="Navigation history"
            onClick={() => setHistoryOpen(true)}
            className="rounded p-1 text-muted hover:bg-panel2 hover:text-ink"
          >
            <ClockCounterClockwise size={15} />
          </button>
        </div>
        <span className="text-[13px] font-medium text-ink">{currentTitle}</span>
        {focusActive && (
          <span className="rounded border border-amber/35 bg-amber/10 px-2 py-0.5 text-[10.5px] font-medium text-ink">
            Focus mode
          </span>
        )}
        {slug &&
          screenDef(screen.name)?.screen &&
          screen.name !== "gateway" && (
            <button
              data-testid="btn-pin-screen"
              className="no-drag rounded px-1.5 py-1 text-[10.5px] text-muted hover:bg-panel2 hover:text-ink"
              title={
                workspace.favorites.includes(screen.name)
                  ? "Remove this screen from pinned"
                  : "Pin this screen to the sidebar"
              }
              onClick={() =>
                setWorkspace(
                  toggleWorkspaceFavorite(slug, screen.name, identity),
                )
              }
            >
              {workspace.favorites.includes(screen.name) ? (
                <PushPinSlash size={15} />
              ) : (
                <PushPin size={15} />
              )}
              <span className="sr-only">
                {workspace.favorites.includes(screen.name)
                  ? "Unpin screen"
                  : "Pin screen"}
              </span>
            </button>
          )}
        <div className="flex-1" />
        <button
          data-testid="btn-period"
          className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
          onClick={() => setPeriodOpen(true)}
          title="Change period"
        >
          {toDisplayDate(from)} → {toDisplayDate(to)}
        </button>
        {canFocus && (
          <button
            data-testid="btn-focus-mode"
            aria-pressed={focusActive}
            className={`no-drag flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium ${focusActive ? "border-amber/50 bg-amber/10 text-ink" : "border-line bg-panel2 text-muted hover:border-amber/60 hover:text-ink"}`}
            onClick={() => setFocusMode((value) => !value)}
            title="Toggle focus mode (Command+Shift+F)"
          >
            {focusActive ? <CornersOut size={15} /> : <CornersIn size={15} />}
            {focusActive ? "Exit focus" : "Focus"}
          </button>
        )}
        {!focusActive && (
          <>
            <button
              data-testid="btn-theme"
              className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
              onClick={toggle}
              title="Switch theme"
            >
              {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
              <span className="sr-only">
                Switch to {theme === "light" ? "dark" : "light"} theme
              </span>
            </button>
            <button
              data-testid="btn-help-centre"
              aria-label="Open help centre"
              className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
              onClick={onOpenHelp}
              title="Help centre"
            >
              <Question size={15} />
            </button>
            <button
              className="flex items-center gap-2 rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
              onClick={onOpenPalette}
            >
              <MagnifyingGlass size={15} /> Search books <Kbd>⌘K</Kbd>
            </button>
            <button
              data-testid="btn-copilot"
              className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] font-medium text-ink hover:border-amber/60"
              onClick={onOpenCopilot}
              title="Ask Total copilot"
            >
              <Sparkle size={15} className="inline-block -translate-y-px" />{" "}
              Copilot
            </button>
            <SupportLink className="px-1 text-[11px]" />
            {user && (
              <>
                <span className="num rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted capitalize">
                  {user.name} · {user.role}
                </span>
                <button
                  data-testid="btn-lock"
                  className="rounded-md border border-line bg-panel2 px-2.5 py-1 text-[12px] text-muted hover:border-amber/60 hover:text-ink"
                  onClick={async () => {
                    try {
                      await api.auth.logout();
                      setUser(null);
                      setLocked(true);
                    } catch (err) {
                      toast.push("error", (err as Error).message);
                    }
                  }}
                >
                  <LockKey size={15} className="inline-block -translate-y-px" />{" "}
                  Lock
                </button>
              </>
            )}
          </>
        )}
      </header>

      <div className="flex min-h-0 flex-1">
        {!focusActive && (
          <aside data-testid="primary-navigation" className="flex w-[216px] shrink-0 flex-col overflow-hidden border-r border-line bg-panel px-2 py-2.5">
            <div className="mb-2 flex items-start gap-1 border-b border-line px-1 pb-3">
              <button
                className="min-w-0 flex-1 px-1.5 text-left"
                onClick={() => nav.go({ name: "company-info" })}
                title="Company details"
              >
                <span className="block truncate text-[13px] font-semibold text-ink">
                  {info?.name}
                </span>
                <span className="num mt-0.5 block truncate text-[10px] text-muted">
                  {info?.gstin || "Company details"}
                </span>
              </button>
              <button
                data-testid="btn-cross-company"
                aria-label="Switch company without leaving workspace"
                title="Switch company"
                onClick={() => setCompanySwitcherOpen(true)}
                className="rounded p-1.5 text-muted hover:bg-panel2 hover:text-ink"
              >
                <ArrowsLeftRight size={15} />
              </button>
            </div>
            <label className="mb-2 block px-2.5">
              <span className="mb-1 block text-[9.5px] font-semibold uppercase tracking-[0.1em] text-muted">
                Workspace
              </span>
              <select
                data-testid="select-workspace-profile"
                aria-label="Workspace profile"
                value={workspace.profile}
                onChange={(event) =>
                  slug &&
                  setWorkspace(
                    saveWorkspaceProfile(
                      slug,
                      event.target.value as WorkspaceProfile,
                      identity,
                    ),
                  )
                }
                className="w-full rounded-md border border-line bg-panel2 px-2 py-1.5 text-[11.5px] text-ink"
              >
                {WORKSPACE_PROFILES.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </select>
            </label>
            <nav aria-label="Application" className="min-h-0 flex-1 overflow-y-auto pb-2">
              {pinned.length > 0 && (
                <div className="mb-1 border-b border-line pb-2">
                  <p className="mb-1 px-2.5 text-[10.5px] font-medium text-muted">
                    Pinned
                  </p>
                  {pinned.map((def) => (
                    <button
                      key={`pin-${def.name}`}
                      onClick={() => nav.go(def.screen!)}
                      data-active={screen.name === def.name}
                      className="app-nav-item block w-full rounded-md px-2.5 py-[5px] text-left text-[13px] text-muted hover:bg-panel2 hover:text-ink"
                    >
                      {localizedLabel(def.navLabel ?? def.title, language)}
                    </button>
                  ))}
                </div>
              )}
              {visibleNav.map((section) => {
                const expanded = !section.title || expandedSections.has(section.id);
                return (
                  <div key={section.id} className={section.title ? "mt-1" : undefined}>
                    {section.title && (
                      <button
                        type="button"
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedSections((current) => {
                            const next = new Set(current);
                            if (next.has(section.id)) next.delete(section.id);
                            else next.add(section.id);
                            return next;
                          })
                        }
                        className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[10.5px] font-medium text-muted/90 hover:bg-panel2 hover:text-ink"
                      >
                        {localizedLabel(section.title, language)}
                        <CaretDown
                          size={12}
                          className={`transition-transform ${expanded ? "rotate-0" : "-rotate-90"}`}
                        />
                      </button>
                    )}
                    {expanded && section.items.map((item) => {
                      const active = screen.name === item.screen.name;
                      const shortcut = SCREEN_SHORTCUTS[item.screen.name];
                      return (
                        <button
                          key={item.label}
                          data-testid={`nav-${item.screen.name}`}
                          data-active={active}
                          onClick={() => nav.go(item.screen)}
                          className="app-nav-item block w-full rounded-md px-2.5 py-[5px] text-left text-[13px] text-muted hover:bg-panel2 hover:text-ink"
                          title={
                            shortcut
                              ? `${shortcut.shift ? "Alt+Shift" : "Alt"}+${shortcut.key.toUpperCase()}`
                              : undefined
                          }
                          aria-label={localizedLabel(item.label, language)}
                          data-voice-command={item.label}
                        >
                          {shortcut ? (
                            <MnemonicText
                              label={localizedLabel(item.label, language)}
                              mnemonic={shortcut.key}
                            />
                          ) : (
                            localizedLabel(item.label, language)
                          )}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
            <div className="shrink-0 border-t border-line pt-2">
              <button
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-panel2 hover:text-ink"
                onClick={async () => {
                  try {
                    await api.company.backup();
                    toast.push("success", "Local recovery snapshot saved");
                  } catch (err) {
                    toast.push("error", (err as Error).message);
                  }
                }}
              >
                Save local snapshot
              </button>
              <button
                data-testid="btn-switch-company"
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-[12.5px] text-muted hover:bg-panel2 hover:text-ink"
                onClick={async () => {
                  try {
                    await api.company.close();
                    clearCompany();
                    nav.home();
                  } catch (err) {
                    toast.push("error", (err as Error).message);
                  }
                }}
              >
                Switch company
              </button>
            </div>
          </aside>
        )}

        {/* data-screen + data-loading: the E2E harness's navigation/idle markers (lib/testids.ts). */}
        <main
          ref={mainRef}
          data-screen={screen.name}
          data-loading={fetching > 0 ? "true" : "false"}
          className={`min-h-0 flex-1 overflow-auto transition-[padding] duration-200 ${focusActive ? "bg-canvas p-7" : "p-5"}`}
          onPointerDownCapture={() => {
            if (scrollRestoreRef.current.key === restoreKey)
              scrollRestoreRef.current.complete = true;
          }}
          onTouchStartCapture={() => {
            if (scrollRestoreRef.current.key === restoreKey)
              scrollRestoreRef.current.complete = true;
          }}
          onWheelCapture={() => {
            if (scrollRestoreRef.current.key === restoreKey)
              scrollRestoreRef.current.complete = true;
          }}
          onScroll={(event) => {
            if (!slug || screen.name === "voucher-entry") return;
            const restoration = scrollRestoreRef.current;
            if (restoration.key === restoreKey && !restoration.complete) {
              if (
                Math.abs(event.currentTarget.scrollTop - restoration.target) <= 1
              ) {
                restoration.complete = true;
              } else {
                return;
              }
            }
            const canonical = screenDef(screen.name)?.screen;
            if (canonical)
              rememberContinuation(slug, {
                screen: canonical,
                from,
                to,
                scrollTop: event.currentTarget.scrollTop,
              });
          }}
        >
          <FeatureDiscovery screen={screen.name} />
          {children}
        </main>
      </div>

      {periodOpen && <PeriodModal onClose={() => setPeriodOpen(false)} />}
      {historyOpen && (
        <NavigationHistoryModal onClose={() => setHistoryOpen(false)} />
      )}
      {companySwitcherOpen && slug && (
        <CrossCompanyModal
          currentSlug={slug}
          onClose={() => setCompanySwitcherOpen(false)}
          onSwitch={async (targetSlug) => {
            const result = await api.company.open(targetSlug);
            queryClient.clear();
            setUser(null);
            setCompany(result.slug, result.info, result.locked);
            const continuation = readContinuation(result.slug);
            if (continuation) {
              setPeriod(continuation.from, continuation.to);
              nav.replace(continuation.screen);
            } else nav.home();
            if (!result.integrity.ok)
              setIntegrityWarning({
                ...result.integrity,
                context: "opened during a company switch",
              });
            setCompanySwitcherOpen(false);
            toast.push("success", `Switched to ${result.info.name}`);
          }}
        />
      )}
    </div>
  );
}

function NavigationHistoryModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const nav = useNav();
  const timeline = [...nav.stack, ...nav.future];
  const offset = Math.max(0, timeline.length - 20);
  const visible = timeline.slice(offset);
  const currentIndex = nav.stack.length - 1;

  return (
    <Modal title="Navigation history" onClose={onClose}>
      <p className="mb-3 text-[12px] leading-5 text-muted">
        Retrace reports and records without losing the path ahead. Command+[ and
        Command+] move one step at a time.
      </p>
      <div className="max-h-[420px] overflow-y-auto rounded-md border border-line bg-panel">
        {visible.map((item, visibleIndex) => {
          const index = offset + visibleIndex;
          const label = navigationLabel(item);
          const current = index === currentIndex;
          return (
            <button
              key={`${index}-${item.name}`}
              data-testid={`history-item-${index}`}
              aria-current={current ? "page" : undefined}
              disabled={current}
              onClick={() => {
                nav.seek(index);
                onClose();
              }}
              className={`group flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-b-0 ${current ? "bg-amber/8" : "hover:bg-panel2"}`}
            >
              <span
                className={`h-2 w-2 shrink-0 rounded-full border ${current ? "border-amber bg-amber" : index < currentIndex ? "border-muted/60" : "border-ink/50 bg-panel2"}`}
                aria-hidden="true"
              />
              <span className="min-w-0 flex-1">
                <span
                  className={`block truncate text-[12.5px] ${current ? "font-semibold text-ink" : "font-medium text-ink"}`}
                >
                  {label.title}
                </span>
                {label.detail && (
                  <span className="mt-0.5 block truncate text-[10.5px] text-muted">
                    {label.detail}
                  </span>
                )}
              </span>
              <span className="text-[10.5px] text-muted">
                {current
                  ? "Current"
                  : index < currentIndex
                    ? "Back"
                    : "Forward"}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function CrossCompanyModal({
  currentSlug,
  onClose,
  onSwitch,
}: {
  currentSlug: string;
  onClose: () => void;
  onSwitch: (slug: string) => Promise<void>;
}): React.JSX.Element {
  const toast = useToasts();
  const [busy, setBusy] = useState<string | null>(null);
  const { data } = useQuery({
    queryKey: ["company-switcher"],
    queryFn: api.company.list,
  });
  return (
    <Modal title="Switch company" onClose={onClose}>
      <p className="mb-3 text-[12px] leading-5 text-muted">
        Each company keeps its own workspace, dates and reading position.
      </p>
      <div className="overflow-hidden rounded-md border border-line">
        {(data?.companies ?? []).map((company) => {
          const current = company.slug === currentSlug;
          return (
            <button
              key={company.slug}
              data-testid={`switch-company-${company.slug}`}
              disabled={current || busy !== null}
              onClick={async () => {
                setBusy(company.slug);
                try {
                  await onSwitch(company.slug);
                } catch (error) {
                  toast.push("error", (error as Error).message);
                  setBusy(null);
                }
              }}
              className="flex min-h-12 w-full items-center justify-between border-b border-line px-3 py-2 text-left last:border-0 hover:bg-panel2 disabled:opacity-55"
            >
              <span>
                <span className="block text-[12.5px] font-medium">
                  {company.name}
                </span>
                <span className="num mt-0.5 block text-[10.5px] text-muted">
                  {company.gstin || "Unregistered"}
                </span>
              </span>
              <span className="text-[10.5px] text-muted">
                {current
                  ? "Current"
                  : busy === company.slug
                    ? "Opening…"
                    : "Open →"}
              </span>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function PeriodModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { from, to, setPeriod, info } = useSession();
  const [f, setF] = useState(from);
  const [t, setT] = useState(to);
  const [quick, setQuick] = useState("");
  const [quickError, setQuickError] = useState(false);
  const currentFy = fyOf(todayISO());
  const years: number[] = [];
  for (
    let y = info?.booksFrom ?? currentFy.startYear;
    y <= currentFy.startYear;
    y++
  )
    years.push(y);

  return (
    <Modal title="Working period" onClose={onClose}>
      <div className="mb-4 rounded-md border border-line bg-panel2 p-3">
        <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Quick period
        </span>
        <div className="flex gap-2">
          <input
            data-testid="input-period-quick"
            aria-label="Quick period expression"
            value={quick}
            onChange={(event) => {
              setQuick(event.target.value);
              setQuickError(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter")
                (
                  event.currentTarget.nextElementSibling as HTMLButtonElement
                )?.click();
            }}
            placeholder="Q2, last FY, last Friday…"
            className="w-full rounded-md border border-line bg-panel px-2.5 py-1.5 text-[12.5px] text-ink placeholder:text-muted/65"
          />
          <Button
            data-testid="btn-period-quick"
            onClick={() => {
              const parsed = parsePeriodExpression(quick, todayISO());
              if (!parsed) {
                setQuickError(true);
                return;
              }
              setF(parsed.from);
              setT(parsed.to);
              setQuickError(false);
            }}
          >
            Use
          </Button>
        </div>
        {quickError && (
          <p className="mt-1 text-[11px] text-cr">
            Try today, last Friday, Q1–Q4, this month or last FY.
          </p>
        )}
      </div>
      <div className="flex gap-3">
        <div className="flex-1">
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            From
          </span>
          <DateInput
            value={f}
            context={f}
            onChange={setF}
            testId="input-period-from"
          />
        </div>
        <div className="flex-1">
          <span className="mb-1 block text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            To
          </span>
          <DateInput
            value={t}
            context={t}
            onChange={setT}
            testId="input-period-to"
          />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {years.reverse().map((y) => {
          const fy = fyFromStartYear(y);
          return (
            <Button
              key={y}
              onClick={() => {
                setF(fy.from);
                setT(fy.to);
              }}
            >
              FY {fy.label}
            </Button>
          );
        })}
        <Button
          onClick={() => {
            const today = todayISO();
            setF(today.slice(0, 8) + "01");
            setT(today);
          }}
        >
          This month
        </Button>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="primary"
          data-testid="btn-apply-period"
          onClick={() => {
            setPeriod(f, t);
            onClose();
          }}
        >
          Apply period
        </Button>
      </div>
    </Modal>
  );
}
