import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowClockwise,
  Clock,
  Package,
  PaperPlaneTilt,
  PlugsConnected,
  ShieldCheck,
} from "@phosphor-icons/react";
import { toDisplayDateTime } from "@shared/dates";
import { api } from "../../lib/client";
import { useSession, useToasts } from "../../state/stores";
import {
  Button,
  Field,
  Panel,
  SectionTitle,
  Select,
  TextInput,
} from "../../components/ui";

const humanTask = (value: string): string =>
  ({ backup: "Verified backup", mirror: "Agent mirror", report_pack: "Report pack" })[
    value
  ] ?? value;

export function IntegrationsSection(): React.JSX.Element {
  const { user } = useSession();
  const owner = !user || user.role === "owner";
  const toast = useToasts();
  const qc = useQueryClient();
  const plugins = useQuery({
    queryKey: ["integrationPlugins"],
    queryFn: api.integrations.plugins,
  });
  const endpoints = useQuery({
    queryKey: ["webhookEndpoints"],
    queryFn: api.integrations.webhookEndpoints,
    enabled: owner,
  });
  const outbox = useQuery({
    queryKey: ["webhookOutbox"],
    queryFn: () => api.integrations.webhookOutbox(100),
    enabled: owner,
  });
  const schedules = useQuery({
    queryKey: ["automationSchedules"],
    queryFn: api.integrations.schedules,
  });
  const runs = useQuery({
    queryKey: ["automationRuns"],
    queryFn: () => api.integrations.automationRuns(50),
  });
  const [installing, setInstalling] = useState(false);
  const [webhookOpen, setWebhookOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [hook, setHook] = useState({
    name: "",
    endpoint: "",
    eventTypes: "voucher.posted",
    secret: "",
  });
  const [schedule, setSchedule] = useState({
    name: "Nightly verified backup",
    taskKind: "backup" as "backup" | "mirror" | "report_pack",
    cadence: "daily" as "daily" | "weekly" | "monthly",
    localTime: "23:30",
    day: "1",
  });

  const refresh = async (): Promise<void> => {
    await Promise.all(
      [
        "integrationPlugins",
        "webhookEndpoints",
        "webhookOutbox",
        "automationSchedules",
        "automationRuns",
      ].map((key) => qc.invalidateQueries({ queryKey: [key] })),
    );
  };
  const fail = (error: unknown): void =>
    toast.push("error", error instanceof Error ? error.message : String(error));

  const install = async (): Promise<void> => {
    setInstalling(true);
    try {
      const result = await api.integrations.installPlugin();
      if (result) {
        await refresh();
        toast.push("success", `${result.name} manifest inspected and installed`);
      }
    } catch (error) {
      fail(error);
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div data-testid="integrations-settings">
      <SectionTitle
        right={
          <span className="flex items-center gap-1.5 text-[10.5px] text-muted">
            <ShieldCheck size={14} className="text-dr" /> Declarative sandbox
          </span>
        }
      >
        Integrations
      </SectionTitle>

      <div className="mb-5 grid gap-3 lg:grid-cols-[1.35fr_0.65fr]">
        <Panel className="relative overflow-hidden !bg-ink px-6 py-5 text-panel">
          <div className="absolute -right-10 -top-24 size-56 rounded-full border border-panel/10" />
          <p className="text-[9.5px] font-semibold uppercase tracking-[0.18em] text-panel/45">
            Local extension plane
          </p>
          <h3 className="mt-3 max-w-lg font-serif text-[25px] font-semibold tracking-[-0.02em]">
            Connect the edges. Keep the books sovereign.
          </h3>
          <p className="mt-2 max-w-xl text-[11px] leading-5 text-panel/55">
            Partners declare exact capabilities. Total supplies validated import mappings,
            report primitives and signed events—never raw SQL or executable plugin code.
          </p>
        </Panel>
        <Panel className="px-4 py-4">
          <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-muted">
            Boundary
          </p>
          <div className="mt-3 flex items-center gap-2">
            <PlugsConnected size={20} className="text-amber" />
            <p className="text-[13px] font-semibold">
              {plugins.data?.filter((row) => row.enabled).length ?? 0} active
            </p>
          </div>
          <p className="mt-2 text-[10px] leading-4 text-muted">
            Every payload, attempt and scheduled run remains visible here.
          </p>
        </Panel>
      </div>

      <div className="mb-5 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
        {[
          ["SETTLEMENTS", "Razorpay · Stripe", "Gross, fee GST, refund and withholding tie-out"],
          ["COMMERCE", "Shopify · WooCommerce", "Orders, cancellations, returns and settlement refs"],
          ["LOGISTICS", "Delhivery · Shiprocket", "Shipment CSV with hash manifest; no carrier lock-in"],
        ].map(([eyebrow, title, detail]) => (
          <div key={eyebrow} className="bg-panel px-4 py-3">
            <p className="text-[8px] font-semibold tracking-[0.14em] text-amber">{eyebrow}</p>
            <p className="mt-1.5 text-[11px] font-semibold">{title}</p>
            <p className="mt-1 text-[9px] leading-4 text-muted">{detail}</p>
          </div>
        ))}
      </div>

      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[17px] font-semibold">Partner manifests</h3>
        {owner && (
          <Button variant="primary" onClick={install} disabled={installing}>
            <Package size={14} className="mr-1.5 inline" />
            {installing ? "Inspecting…" : "Install manifest"}
          </Button>
        )}
      </div>
      <Panel className="mb-5 divide-y divide-line">
        {plugins.data?.length ? (
          plugins.data.map((plugin) => (
            <div key={plugin.id} className="flex items-center gap-4 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-[12px] font-semibold">{plugin.name}</p>
                  <span className="rounded border border-line bg-panel2 px-1.5 py-0.5 font-mono text-[8px] text-muted">
                    v{plugin.version}
                  </span>
                </div>
                <p className="mt-1 truncate text-[9.5px] text-muted">
                  {plugin.publisher} · {plugin.permissions.join(" · ") || "No authority"}
                </p>
                <p className="mt-1 text-[9px] text-muted/80">
                  {plugin.importers} importers · {plugin.reports} reports · {plugin.exports} exports · {plugin.screens} screens
                </p>
              </div>
              <span className={`text-[9px] font-semibold uppercase ${plugin.compatible ? "text-dr" : "text-cr"}`}>
                {plugin.compatible ? (plugin.enabled ? "Active" : "Ready") : "Incompatible"}
              </span>
              {owner && plugin.compatible && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    try {
                      await api.integrations.setPluginEnabled(plugin.id, !plugin.enabled);
                      await refresh();
                    } catch (error) {
                      fail(error);
                    }
                  }}
                >
                  {plugin.enabled ? "Disable" : "Enable"}
                </Button>
              )}
            </div>
          ))
        ) : (
          <div className="px-4 py-9 text-center">
            <p className="text-[12px] font-semibold">No partner manifests installed</p>
            <p className="mt-1 text-[10px] text-muted">Install a signed-off JSON manifest; it starts disabled.</p>
          </div>
        )}
      </Panel>

      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-[17px] font-semibold">Signed webhook outbox</h3>
          <p className="mt-0.5 text-[9.5px] text-muted">Optional outbound events with payload preview and bounded retry.</p>
        </div>
        {owner && <Button onClick={() => setWebhookOpen((value) => !value)}>Add endpoint</Button>}
      </div>
      {webhookOpen && (
        <Panel className="mb-3 grid gap-3 p-4 lg:grid-cols-2">
          <Field label="Name"><TextInput value={hook.name} onChange={(event) => setHook({ ...hook, name: event.target.value })} placeholder="Operations webhook" /></Field>
          <Field label="HTTPS endpoint"><TextInput value={hook.endpoint} onChange={(event) => setHook({ ...hook, endpoint: event.target.value })} placeholder="https://example.com/total/events" /></Field>
          <Field label="Event types" hint="Comma-separated; e.g. voucher.posted, backup.completed"><TextInput value={hook.eventTypes} onChange={(event) => setHook({ ...hook, eventTypes: event.target.value })} /></Field>
          <Field label="Signing secret" hint="Encrypted with the operating system key store"><TextInput type="password" value={hook.secret} onChange={(event) => setHook({ ...hook, secret: event.target.value })} /></Field>
          <div className="lg:col-span-2 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setWebhookOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={async () => {
              try {
                await api.integrations.saveWebhookEndpoint({ ...hook, eventTypes: hook.eventTypes.split(",").map((value) => value.trim()).filter(Boolean) });
                setHook({ name: "", endpoint: "", eventTypes: "voucher.posted", secret: "" });
                setWebhookOpen(false);
                await refresh();
                toast.push("success", "Webhook endpoint saved; secret encrypted");
              } catch (error) { fail(error); }
            }}>Save endpoint</Button>
          </div>
        </Panel>
      )}
      <Panel className="mb-5">
        <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-line bg-panel2 px-4 py-2.5">
          <p className="text-[10px] font-semibold">{endpoints.data?.length ?? 0} endpoints · {outbox.data?.length ?? 0} retained deliveries</p>
          {owner && endpoints.data?.length ? <Button variant="ghost" className="!min-h-0 !py-0" onClick={async () => {
            try {
              const queued = await api.integrations.enqueueTestWebhook("voucher.posted", { event: "voucher.posted", test: true, generatedAt: new Date().toISOString() });
              await refresh();
              toast.push("success", `${queued.length} test deliveries queued`);
            } catch (error) { fail(error); }
          }}><PaperPlaneTilt size={13} className="mr-1 inline" />Queue test</Button> : null}
        </div>
        {outbox.data?.length ? outbox.data.slice(0, 8).map((event) => (
          <div key={event.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-0">
            <div className="min-w-0">
              <p className="truncate text-[10.5px] font-semibold">{event.eventType} → {event.endpointName}</p>
              <p className="mt-0.5 truncate font-mono text-[8.5px] text-muted">{JSON.stringify(event.payload)}</p>
            </div>
            <span className={`text-[8.5px] font-semibold uppercase ${event.state === "delivered" ? "text-dr" : event.state === "dead" ? "text-cr" : "text-amber"}`}>{event.state} · {event.attempts}</span>
            {owner && event.state !== "delivered" && <Button variant="ghost" onClick={async () => { try { await api.integrations.deliverWebhook(event.id); await refresh(); } catch (error) { fail(error); } }}>Send now</Button>}
          </div>
        )) : <div className="px-4 py-7 text-center text-[10px] text-muted">No outbound payloads queued.</div>}
      </Panel>

      <div className="mb-2 flex items-center justify-between">
        <div>
          <h3 className="text-[17px] font-semibold">Local automation</h3>
          <p className="mt-0.5 text-[9.5px] text-muted">Backups, mirrors and report packs run only while Total is open.</p>
        </div>
        {owner && <Button onClick={() => setScheduleOpen((value) => !value)}>New schedule</Button>}
      </div>
      {scheduleOpen && (
        <Panel className="mb-3 grid gap-3 p-4 lg:grid-cols-4">
          <Field label="Name"><TextInput data-testid="input-automation-name" value={schedule.name} onChange={(event) => setSchedule({ ...schedule, name: event.target.value })} /></Field>
          <Field label="Task"><Select data-testid="select-automation-task" value={schedule.taskKind} onChange={(event) => setSchedule({ ...schedule, taskKind: event.target.value as typeof schedule.taskKind })}><option value="backup">Verified backup</option><option value="mirror">Agent mirror</option><option value="report_pack">Report pack</option></Select></Field>
          <Field label="Cadence"><Select data-testid="select-automation-cadence" value={schedule.cadence} onChange={(event) => setSchedule({ ...schedule, cadence: event.target.value as typeof schedule.cadence })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option></Select></Field>
          <Field label="Local time"><TextInput data-testid="input-automation-time" type="time" value={schedule.localTime} onChange={(event) => setSchedule({ ...schedule, localTime: event.target.value })} /></Field>
          {schedule.cadence !== "daily" && <Field label={schedule.cadence === "weekly" ? "Weekday (0–6)" : "Day (1–28)"}><TextInput type="number" min={schedule.cadence === "weekly" ? 0 : 1} max={schedule.cadence === "weekly" ? 6 : 28} value={schedule.day} onChange={(event) => setSchedule({ ...schedule, day: event.target.value })} /></Field>}
          <div className="flex items-end justify-end gap-2 lg:col-span-4">
            <Button variant="ghost" onClick={() => setScheduleOpen(false)}>Cancel</Button>
            <Button variant="primary" onClick={async () => {
              try {
                await api.integrations.saveSchedule({ name: schedule.name, taskKind: schedule.taskKind, cadence: schedule.cadence, localTime: schedule.localTime, dayOfWeek: schedule.cadence === "weekly" ? Number(schedule.day) : null, dayOfMonth: schedule.cadence === "monthly" ? Number(schedule.day) : null });
                setScheduleOpen(false);
                await refresh();
                toast.push("success", "Local schedule created");
              } catch (error) { fail(error); }
            }}>Create schedule</Button>
          </div>
        </Panel>
      )}
      <Panel className="divide-y divide-line">
        {schedules.data?.length ? schedules.data.map((item) => {
          const last = runs.data?.find((run) => run.scheduleId === item.id);
          return (
            <div key={item.id} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-4 py-3">
              <div>
                <p className="text-[11px] font-semibold">{item.name}</p>
                <p className="mt-0.5 text-[9px] text-muted">{humanTask(item.taskKind)} · {item.cadence} at {item.localTime} · next {toDisplayDateTime(new Date(item.nextRunAt))}</p>
                {last && <p className={`mt-1 text-[8.5px] ${last.status === "succeeded" ? "text-dr" : last.status === "failed" ? "text-cr" : "text-amber"}`}>Last run {last.status}{last.error ? ` · ${last.error}` : ""}</p>}
              </div>
              <span className={`text-[8.5px] font-semibold uppercase ${item.enabled ? "text-dr" : "text-muted"}`}>{item.enabled ? "Active" : "Paused"}</span>
              {owner && <div className="flex gap-1"><Button variant="ghost" title="Run now" onClick={async () => { try { await api.integrations.runAutomation(item.id); await refresh(); toast.push("success", `${humanTask(item.taskKind)} run finished`); } catch (error) { fail(error); } }}><ArrowClockwise size={14} /></Button><Button variant="ghost" onClick={async () => { try { await api.integrations.setScheduleEnabled(item.id, !item.enabled); await refresh(); } catch (error) { fail(error); } }}>{item.enabled ? "Pause" : "Resume"}</Button></div>}
            </div>
          );
        }) : <div className="flex items-center justify-center gap-2 px-4 py-8 text-[10px] text-muted"><Clock size={15} />No local schedules yet.</div>}
      </Panel>
    </div>
  );
}
