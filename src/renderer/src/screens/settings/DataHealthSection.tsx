import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  FirstAid,
  Gauge,
  HardDrive,
  ShieldCheck,
  Warning,
} from "@phosphor-icons/react";
import { api } from "../../lib/client";
import { confirmDialog } from "../../lib/dialogs";
import { useSession, useToasts } from "../../state/stores";
import { Button, Panel, SectionTitle, SkeletonRows } from "../../components/ui";

function bytes(value: number): string {
  if (value < 1024 ** 2) return `${Math.max(0, value / 1024).toFixed(0)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
}

export function DataHealthSection(): React.JSX.Element {
  const summary = useQuery({
    queryKey: ["system-health"],
    queryFn: api.systemHealth.summary,
  });
  const qc = useQueryClient();
  const toast = useToasts();
  const { user } = useSession();
  const owner = !user || user.role === "owner";
  const [busy, setBusy] = useState<string | null>(null);
  const data = summary.data;

  const maintain = async (
    mode: "quick" | "optimize" | "full",
  ): Promise<void> => {
    setBusy(mode);
    try {
      const result = await api.systemHealth.runMaintenance(mode);
      await qc.invalidateQueries({ queryKey: ["system-health"] });
      toast.push(
        result.quickCheck === "ok" ? "success" : "error",
        result.detail,
      );
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const recover = async (): Promise<void> => {
    if (
      !(await confirmDialog({
        title: "Prepare a recovery copy?",
        message:
          "Total will preserve the original database, WAL and shared-memory files, then attempt recovery into a separate verified backup. Your live books will not be replaced.",
        confirmLabel: "Prepare recovery copy",
      }))
    )
      return;
    setBusy("recovery");
    try {
      const result = await api.systemHealth.attemptRecovery();
      await qc.invalidateQueries({ queryKey: ["system-health"] });
      await qc.invalidateQueries({ queryKey: ["backups"] });
      toast.push(result.success ? "success" : "error", result.detail);
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const exportProfiler = async (): Promise<void> => {
    if (
      !(await confirmDialog({
        title: "Export anonymized profiler pack?",
        message:
          "The JSON includes app/runtime versions, memory, database sizes, record counts, category-only workload timings and SQLite query plans. It includes no company name, ledger name, voucher content, path, key or attachment.",
        confirmLabel: "Export profiler pack",
      }))
    )
      return;
    setBusy("profiler");
    try {
      const result = await api.systemHealth.exportProfiler();
      toast.push(
        "success",
        `Profiler pack exported with ${result.fields.length} allow-listed sections`,
      );
    } catch (error) {
      toast.push("error", (error as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (!data)
    return (
      <Panel>
        <SkeletonRows />
      </Panel>
    );
  const stateTone =
    data.diskState === "healthy"
      ? "text-dr"
      : data.diskState === "warning"
        ? "text-amber"
        : "text-cr";
  const metrics = [
    {
      icon: Database,
      label: "Database",
      value: bytes(data.databaseBytes),
      detail: `Schema v${data.schemaVersion}`,
    },
    {
      icon: HardDrive,
      label: "Free space",
      value: bytes(data.freeBytes),
      detail: data.diskState,
    },
    {
      icon: Gauge,
      label: "WAL",
      value: bytes(data.walBytes),
      detail: `${bytes(data.reclaimableBytes)} reclaimable`,
    },
    {
      icon: ShieldCheck,
      label: "Integrity",
      value: data.quickCheck === "ok" ? "Verified" : "Attention",
      detail: data.journalMode.toUpperCase(),
    },
  ];
  return (
    <div data-testid="data-health-settings">
      <SectionTitle
        right={
          <span
            className={`flex items-center gap-1.5 text-[10.5px] font-semibold uppercase ${stateTone}`}
          >
            <ShieldCheck size={14} /> {data.diskState}
          </span>
        }
      >
        Data health
      </SectionTitle>
      <Panel className="relative mb-4 overflow-hidden !bg-ink px-6 py-5 text-panel">
        <div className="absolute -right-12 -top-16 size-48 rounded-full border border-panel/10" />
        <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-panel/45">
          Books stay recoverable
        </p>
        <h3 className="mt-3 font-serif text-[25px] font-semibold tracking-[-0.02em]">
          See risk before it becomes downtime.
        </h3>
        <p className="mt-2 max-w-2xl text-[11px] leading-5 text-panel/55">
          Integrity, WAL growth, free space, maintenance and recovery evidence
          live in one owner-controlled workspace.
        </p>
      </Panel>

      {data.diskState !== "healthy" && (
        <div
          className={`mb-4 flex gap-3 rounded-lg border px-4 py-3 ${data.diskState === "critical" ? "border-cr/30 bg-cr/5 text-cr" : "border-amber/30 bg-amber/5 text-amber"}`}
        >
          <Warning size={19} className="shrink-0" />
          <div>
            <p className="text-[11.5px] font-semibold">
              {data.diskState === "critical"
                ? "Low-disk protection is active"
                : "Storage is running low"}
            </p>
            <p className="mt-0.5 text-[10px] leading-4">
              {data.riskyImportsAllowed
                ? "Existing work continues; plan cleanup before the next large import."
                : "Large imports are blocked to preserve reliable accounting writes. Free at least 2 GB before importing."}
            </p>
          </div>
        </div>
      )}

      <div className="mb-4 grid grid-cols-4 gap-px overflow-hidden rounded-lg border border-line bg-line">
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div key={metric.label} className="bg-panel px-4 py-3">
              <div className="flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-muted">
                <Icon size={13} />
                {metric.label}
              </div>
              <p className="mt-2 text-[17px] font-semibold">{metric.value}</p>
              <p className="mt-0.5 text-[9.5px] capitalize text-muted">
                {metric.detail}
              </p>
            </div>
          );
        })}
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.15fr_.85fr]">
        <Panel className="px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
              <Gauge size={18} />
            </span>
            <div>
              <p className="text-[12px] font-semibold">Safe maintenance</p>
              <p className="mt-1 text-[9.5px] leading-4 text-muted">
                Checks are read-only. Optimize checkpoints the WAL and refreshes
                planner statistics; no voucher or balance is rewritten.
              </p>
            </div>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              disabled={!owner || busy !== null}
              onClick={() => void maintain("quick")}
            >
              {busy === "quick" ? "Checking…" : "Quick check"}
            </Button>
            <Button
              disabled={!owner || busy !== null}
              onClick={() => void maintain("optimize")}
            >
              {busy === "optimize" ? "Optimizing…" : "Checkpoint & optimize"}
            </Button>
            <Button
              disabled={!owner || busy !== null}
              onClick={() => void maintain("full")}
            >
              {busy === "full" ? "Inspecting…" : "Full integrity check"}
            </Button>
          </div>
        </Panel>
        <Panel className="px-4 py-4">
          <div className="flex items-start gap-3">
            <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
              <FirstAid size={18} />
            </span>
            <div>
              <p className="text-[12px] font-semibold">Copy-based recovery</p>
              <p className="mt-1 text-[9.5px] leading-4 text-muted">
                Preserve the exact originals first, then ask SQLite for a
                separate verified copy. Restoration remains a deliberate Backups
                action.
              </p>
            </div>
          </div>
          <div className="mt-4 flex justify-between gap-3">
            <span className="text-[9px] text-muted">
              Never overwrites live books
            </span>
            <Button
              data-testid="btn-recovery-copy"
              disabled={!owner || busy !== null}
              onClick={() => void recover()}
            >
              {busy === "recovery" ? "Recovering…" : "Prepare copy"}
            </Button>
          </div>
        </Panel>
      </div>
      <Panel className="mt-3 flex items-center justify-between gap-5 px-4 py-3">
        <div className="flex items-start gap-3">
          <span className="rounded-md border border-line bg-panel2 p-2 text-amber">
            <Gauge size={18} />
          </span>
          <div>
            <p className="text-[11px] font-semibold">
              User-approved performance evidence
            </p>
            <p className="mt-1 text-[9.5px] leading-4 text-muted">
              Export an anonymized JSON pack for support: versions, memory,
              sizes, counts, workload timing and query plans only. The exact
              allow-list is shown before export.
            </p>
          </div>
        </div>
        <Button
          data-testid="btn-profiler-export"
          className="whitespace-nowrap"
          disabled={!owner || busy !== null}
          onClick={() => void exportProfiler()}
        >
          {busy === "profiler" ? "Exporting…" : "Export profiler pack"}
        </Button>
      </Panel>
      <p className="mt-3 text-[9px] text-muted">
        Workload governor ·{" "}
        {Object.values(data.workload.active).reduce(
          (sum, value) => sum + value,
          0,
        )}{" "}
        active ·{" "}
        {Object.values(data.workload.queued).reduce(
          (sum, value) => sum + value,
          0,
        )}{" "}
        queued · {data.workload.cancelled} obsolete requests cancelled
      </p>
    </div>
  );
}
