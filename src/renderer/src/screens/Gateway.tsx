import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/client";
import { useNav, useSession, useToasts, type Screen } from "../state/stores";
import {
  Button,
  Modal,
  Money,
  Panel,
  ScrollList,
  Skeleton,
} from "../components/ui";
import { isAnyModalOpen } from "../components/modalRegistry";
import { toDisplayDate, todayISO } from "@shared/dates";
import { upcomingDeadlines } from "@shared/compliance";
import { useFeatures } from "../lib/useFeatures";
import type { RecurringTemplate } from "@shared/domain";
import type { CashSparkPoint, TopLedgerRow } from "@shared/reports";
import { templateOpenTarget } from "./recurringDraft";
import { CARD_SCREENS } from "../lib/screens";
import { MnemonicText } from "../components/MnemonicText";
import {
  readWorkspacePrefs,
  saveHomeLayout,
  workspaceIdentity,
  type WorkspacePrefs,
} from "../lib/workspacePrefs";
import { ArrowsDownUp, Eye, EyeSlash } from "@phosphor-icons/react";
import { ArrowUpRight, ClipboardText, SunHorizon } from "@phosphor-icons/react";
import { morningDigestText } from "../lib/morningDigest";
import { useAccessibilityPreferences } from "../lib/accessibilityPrefs";
import { localizedLabel } from "../lib/localization";
import { deadlineCountdown } from "../lib/deadlineCountdown";

/** Home cards derived from the single screen registry (lib/screens.ts). */
const CARDS: {
  name: string;
  label: string;
  sub: string;
  screen: Screen;
  key: string;
  feature?: (typeof CARD_SCREENS)[number]["feature"];
}[] = CARD_SCREENS.map((s) => ({
  name: s.name,
  label: s.title,
  sub: s.card.sub,
  screen: s.screen,
  key: s.card.key,
  feature: s.feature,
}));

