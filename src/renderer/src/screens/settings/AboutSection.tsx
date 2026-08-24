import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/client";
import { useSession, useToasts, type Toast } from "../../state/stores";
import {
  Button,
  DateInput,
  Field,
  Modal,
  Panel,
  SectionTitle,
  Select,
} from "../../components/ui";
import { toDisplayDate, todayISO } from "@shared/dates";
import {
  PRODUCT_FLAGS,
  readProductFlags,
  setProductFlag,
  type ProductFlagState,
} from "../../lib/productFlags";

const PLATFORM_LABELS: Record<string, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
};

function statusToast(r: {
  status: "dev" | "available" | "up-to-date" | "error";
  current: string;
  latest?: string;
}): {
  kind: Toast["kind"];
  text: string;
} {
  switch (r.status) {
    case "dev":
      return {
        kind: "info",
        text: "Running from source — update checks only apply to packaged builds",
      };
    case "up-to-date":
      return {
        kind: "success",
        text: `You're on the latest version (${r.current})`,
      };
    case "available":
      return {
        kind: "info",
        text: `Total ${(r.latest ?? "").replace(/^v/, "")} is available — see the download dialog`,
      };
    case "error":
      return {
        kind: "error",
        text: "Couldn't check for updates — check your internet connection",
      };
  }
}

export function AboutSection(): React.JSX.Element {
  const toast = useToasts();
  const { data: info } = useQuery({
    queryKey: ["appInfo"],
    queryFn: api.app.info,
  });
  const [checking, setChecking] = useState(false);
  const [productFlags, setProductFlags] = useState<ProductFlagState>(() =>
    readProductFlags(localStorage),
  );

  const checkUpdates = async (): Promise<void> => {
    setChecking(true);
    try {
      const r = await api.app.checkUpdates();
      const t = statusToast(r);
      toast.push(t.kind, t.text);
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div>
      <SectionTitle>About</SectionTitle>
      <Panel className="p-5">
        <p className="font-serif text-[17px] font-semibold">Total</p>
        <p className="mt-1 text-[13px] text-muted">
          Version <span className="num">{info?.version ?? "—"}</span> ·{" "}
          {info ? (PLATFORM_LABELS[info.platform] ?? info.platform) : "—"}
        </p>
        <div className="mt-4 flex gap-2">
          <Button disabled={checking} onClick={() => void checkUpdates()}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
          <Button
            onClick={() => {
              api.log
                .reveal()
                .catch((err: Error) => toast.push("error", err.message));
            }}
          >
            Reveal logs
          </Button>
          <Button
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("total:open-help", {
                  detail: { tab: "release" },
                }),
              )
            }
          >
            What's new
          </Button>
        </div>
        <p className="mt-6 text-[11.5px] text-muted">
          Your data lives at <span className="num">~/Documents/total</span> —
          fully offline, no cloud, no accounts.
        </p>
        <p className="mt-2 text-[11px] text-muted/70">
          © Irmin Labs — proprietary
        </p>
      </Panel>
      <Panel className="mt-4 p-5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">
          Device rollout controls
        </p>
        <p className="mt-2 text-[11px] leading-5 text-muted">
          Optional interface layers can be switched off locally for recovery or
          staged rollout. These flags are never fetched remotely and never gate
          database migrations, posting, reports, backups or permanent export.
          Changes apply after reopening Total.
        </p>
        <div className="mt-3 divide-y divide-line rounded-md border border-line bg-panel2">
          {PRODUCT_FLAGS.map((flag) => (
            <label key={flag.id} className="flex items-start gap-3 px-3 py-2.5">
              <input
                className="mt-0.5"
                type="checkbox"
                checked={productFlags.flags[flag.id]}
                onChange={(event) =>
                  setProductFlags(
                    setProductFlag(
                      localStorage,
                      flag.id,
                      event.target.checked,
                    ),
                  )
                }
              />
              <span>
                <span className="block text-[11.5px] font-medium text-ink">
                  {flag.label}
                </span>
                <span className="mt-0.5 block text-[9.5px] text-muted">
                  Safe fallback: {flag.safeFallback}
                </span>
              </span>
            </label>
          ))}
        </div>
      </Panel>
      <PeriodLockCard />
    </div>
  );
}

// ---------- period lock ----------

function PeriodLockCard(): React.JSX.Element {
  const { user } = useSession();
  const canEdit = user?.role === "owner";
  const { data } = useQuery({
    queryKey: ["companyLock"],
    queryFn: api.company.lockGet,
  });
  const [editing, setEditing] = useState(false);

  return (
    <Panel className="mt-4 p-5">
      <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        Period lock
      </p>
      <div className="mt-2 flex items-center justify-between">
        <p className="text-[13.5px]">
          {data?.date ? (
            <>
              Books are locked up to{" "}
              <span className="num font-medium">
                {toDisplayDate(data.date)}
              </span>{" "}
              — entries on or before that date can't be added, edited, or
              deleted.
            </>
          ) : (
            "No lock — every period is still open to editing."
          )}
        </p>
        {canEdit ? (
          <Button onClick={() => setEditing(true)} className="shrink-0">
            Change…
          </Button>
        ) : (
          <span className="shrink-0 text-[11.5px] text-muted">
            Only owners can change this
          </span>
        )}
      </div>
      {editing && (
        <LockModal
          current={data?.date ?? null}
          onClose={() => setEditing(false)}
        />
      )}
    </Panel>
  );
}

function LockModal({
  current,
  onClose,
}: {
  current: string | null;
  onClose: () => void;
}): React.JSX.Element {
  const toast = useToasts();
  const queryClient = useQueryClient();
  const today = todayISO();
  const [date, setDate] = useState(current ?? today);
  const [busy, setBusy] = useState(false);
  const [exceptionId, setExceptionId] = useState("");
  const approvedExceptions = useQuery({
    queryKey: ["controlExceptions", "approved"],
    queryFn: () => api.controls.exceptions("approved"),
    enabled: !!current,
  });

  const save = async (next: string | null): Promise<void> => {
    setBusy(true);
    try {
      await api.company.lockSet(
        next,
        next === null && exceptionId ? Number(exceptionId) : undefined,
      );
      await queryClient.invalidateQueries({ queryKey: ["companyLock"] });
      toast.push(
        "success",
        next
          ? `Books locked up to ${toDisplayDate(next)}`
          : "Lock removed — all periods are open",
      );
      onClose();
    } catch (err) {
      toast.push("error", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Change period lock" onClose={onClose}>
      <Field
        label="Locked up to"
        hint="Vouchers dated on or before this date can't be saved, edited, or deleted."
      >
        <DateInput value={date} context={today} onChange={setDate} />
      </Field>
      {current && (
        <div className="mt-3">
          <Field
            label="Approved exception for removing lock"
            hint="Request and approve a Period lock exception in Control room first."
          >
            <Select
              value={exceptionId}
              onChange={(e) => setExceptionId(e.target.value)}
            >
              <option value="">Choose approved exception…</option>
              {(approvedExceptions.data ?? [])
                .filter((row) => row.policyKind === "period_lock")
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    #{row.id} · {row.reason}
                  </option>
                ))}
            </Select>
          </Field>
        </div>
      )}
      <div className="mt-4 flex justify-between">
        <Button
          variant="danger"
          disabled={busy || !current || !exceptionId}
          onClick={() => void save(null)}
        >
          Remove lock
        </Button>
        <div className="flex gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={() => void save(date)}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