export function Gateway(): React.JSX.Element {
  const nav = useNav();
  const { from, to, info, slug, user } = useSession();
  const identity = workspaceIdentity(user);
  const today = todayISO();
  const features = useFeatures();
  const language = useAccessibilityPreferences((state) => state.language);
  const [homePrefs, setHomePrefs] = useState<WorkspacePrefs>(() =>
    readWorkspacePrefs(slug, identity),
  );
  const [customizing, setCustomizing] = useState(false);
  const [digestOpen, setDigestOpen] = useState(false);
  useEffect(
    () => setHomePrefs(readWorkspacePrefs(slug, identity)),
    [slug, identity],
  );
  const availableCards = useMemo(
    () => CARDS.filter((c) => !c.feature || features[c.feature]),
    [features],
  );
  const cards = useMemo(() => {
    const rank = new Map(
      homePrefs.homeOrder.map((name, index) => [name, index]),
    );
    return availableCards
      .filter(
        (card) => !homePrefs.hiddenHome.includes(card.name as Screen["name"]),
      )
      .sort(
        (a, b) =>
          (rank.get(a.name as Screen["name"]) ?? 999) -
          (rank.get(b.name as Screen["name"]) ?? 999),
      );
  }, [availableCards, homePrefs]);
  const { data } = useQuery({
    queryKey: ["dashboard", today, from],
    queryFn: ({ signal }) => api.reports.dashboard(today, from, signal),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // A key aimed at an open dialog (ConfirmModal "y", PromptModal text…) must never
      // double as a Gateway navigation shortcut underneath it.
      if (isAnyModalOpen()) return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const card = cards.find(
        (c) => c.key.toLowerCase() === e.key.toLowerCase(),
      );
      if (card) nav.go(card.screen);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [nav, cards]);

  const tiles: { label: string; value?: number; text?: string }[] = [
    { label: "Cash in hand", value: data?.cashBalance ?? 0 },
    { label: "Bank balance", value: data?.bankBalance ?? 0 },
    { label: "Receivables", value: data?.receivables ?? 0 },
    { label: "Payables", value: data?.payables ?? 0 },
    { label: "Sales this month", value: data?.monthSales ?? 0 },
    { label: "GST payable", value: data?.gstPayable ?? 0 },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex items-end justify-between border-b border-line pb-5">
        <div>
          <p className="num text-[10.5px] font-semibold tracking-[0.14em] text-muted uppercase">
            Gateway of Total · FY {from.slice(0, 4)}–{to.slice(2, 4)}
          </p>
          <h1 className="mt-1 font-serif text-[30px] font-semibold leading-tight tracking-[-0.02em]">
            {info?.name ?? "Your books"}
          </h1>
          <p className="mt-1 text-[12px] text-muted">
            Balances, deadlines and recent activity for this period.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            data-testid="btn-morning-digest"
            onClick={() => setDigestOpen(true)}
            className="flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-[12px] font-medium text-ink hover:border-amber/50 hover:bg-panel2"
          >
            <SunHorizon size={16} />
            Morning brief
          </button>
          <button
            data-testid="gateway-new-voucher"
            onClick={() => nav.go({ name: "voucher-entry" })}
            className="shortcut-on-dark group flex items-center gap-3 rounded-md bg-ink px-4 py-2.5 text-left text-bg transition-transform hover:-translate-y-px"
          >
            <span>
              <span className="block text-[12.5px] font-semibold">
                <MnemonicText
                  label={localizedLabel("Voucher entry", language)}
                  mnemonic="V"
                />
              </span>
              <span className="block text-[10.5px] opacity-65">
                Create a new transaction
              </span>
            </span>
            <kbd className="rounded border border-bg/25 px-1.5 py-0.5 text-[10px]">
              V
            </kbd>
          </button>
        </div>
      </header>
      <div className="gateway-kpis grid grid-cols-3 gap-3 lg:grid-cols-6">
        {tiles.map((t) => (
          <Panel key={t.label} className="px-4 py-3">
            <p className="text-[10.5px] font-semibold tracking-[0.08em] text-muted uppercase">
              {t.label}
            </p>
            {data === undefined && t.text === undefined ? (
              // Loading — a skeleton, not a misleading ₹0.00.
              <Skeleton className="mt-2.5 h-4 w-20" />
            ) : (
              <p
                className={`mt-1.5 text-[16px] font-medium ${t.text ? "" : "num"}`}
              >
                {t.text ?? <Money paise={t.value ?? 0} />}
              </p>
            )}
          </Panel>
        ))}
      </div>

      {data && (
        <div
          className="mt-3 grid grid-cols-4 gap-px overflow-hidden rounded-md border border-line bg-line"
          aria-label="Business pulse"
        >
          {[
            {
              label: "Current ratio",
              value: data.ratios.currentRatio,
              suffix: "×",
            },
            {
              label: "Debtor days",
              value: data.ratios.debtorDays,
              suffix: " days",
            },
            {
              label: "Gross margin",
              value: data.ratios.grossMarginPct,
              suffix: "%",
            },
            {
              label: "Net margin",
              value: data.ratios.netMarginPct,
              suffix: "%",
            },
          ].map((metric) => (
            <div
              key={metric.label}
              className="flex items-baseline justify-between bg-panel px-3 py-2"
            >
              <span className="text-[10.5px] text-muted">{metric.label}</span>
              <span className="num text-[11.5px] font-medium">
                {metric.value === null
                  ? "—"
                  : `${metric.value.toFixed(1)}${metric.suffix}`}
              </span>
            </div>
          ))}
        </div>
      )}

      <DueTodayPanel />
      <CompliancePanel
        hasEmployees={data?.hasEmployees ?? false}
        dashboardLoaded={data !== undefined}
      />

      <div className="mt-7 mb-2 flex items-baseline justify-between">
        <p className="text-[10.5px] font-semibold tracking-[0.12em] text-muted uppercase">
          Common tasks
        </p>
        <div className="flex items-center gap-3">
          <p className="text-[10.5px] text-muted">
            Press the red letter to open
          </p>
          <button
            data-testid="btn-customize-home"
            onClick={() => setCustomizing(true)}
            className="text-[11px] font-medium text-blue hover:underline"
          >
            Customize
          </button>
        </div>
      </div>
      <div
        className={`grid gap-px overflow-hidden rounded-lg border border-line bg-line ${homePrefs.density === "compact" ? "grid-cols-4" : "grid-cols-3"}`}
      >
        {cards.map((c) => (
          <button
            key={c.label}
            data-testid={`card-${c.name}`}
            onClick={() => nav.go(c.screen)}
            aria-label={localizedLabel(c.label, language)}
            data-voice-command={c.label}
            className={`group bg-panel text-left transition-colors hover:bg-panel2 ${homePrefs.density === "compact" ? "min-h-20 px-4 py-3" : "min-h-24 px-5 py-4"}`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[14.5px] font-medium">
                <MnemonicText
                  label={localizedLabel(c.label, language)}
                  mnemonic={c.key}
                />
              </span>
              <span
                aria-hidden="true"
                className="text-[15px] text-muted/40 transition-transform group-hover:translate-x-0.5 group-hover:text-ink"
              >
                →
              </span>
            </div>
            <p className="mt-1 text-[12px] text-muted">{c.sub}</p>
          </button>
        ))}
      </div>

      {/* Fixed row height: long receivable/payable lists scroll inside their panels instead of
          stretching the row — which would also stretch the sparkline opposite and make its
          aspect depend on how many debtors the company has. */}
      <div className="mt-6 grid h-[420px] grid-cols-2 gap-3">
        <div className="flex min-h-0 flex-col gap-3">
          <TopLedgersPanel
            title="Top receivables"
            rows={data?.topReceivables ?? []}
          />
          <TopLedgersPanel
            title="Top payables"
            rows={data?.topPayables ?? []}
          />
        </div>
        <CashSparklinePanel points={data?.cashSpark ?? []} />
      </div>

      {data && data.voucherCount === 0 ? (
        <OnboardingChecklist
          partyCount={data.partyCount}
          itemCount={data.itemCount}
        />
      ) : (
        data &&
        data.recentVouchers.length > 0 && (
          <Panel className="mt-6">
            <p className="border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
              Recent entries
            </p>
            <ScrollList maxH="20rem">
              {data.recentVouchers.map((v) => (
                <button
                  key={v.voucherId}
                  className="flex w-full items-center gap-4 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
                  onClick={() =>
                    nav.go({ name: "voucher-entry", voucherId: v.voucherId })
                  }
                >
                  <span className="num w-20 text-[12px] text-muted">
                    {toDisplayDate(v.date)}
                  </span>
                  <span className="w-24 text-[12.5px] text-muted">
                    {v.voucherType}
                  </span>
                  <span className="num w-14 text-[12px] text-muted">
                    {v.number}
                  </span>
                  <span className="flex-1 truncate text-[13px]">
                    {v.account}
                    {v.isOptional && (
                      <span
                        data-testid="recent-badge-optional"
                        className="ml-2 rounded bg-amber/15 px-1.5 py-0.5 text-[10px] font-medium text-amber"
                      >
                        Optional
                      </span>
                    )}
                    {v.postDated && (
                      <span
                        data-testid="recent-badge-pdc"
                        className="ml-2 rounded bg-blue/10 px-1.5 py-0.5 text-[10px] font-medium text-blue"
                      >
                        PDC
                      </span>
                    )}
                  </span>
                  <Money paise={v.debit} className="text-[13px]" />
                </button>
              ))}
            </ScrollList>
          </Panel>
        )
      )}
      {customizing && slug && (
        <CustomizeHomeModal
          cards={availableCards}
          value={homePrefs}
          onSave={(next) => {
            const saved = saveHomeLayout(slug, next, identity);
            setHomePrefs(saved);
            setCustomizing(false);
          }}
          onClose={() => setCustomizing(false)}
        />
      )}
      {digestOpen && (
        <MorningDigestModal onClose={() => setDigestOpen(false)} />
      )}
    </div>
  );
}

function MorningDigestModal({
  onClose,
}: {
  onClose: () => void;
}): React.JSX.Element {
  const nav = useNav();
  const toast = useToasts();
  const { from, to, info } = useSession();
  const today = todayISO();
  const digest = useQuery({
    queryKey: ["morning-digest", today, from, to],
    queryFn: async ({ signal }) => {
      const [dashboard, collections, payables, exceptions, recurring, tasks] =
        await Promise.all([
          api.reports.dashboard(today, from, signal),
          api.collections.queue(today),
          api.payables.queue(today),
          api.reports.exceptions(from, to, signal),
          api.recurring.due(today),
          api.tasks.list("open"),
        ]);
      const exceptionCount = exceptions.sections.reduce(
        (sum, section) => sum + section.rows.length,
        0,
      );
      const deadlines = upcomingDeadlines(
        today,
        info?.gstRegistrationType ?? "unregistered",
        dashboard.hasEmployees,
        30,
      );
      const tasksDue = tasks.filter(
        (task) => task.dueDate !== null && task.dueDate <= today,
      ).length;
      return {
        data: {
          date: toDisplayDate(today),
          company: info?.name ?? "Your books",
          cashAndBank: dashboard.cashBalance + dashboard.bankBalance,
          overdueReceivables: collections.reduce(
            (sum, row) => sum + row.overdueAmount,
            0,
          ),
          overduePayables: payables.overdueAmount,
          exceptionCount,
          deadlineCount: deadlines.length,
          recurringDue: recurring.length,
          tasksDue,
        },
        deadlines,
      };
    },
  });

  const open = (screen: Screen): void => {
    onClose();
    nav.go(screen);
  };
  const data = digest.data?.data;
  return (
    <Modal title="Morning brief" onClose={onClose} wide>
      <div className="mb-4 flex items-start justify-between border-b border-line pb-4">
        <div>
          <p className="font-serif text-[22px] font-semibold">{info?.name}</p>
          <p className="mt-1 text-[12px] text-muted">
            A local snapshot for {toDisplayDate(today)}. Nothing leaves this
            device.
          </p>
        </div>
        {data && (
          <Button
            data-testid="btn-copy-morning-digest"
            onClick={async () => {
              try {
                await api.privacy.copySensitive(morningDigestText(data));
                toast.push("success", "Morning brief copied");
              } catch {
                toast.push("error", "Could not copy the brief");
              }
            }}
          >
            <ClipboardText size={14} /> Copy
          </Button>
        )}
      </div>
      {digest.isLoading ? (
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : digest.isError || !data ? (
        <p className="py-10 text-center text-[12.5px] text-cr">
          The morning brief could not be prepared.
        </p>
      ) : (
        <>
          <div
            data-testid="morning-digest-metrics"
            className="grid grid-cols-3 gap-px overflow-hidden rounded-md border border-line bg-line"
          >
            {[
              {
                label: "Cash and bank",
                value: <Money paise={data.cashAndBank} signed />,
              },
              {
                label: "Overdue receivables",
                value: <Money paise={data.overdueReceivables} />,
              },
              {
                label: "Overdue payables",
                value: <Money paise={data.overduePayables} />,
              },
              { label: "Book exceptions", value: data.exceptionCount },
              { label: "Deadlines ahead", value: data.deadlineCount },
              {
                label: "Work due today",
                value: data.recurringDue + data.tasksDue,
              },
            ].map((metric) => (
              <div key={metric.label} className="bg-panel px-4 py-3">
                <p className="text-[10.5px] font-medium text-muted">
                  {metric.label}
                </p>
                <p className="num mt-1 text-[17px] font-semibold text-ink">
                  {metric.value}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-5 mb-2 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
            Start here
          </p>
          <div className="overflow-hidden rounded-md border border-line">
            {[
              {
                label: "Collect overdue customer balances",
                detail: `${data.overdueReceivables > 0 ? "Money is overdue" : "No overdue receivables"}`,
                screen: { name: "collections" } as Screen,
                count: data.overdueReceivables > 0,
              },
              {
                label: "Review supplier payments",
                detail: `${data.overduePayables > 0 ? "Supplier bills need attention" : "No overdue supplier bills"}`,
                screen: { name: "supplier-dues" } as Screen,
                count: data.overduePayables > 0,
              },
              {
                label: "Resolve book exceptions",
                detail: `${data.exceptionCount} check${data.exceptionCount === 1 ? "" : "s"} in the current period`,
                screen: { name: "exceptions" } as Screen,
                count: data.exceptionCount > 0,
              },
              {
                label: "Plan tasks and scheduled vouchers",
                detail: `${data.tasksDue} task${data.tasksDue === 1 ? "" : "s"} and ${data.recurringDue} recurring voucher${data.recurringDue === 1 ? "" : "s"} due`,
                screen: { name: "action-centre" } as Screen,
                count: data.tasksDue + data.recurringDue > 0,
              },
            ]
              .sort((a, b) => Number(b.count) - Number(a.count))
              .map((item) => (
                <button
                  key={item.label}
                  onClick={() => open(item.screen)}
                  className="group flex w-full items-center gap-3 border-b border-line px-3 py-2.5 text-left last:border-0 hover:bg-panel2"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium">
                      {item.label}
                    </span>
                    <span className="mt-0.5 block text-[10.5px] text-muted">
                      {item.detail}
                    </span>
                  </span>
                  <ArrowUpRight
                    size={14}
                    className="text-muted group-hover:text-ink"
                  />
                </button>
              ))}
          </div>
        </>
      )}
    </Modal>
  );
}

function CustomizeHomeModal({
  cards,
  value,
  onSave,
  onClose,
}: {
  cards: typeof CARDS;
  value: WorkspacePrefs;
  onSave: (
    value: Pick<WorkspacePrefs, "homeOrder" | "hiddenHome" | "density">,
  ) => void;
  onClose: () => void;
}): React.JSX.Element {
  const allNames = cards.map((card) => card.name as Screen["name"]);
  const initial = [
    ...value.homeOrder.filter((name) => allNames.includes(name)),
    ...allNames.filter((name) => !value.homeOrder.includes(name)),
  ];
  const [order, setOrder] = useState(initial);
  const [hidden, setHidden] = useState(
    value.hiddenHome.filter((name) => allNames.includes(name)),
  );
  const [density, setDensity] = useState(value.density);
  const move = (index: number, delta: -1 | 1): void =>
    setOrder((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
  const toggle = (name: Screen["name"]): void =>
    setHidden((current) => {
      if (current.includes(name))
        return current.filter((item) => item !== name);
      return current.length >= order.length - 1 ? current : [...current, name];
    });
  return (
    <Modal title="Customize Gateway" onClose={onClose} wide>
      <div className="mb-4 flex items-center justify-between rounded-md border border-line bg-panel2 px-3 py-2">
        <div>
          <p className="text-[12.5px] font-medium">Workspace density</p>
          <p className="text-[11px] text-muted">
            Comfortable is easier to scan; compact shows more at once.
          </p>
        </div>
        <div className="flex rounded-md border border-line bg-panel p-0.5">
          {(["comfortable", "compact"] as const).map((option) => (
            <button
              key={option}
              data-testid={`home-density-${option}`}
              onClick={() => setDensity(option)}
              className={`rounded px-2.5 py-1 text-[11.5px] capitalize ${density === option ? "bg-ink text-bg" : "text-muted"}`}
            >
              {option}
            </button>
          ))}
        </div>
      </div>
      <div className="max-h-[380px] overflow-y-auto rounded-md border border-line">
        {order.map((name, index) => {
          const card = cards.find((candidate) => candidate.name === name)!;
          const visible = !hidden.includes(name);
          return (
            <div
              key={name}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-line px-3 py-2 last:border-0"
            >
              <div>
                <p className="text-[12.5px] font-medium">{card.label}</p>
                <p className="text-[10.5px] text-muted">{card.sub}</p>
              </div>
              <button
                data-testid={`home-visibility-${name}`}
                onClick={() => toggle(name)}
                className="flex min-h-8 items-center gap-1.5 rounded px-2 text-[11px] text-muted hover:bg-panel2 hover:text-ink"
              >
                {visible ? <Eye size={14} /> : <EyeSlash size={14} />}
                {visible ? "Shown" : "Hidden"}
              </button>
              <div className="flex items-center">
                <button
                  aria-label={`Move ${card.label} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                  className="min-h-8 rounded px-2 text-muted hover:bg-panel2 disabled:opacity-25"
                >
                  ↑
                </button>
                <button
                  aria-label={`Move ${card.label} down`}
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                  className="min-h-8 rounded px-2 text-muted hover:bg-panel2 disabled:opacity-25"
                >
                  ↓
                </button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] text-muted">
          <ArrowsDownUp size={14} />
          Order stays with this company. Density follows your profile.
        </span>
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            data-testid="btn-save-home-layout"
            variant="primary"
            onClick={() =>
              onSave({ homeOrder: order, hiddenHome: hidden, density })
            }
          >
            Save layout
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DueTodayPanel(): React.JSX.Element | null {
  const nav = useNav();
  const toast = useToasts();
  const queryClient = useQueryClient();
  const today = todayISO();
  const { data: dueList } = useQuery({
    queryKey: ["recurring", "due", today],
    queryFn: () => api.recurring.due(today),
  });
  const [busyId, setBusyId] = useState<number | null>(null);

  if (!dueList?.length) return null;

  const post = async (t: RecurringTemplate): Promise<void> => {
    setBusyId(t.id);
    try {
      const saved = await api.recurring.post(t.id, today);
      await queryClient.invalidateQueries();
      toast.push("success", `${saved.number} posted from "${t.name}"`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const skip = async (t: RecurringTemplate): Promise<void> => {
    setBusyId(t.id);
    try {
      await api.recurring.skip(t.id);
      await queryClient.invalidateQueries();
      toast.push("success", `"${t.name}" skipped`);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  const openInVoucherEntry = (t: RecurringTemplate): void => {
    const { screen, warnInvoice } = templateOpenTarget(t);
    if (warnInvoice)
      toast.push("warning", "Line items must be re-entered for invoice types");
    nav.go(screen);
  };

  return (
    <Panel className="mt-6">
      <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Due today
        </p>
        <button
          className="text-[11.5px] text-blue hover:underline"
          onClick={() => nav.go({ name: "recurring" })}
        >
          All recurring vouchers
        </button>
      </div>
      <div>
        {dueList.map((t) => (
          <div
            key={t.id}
            className="flex items-center gap-4 border-b border-line/40 px-5 py-2 last:border-b-0"
          >
            <span className="num w-20 text-[12px] text-muted">
              {toDisplayDate(t.nextDue)}
            </span>
            <span className="flex-1 truncate text-[13px]">{t.name}</span>
            <Button disabled={busyId === t.id} onClick={() => void post(t)}>
              Post
            </Button>
            <Button disabled={busyId === t.id} onClick={() => void skip(t)}>
              Skip
            </Button>
            <Button
              variant="ghost"
              disabled={busyId === t.id}
              onClick={() => openInVoucherEntry(t)}
            >
              Open in voucher entry
            </Button>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** Fires once per company per app session (not per Gateway mount/remount) — a module-level set
 *  rather than component state, so navigating away and back to the Gateway doesn't re-notify,
 *  but switching companies does get its own notification. Keyed by company slug. */
const notifiedCompanies = new Set<string>();

function CompliancePanel({
  hasEmployees,
  dashboardLoaded,
}: {
  hasEmployees: boolean;
  dashboardLoaded: boolean;
}): React.JSX.Element | null {
  const nav = useNav();
  const { info, slug } = useSession();
  const today = todayISO();
  const [showAll, setShowAll] = useState(false);
  const gstRegistrationType = info?.gstRegistrationType ?? "unregistered";

  const deadlines = useMemo(
    () => upcomingDeadlines(today, gstRegistrationType, hasEmployees, 30),
    [today, gstRegistrationType, hasEmployees],
  );

  useEffect(() => {
    // Wait for the dashboard query to actually resolve, so `hasEmployees` (and hence PF/ESI
    // deadlines) reflects reality rather than the react-query default of `false`.
    if (!info || !slug || !dashboardLoaded || notifiedCompanies.has(slug))
      return;
    notifiedCompanies.add(slug);
    const soon = upcomingDeadlines(today, gstRegistrationType, hasEmployees, 3);
    if (soon.length) {
      // Deliberately fire-and-forget: an OS notification failing is not worth interrupting
      // the Gateway for — swallow the rejection.
      void api.app
        .notifyDeadlines(
          soon.map((d) => ({
            title: d.form,
            body: `${d.title} — due ${toDisplayDate(d.date)}`,
          })),
        )
        .catch(() => {});
    }
    // Deliberately no dependency-driven re-fire within a company: the module set above is the
    // real guard, this effect just needs to run once `info`/`dashboardLoaded` are available.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [info, slug, hasEmployees, dashboardLoaded]);

  if (!deadlines.length) return null;

  return (
    <Panel className="mt-6">
      <div className="flex items-center justify-between border-b border-line px-5 py-2.5">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Compliance calendar
        </p>
        <button
          className="text-[11.5px] text-blue hover:underline"
          onClick={() => nav.go({ name: "compliance-centre" })}
        >
          Open control room
        </button>
      </div>
      <div>
        {(showAll ? deadlines : deadlines.slice(0, 6)).map((d) => (
          <div
            key={d.id}
            className="flex items-center gap-4 border-b border-line/40 px-5 py-2 last:border-b-0"
          >
            <span className="num w-20 text-[12px] text-muted">
              {toDisplayDate(d.date)}
            </span>
            <span className="w-28 text-[12.5px] text-muted">{d.form}</span>
            <span className="flex-1 truncate text-[13px]">{d.title}</span>
          </div>
        ))}
        {deadlines.length > 6 && (
          <button
            data-testid="btn-gateway-compliance-all"
            className="w-full px-5 py-2 text-left text-[11.5px] text-blue hover:underline"
            onClick={() => setShowAll((v) => !v)}
          >
            {showAll ? "Show fewer" : `Show all ${deadlines.length}`}
          </button>
        )}
      </div>
    </Panel>
  );
}

/** Replaces "Recent entries" for a brand-new company (voucherCount === 0) with a short setup
 *  checklist — each step's "done" check is derived from data the dashboard already fetched, no
 *  extra round-trip. Disappears on its own once the first voucher is posted. */
function OnboardingChecklist({
  partyCount,
  itemCount,
}: {
  partyCount: number;
  itemCount: number;
}): React.JSX.Element {
  const nav = useNav();
  const steps = [
    {
      label: "Import your books from Tally",
      hint: "Or start from scratch — either way, head to Company info",
      done: partyCount > 0 || itemCount > 0,
      onClick: () => nav.go({ name: "import-tally" }),
    },
    {
      label: "Add a party and an item",
      hint: "Masters → Ledgers / Stock items",
      done: partyCount > 0 && itemCount > 0,
      onClick: () => nav.go({ name: "masters" }),
    },
    {
      label: "Post your first invoice",
      hint: "Voucher entry, F8 for Sales",
      done: false,
      onClick: () => nav.go({ name: "voucher-entry", kindHint: "sales" }),
    },
  ];

  return (
    <Panel className="mt-6">
      <p className="border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        Set up your books
      </p>
      <div>
        {steps.map((s) => (
          <button
            key={s.label}
            onClick={s.onClick}
            className="flex w-full items-center gap-3 border-b border-line/40 px-5 py-3 text-left last:border-b-0 hover:bg-panel2"
          >
            <span
              className={`text-[15px] ${s.done ? "text-amber" : "text-muted/60"}`}
            >
              {s.done ? "✓" : "○"}
            </span>
            <span className="flex-1">
              <span
                className={`block text-[13.5px] ${s.done ? "text-muted line-through" : "text-ink"}`}
              >
                {s.label}
              </span>
              <span className="block text-[11.5px] text-muted/70">
                {s.hint}
              </span>
            </span>
          </button>
        ))}
      </div>
    </Panel>
  );
}

/** Shared by "Top receivables" / "Top payables" — rows navigate straight to the ledger's statement. */
function TopLedgersPanel({
  title,
  rows,
}: {
  title: string;
  rows: TopLedgerRow[];
}): React.JSX.Element {
  const nav = useNav();
  return (
    <Panel className="flex min-h-0 flex-1 flex-col">
      <p className="shrink-0 border-b border-line px-5 py-2.5 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        {title}
      </p>
      {rows.length === 0 ? (
        <p className="px-5 py-6 text-center text-[12.5px] text-muted">
          Nothing outstanding
        </p>
      ) : (
        <ScrollList maxH="340px" className="min-h-0 flex-1">
          {rows.map((r) => (
            <button
              key={r.ledgerId}
              onClick={() =>
                nav.go({ name: "ledger-statement", ledgerId: r.ledgerId })
              }
              className="flex w-full items-center gap-3 border-b border-line/40 px-5 py-2 text-left last:border-b-0 hover:bg-panel2"
            >
              <span className="flex-1 truncate text-[13px]">{r.name}</span>
              <Money paise={r.amount} className="text-[13px]" />
            </button>
          ))}
        </ScrollList>
      )}
    </Panel>
  );
}

/** Inline SVG polyline — no chart library. `viewBox` is normalized to the point count so the
 *  path always fills the panel regardless of how many trailing days actually had data. The
 *  panel row it sits in is fixed-height, so the drawn aspect never shifts as sibling panels'
 *  content grows. Hovering reads out the date + balance under the cursor. */
function CashSparklinePanel({
  points,
}: {
  points: CashSparkPoint[];
}): React.JSX.Element {
  const w = 100;
  const h = 32;
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const values = points.map((p) => p.balance);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = max - min || 1;
  const xAt = (i: number): number =>
    points.length > 1 ? (i / (points.length - 1)) * w : w / 2;
  const yAt = (i: number): number =>
    h - ((points[i]!.balance - min) / range) * h;
  const coords = points
    .map((_, i) => `${xAt(i).toFixed(2)},${yAt(i).toFixed(2)}`)
    .join(" ");
  const readout =
    hoverIdx != null ? points[hoverIdx] : points[points.length - 1];

  return (
    <Panel className="flex min-h-0 flex-col p-5">
      <div className="flex shrink-0 items-center justify-between">
        <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
          Cash + bank · 30 days
        </p>
        {readout && (
          <p className="num text-[13px]">
            {hoverIdx != null && (
              <span className="mr-2 text-muted">
                {toDisplayDate(readout.date)}
              </span>
            )}
            <Money paise={readout.balance} />
          </p>
        )}
      </div>
      {points.length > 0 && (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="mt-4 min-h-0 w-full flex-1 text-blue"
          data-testid="spark-cash"
          role="img"
          aria-label="Cash and bank balance, last 30 days"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac =
              rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
            const idx = Math.round(frac * (points.length - 1));
            setHoverIdx(Math.max(0, Math.min(points.length - 1, idx)));
          }}
          onMouseLeave={() => setHoverIdx(null)}
        >
          {points.length === 1 ? (
            // A one-point polyline draws nothing — show a flat line at the lone balance instead.
            <line
              x1={0}
              y1={yAt(0)}
              x2={w}
              y2={yAt(0)}
              stroke="currentColor"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          ) : (
            <polyline
              points={coords}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hoverIdx != null && (
            <line
              x1={xAt(hoverIdx)}
              y1={0}
              x2={xAt(hoverIdx)}
              y2={h}
              stroke="var(--t-amber)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      )}
    </Panel>
  );
}
