import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "./ui";
import {
  api,
  type SupportCaseRecord,
  type SupportCategory,
  type SupportConsent,
  type SupportContextPreview,
  type SupportPayload,
  type SupportSeverity,
  type SupportOutboxSummary,
} from "../lib/client";
import { ArrowClockwise, Camera, CursorClick, Eye, ShieldCheck, Trash } from "@phosphor-icons/react";
import { focusContextFor, type FocusContext } from "../lib/supportContext";
import { useDeviceSafetyControls } from "../lib/useDeviceSafety";
import { confirmDialog } from "../lib/dialogs";

export const SUPPORT_EMAIL = "total@irminflow.com";

/** Support contact shown on every screen — Shell sidebar, company select and lock screen.
 *  Clicking it opens a small dialog so users can copy the address or launch their mail app. */
export function SupportLink({
  className = "",
}: {
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const lastFocus = useRef<FocusContext | null>(null);

  useEffect(() => {
    const remember = (event: FocusEvent): void => {
      const target = event.target as Element | null;
      if (
        target?.closest("[data-support-surface]") ||
        target?.closest('[data-testid="link-support"]')
      )
        return;
      lastFocus.current = focusContextFor(target);
    };
    window.addEventListener("focusin", remember);
    return () => window.removeEventListener("focusin", remember);
  }, []);

  return (
    <>
      <button
        type="button"
        data-testid="link-support"
        title={`Email support (${SUPPORT_EMAIL})`}
        onClick={() => setOpen(true)}
        className={`shrink-0 whitespace-nowrap text-left text-[12px] text-muted hover:text-ink ${className}`}
      >
        Support<span className="support-email"> · {SUPPORT_EMAIL}</span>
      </button>
      {open && (
        <SupportModal
          initialFocusContext={lastFocus.current}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function SupportModal({
  onClose,
  initialFocusContext,
}: {
  onClose: () => void;
  initialFocusContext: FocusContext | null;
}): React.JSX.Element {
  const deviceSafety = useDeviceSafetyControls();
  const uploadsEnabled = deviceSafety.supportUploads;
  const [category, setCategory] = useState<SupportCategory>("question");
  const [severity, setSeverity] = useState<SupportSeverity>("normal");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [includeMessage, setIncludeMessage] = useState(false);
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [includeLogs, setIncludeLogs] = useState(false);
  const [includeCompanyMetadata, setIncludeCompanyMetadata] = useState(false);
  const [includeFocusContext, setIncludeFocusContext] = useState(false);
  const [includeScreenshot, setIncludeScreenshot] = useState(false);
  const [screenshot, setScreenshot] = useState<{
    dataUrl: string;
    width: number;
    height: number;
  } | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "queued">("idle");
  const [error, setError] = useState("");
  const [caseRecord, setCaseRecord] = useState<SupportCaseRecord | null>(null);
  const [recentCases, setRecentCases] = useState<SupportCaseRecord[]>([]);
  const [outbox, setOutbox] = useState<SupportOutboxSummary[]>([]);
  const [context, setContext] = useState<SupportContextPreview | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [passphrase, setPassphrase] = useState("");
  const [confirmPassphrase, setConfirmPassphrase] = useState("");
  const [savingBundle, setSavingBundle] = useState(false);
  const [bundlePath, setBundlePath] = useState("");
  const [diagnostics, setDiagnostics] = useState<{
    version: string;
    platform: string;
    arch: string;
    installationId: string;
  } | null>(null);

  useEffect(() => {
    void api.support
      .diagnostics()
      .then(setDiagnostics)
      .catch(() => setDiagnostics(null));
    void api.support
      .cases()
      .then(setRecentCases)
      .catch(() => setRecentCases([]));
    void api.support.outbox().then(setOutbox).catch(() => setOutbox([]));
  }, []);

  useEffect(() => {
    if (uploadsEnabled) return;
    setIncludeScreenshot(false);
    setScreenshot(null);
  }, [uploadsEnabled]);

  useEffect(() => {
    setCaseRecord(null);
    setBundlePath("");
  }, [
    category,
    severity,
    includeCompanyMetadata,
    includeDiagnostics,
    includeFocusContext,
    includeLogs,
    includeMessage,
    includeScreenshot,
    message,
  ]);

  const loadContext = async (): Promise<void> => {
    if (context || contextLoading) return;
    setContextLoading(true);
    try {
      setContext(await api.support.contextPreview());
    } catch (err) {
      setIncludeLogs(false);
      setIncludeCompanyMetadata(false);
      setError((err as Error).message);
    } finally {
      setContextLoading(false);
    }
  };

  const consent = (): SupportConsent => ({
    message: includeMessage,
    diagnostics: includeDiagnostics,
    logs: includeLogs,
    companyMetadata: includeCompanyMetadata,
    focusContext: includeFocusContext && initialFocusContext !== null,
    screenshot: includeScreenshot && screenshot !== null,
  });

  const payload = (id: string): SupportPayload => ({
    caseId: id,
    category,
    severity,
    email,
    message,
    includeMessage,
    includeDiagnostics,
    includeLogs,
    includeCompanyMetadata,
    focusContext: includeFocusContext ? initialFocusContext : null,
    screenshotDataUrl: includeScreenshot ? (screenshot?.dataUrl ?? null) : null,
  });
  const validEmail = email.trim() === "" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());

  const refreshCases = (): void => {
    void api.support.cases().then(setRecentCases).catch(() => undefined);
    void api.support.outbox().then(setOutbox).catch(() => undefined);
  };

  const submit = async (): Promise<void> => {
    setState("sending");
    setError("");
    try {
      const supportCase =
        caseRecord ??
        (await api.support.createCase({ category, severity, consent: consent() }));
      setCaseRecord(supportCase);
      const result = await api.support.submit(payload(supportCase.id));
      setState(result.queued ? "queued" : "sent");
      refreshCases();
    } catch (err) {
      setState("idle");
      setError((err as Error).message);
      refreshCases();
    }
  };

  const saveOffline = async (): Promise<void> => {
    if (!caseRecord || passphrase !== confirmPassphrase) return;
    setSavingBundle(true);
    setError("");
    try {
      const saved = await api.support.bundleOffline({
        ...payload(caseRecord.id),
        passphrase,
      });
      if (saved) {
        setBundlePath(saved.path);
        refreshCases();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSavingBundle(false);
    }
  };

  const statusLabel = (record: SupportCaseRecord): string =>
    ({
      draft: "Draft",
      sending: "Sending",
      queued: "Queued securely",
      submitted: "Submitted",
      in_review: "In review",
      waiting_for_customer: "Waiting for reply",
      resolved: "Resolved",
      failed: "Delivery failed",
      saved_offline: "Saved offline",
    })[record.status];

  return (
    <Modal title="Get support" onClose={onClose} wide>
      <div data-support-surface="true">
        {state === "sent" || state === "queued" ? (
          <div className="rounded-md border border-dr/30 bg-dr/5 px-4 py-5 text-center">
            <p className="text-[14px] font-medium text-dr">
              {state === "queued" ? "Saved securely for retry" : "Feedback received"}
            </p>
            <p className="mt-1 text-[12px] text-muted">
              {state === "queued"
                ? "Support is offline. Open this panel when you are connected and retry the encrypted submission."
                : email.trim()
                  ? "Thank you. We’ll follow up at the email you provided."
                  : "Thank you. This device retained the private token needed to check the case."}
            </p>
            {caseRecord && (
              <p
                data-testid="support-case-id"
                className="num mt-3 text-[12px] font-semibold tracking-wide text-ink"
              >
                Case {caseRecord.id}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <label className="text-[11.5px] text-muted">
                Type
                <select
                  className="mt-1 w-full rounded border border-line bg-panel px-2.5 py-2 text-[13px] text-ink"
                  value={category}
                  onChange={(e) =>
                    setCategory(e.target.value as typeof category)
                  }
                >
                  <option value="question">Question</option>
                  <option value="bug">Something is broken</option>
                  <option value="accessibility">Accessibility issue</option>
                  <option value="privacy">Privacy or deletion request</option>
                  <option value="idea">Product idea</option>
                </select>
              </label>
              <label className="text-[11.5px] text-muted">
                Severity
                <select
                  className="mt-1 w-full rounded border border-line bg-panel px-2.5 py-2 text-[13px] text-ink"
                  value={severity}
                  onChange={(event) => setSeverity(event.target.value as SupportSeverity)}
                >
                  <option value="low">Low</option>
                  <option value="normal">Normal</option>
                  <option value="high">Work blocked</option>
                  <option value="critical">Data or security risk</option>
                </select>
              </label>
              <label className="text-[11.5px] text-muted">
                Email (optional)
                <input
                  className="mt-1 w-full rounded border border-line bg-panel px-2.5 py-2 text-[13px] text-ink"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@business.com"
                />
              </label>
            </div>
            <label className="mt-3 block text-[11.5px] text-muted">
              How can we help?
              <textarea
                autoFocus
                className="mt-1 min-h-28 w-full resize-y rounded border border-line bg-panel px-3 py-2 text-[13px] text-ink"
                value={message}
                maxLength={5000}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <label className="mt-2 flex items-start gap-2 rounded-md border border-line bg-panel2 px-3 py-2.5 text-[11.5px] text-ink">
              <input
                className="mt-0.5"
                type="checkbox"
                checked={includeMessage}
                onChange={(event) => setIncludeMessage(event.target.checked)}
              />
              <span>
                <strong className="font-medium">Send this message.</strong>{" "}
                Total does not keep its text in the local case history.
              </span>
            </label>
            <div className="mt-3 grid grid-cols-2 items-start gap-3">
              <div className="space-y-3">
                <label className="flex items-start gap-2 text-[11.5px] text-muted">
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={includeDiagnostics}
                    onChange={(e) => setIncludeDiagnostics(e.target.checked)}
                  />
                  Include app version, operating system and CPU architecture. No
                  company or accounting data is sent.
                </label>
                {includeDiagnostics && diagnostics && (
                  <div
                    data-testid="support-diagnostics-preview"
                    className="mt-2 overflow-hidden rounded-md border border-line bg-panel2"
                  >
                    <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-[11px] font-medium text-ink">
                      <Eye size={15} /> Exact diagnostic payload
                    </div>
                    <pre className="num overflow-auto px-3 py-2.5 text-[10.5px] leading-5 text-muted">
                      {JSON.stringify(diagnostics, null, 2)}
                    </pre>
                    <div className="flex items-center gap-1.5 border-t border-line px-3 py-2 text-[10.5px] text-dr">
                      <ShieldCheck size={14} weight="fill" /> The installation reference contains no company or user identity. No books, file paths, logs or credentials are included.
                    </div>
                  </div>
                )}
                <div className="rounded-md border border-line bg-panel2 p-3">
                  <p className="text-[11.5px] font-medium text-ink">
                    Book context (optional)
                  </p>
                  <p className="mt-1 text-[10.5px] leading-4 text-muted">
                    These are separate choices. Nothing here includes voucher
                    narration, ledger balances, file paths, or credentials.
                  </p>
                  <label className="mt-3 flex items-start gap-2 text-[11.5px] text-muted">
                    <input
                      className="mt-0.5"
                      type="checkbox"
                      checked={includeLogs}
                      onChange={(event) => {
                        setIncludeLogs(event.target.checked);
                        if (event.target.checked) void loadContext();
                      }}
                    />
                    Include up to 50 recent event names, levels, timestamps and
                    app versions.
                  </label>
                  <label className="mt-2 flex items-start gap-2 text-[11.5px] text-muted">
                    <input
                      className="mt-0.5"
                      type="checkbox"
                      checked={includeCompanyMetadata}
                      onChange={(event) => {
                        setIncludeCompanyMetadata(event.target.checked);
                        if (event.target.checked) void loadContext();
                      }}
                    />
                    Include company name, state, registration type, schema,
                    voucher count and enabled features.
                  </label>
                  {contextLoading && (
                    <p className="mt-2 text-[10.5px] text-muted">
                      Preparing exact preview…
                    </p>
                  )}
                  {context && (includeLogs || includeCompanyMetadata) && (
                    <div
                      data-testid="support-context-preview"
                      className="mt-2 overflow-hidden rounded border border-line bg-panel"
                    >
                      <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-[10.5px] font-medium text-ink">
                        <Eye size={14} /> Exact optional payload
                      </div>
                      <pre className="num max-h-36 overflow-auto px-2.5 py-2 text-[9.5px] leading-4 text-muted">
                        {JSON.stringify(
                          {
                            ...(includeLogs ? { logs: context.logs } : {}),
                            ...(includeCompanyMetadata
                              ? { companyMetadata: context.company }
                              : {}),
                          },
                          null,
                          2,
                        )}
                      </pre>
                    </div>
                  )}
                </div>
              </div>
              <div className="rounded-md border border-line bg-panel2 p-3">
                <p className="flex items-center gap-2 text-[11.5px] font-medium text-ink">
                  <CursorClick size={15} /> Accessibility context
                </p>
                <p className="mt-1 text-[10.5px] leading-4 text-muted">
                  Focus metadata excludes entered values. A screenshot can
                  contain visible company data, so review its preview before
                  sending.
                </p>
                <label className="mt-3 flex items-start gap-2 text-[11.5px] text-muted">
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={includeFocusContext}
                    disabled={!initialFocusContext}
                    onChange={(event) =>
                      setIncludeFocusContext(event.target.checked)
                    }
                  />
                  Include the last focused control's safe name, role and screen.
                  No entered value is included.
                </label>
                {includeFocusContext && initialFocusContext && (
                  <pre
                    data-testid="support-focus-preview"
                    className="num mt-2 overflow-auto rounded border border-line bg-panel px-2.5 py-2 text-[10px] leading-4 text-muted"
                  >
                    {JSON.stringify(initialFocusContext, null, 2)}
                  </pre>
                )}
                <label className="mt-3 flex items-start gap-2 text-[11.5px] text-muted">
                  <input
                    className="mt-0.5"
                    type="checkbox"
                    checked={includeScreenshot}
                    disabled={capturing || !uploadsEnabled}
                    onChange={async (event) => {
                      const checked = event.target.checked;
                      setIncludeScreenshot(checked);
                      if (!checked) {
                        setScreenshot(null);
                        return;
                      }
                      setCapturing(true);
                      try {
                        setScreenshot(await api.support.captureScreenshot());
                      } catch (err) {
                        setIncludeScreenshot(false);
                        setError((err as Error).message);
                      } finally {
                        setCapturing(false);
                      }
                    }}
                  />
                  Include a screenshot of the current app window. {uploadsEnabled
                    ? "Capture starts only after this box is checked."
                    : "Support attachments are disabled in Settings > Features."}
                </label>
                {capturing && (
                  <p className="mt-2 text-[10.5px] text-muted">
                    Capturing screenshot…
                  </p>
                )}
                {includeScreenshot && screenshot && (
                  <div
                    data-testid="support-screenshot-preview"
                    className="mt-2 overflow-hidden rounded border border-line bg-panel"
                  >
                    <div className="flex items-center gap-2 border-b border-line px-2.5 py-1.5 text-[10.5px] text-ink">
                      <Camera size={14} /> Screenshot preview.{" "}
                      {screenshot.width} × {screenshot.height}px
                    </div>
                    <img
                      src={screenshot.dataUrl}
                      alt="Support screenshot preview"
                      className="max-h-36 w-full object-contain"
                    />
                  </div>
                )}
              </div>
            </div>
            {error && (
              <div className="mt-3 rounded-md border border-cr/30 bg-cr/5 px-3 py-2.5">
                <p className="text-[11.5px] text-cr">{error}</p>
                {caseRecord && (
                  <div className="mt-3 border-t border-cr/20 pt-3">
                    <p className="text-[11.5px] font-medium text-ink">
                      Save an encrypted offline bundle
                    </p>
                    <p className="mt-1 text-[10.5px] leading-4 text-muted">
                      It contains only the items selected above. Share the
                      passphrase with support through a different channel.
                    </p>
                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <input
                        type="password"
                        value={passphrase}
                        onChange={(event) => setPassphrase(event.target.value)}
                        placeholder="Passphrase (12+ characters)"
                        className="rounded border border-line bg-panel px-2.5 py-2 text-[11.5px] text-ink"
                      />
                      <input
                        type="password"
                        value={confirmPassphrase}
                        onChange={(event) =>
                          setConfirmPassphrase(event.target.value)
                        }
                        placeholder="Confirm passphrase"
                        className="rounded border border-line bg-panel px-2.5 py-2 text-[11.5px] text-ink"
                      />
                    </div>
                    {confirmPassphrase && passphrase !== confirmPassphrase && (
                      <p className="mt-1.5 text-[10.5px] text-cr">
                        Passphrases do not match.
                      </p>
                    )}
                    <Button
                      className="mt-2"
                      data-testid="btn-save-support-bundle"
                      disabled={
                        savingBundle ||
                        passphrase.length < 12 ||
                        passphrase !== confirmPassphrase
                      }
                      onClick={() => void saveOffline()}
                    >
                      {savingBundle ? "Encrypting…" : "Save encrypted bundle"}
                    </Button>
                    {bundlePath && (
                      <p className="num mt-2 break-all text-[10px] text-dr">
                        Saved: {bundlePath}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {outbox.length > 0 && (
          <div className="mt-4 border-t border-line pt-3" data-testid="support-outbox">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
              Waiting to send
            </p>
            <p className="mt-1 text-[10px] leading-4 text-muted">
              Message contents remain encrypted by this device. Screenshots are retried only after you confirm again.
            </p>
            <div className="mt-2 space-y-2">
              {outbox.map((item) => (
                <div key={item.id} className="flex items-center justify-between gap-3 rounded border border-line bg-panel2 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="num truncate text-[10px] font-medium text-ink">{item.caseId}</p>
                    <p className="mt-0.5 text-[9.5px] text-muted">
                      {item.status === "retrying" ? "Retrying" : item.status === "failed" ? "Retry failed" : "Queued"}
                      {item.hasAttachment ? " · screenshot selected" : ""}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1.5">
                    <Button
                      data-testid={`btn-retry-support-${item.id}`}
                      disabled={item.hasAttachment && !uploadsEnabled}
                      disabledTitle={item.hasAttachment && !uploadsEnabled ? "Enable support attachments in Settings > Features before retrying this upload" : undefined}
                      onClick={async () => {
                        const approved = !item.hasAttachment || await confirmDialog({
                          title: "Retry support case",
                          message: "Retry this submission with its previously reviewed screenshot?",
                          confirmLabel: "Retry"
                        });
                        if (!approved) return;
                        setError("");
                        void api.support.retryQueued(item.id, item.hasAttachment).then(() => {
                          setState("sent");
                          refreshCases();
                        }).catch((err) => {
                          setError((err as Error).message);
                          refreshCases();
                        });
                      }}
                    >
                      <ArrowClockwise size={14} /> Retry
                    </Button>
                    <Button
                      data-testid={`btn-discard-support-${item.id}`}
                      onClick={async () => {
                        const confirmed = await confirmDialog({
                          title: "Delete queued submission",
                          message: "Delete this encrypted queued submission from this device?",
                          confirmLabel: "Delete",
                          danger: true
                        });
                        if (!confirmed) return;
                        void api.support.discardQueued(item.id).then(refreshCases).catch((err) => setError((err as Error).message));
                      }}
                    >
                      <Trash size={14} /> Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        {recentCases.length > 0 && (
          <div className="mt-4 border-t border-line pt-3">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted">
              Recent cases on this device
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {recentCases.slice(0, 3).map((item) => (
                <div
                  key={item.id}
                  className="rounded border border-line bg-panel2 px-2.5 py-2"
                >
                  <p className="num truncate text-[10px] font-medium text-ink">
                    {item.id}
                  </p>
                  <p className="mt-0.5 text-[10px] text-muted">
                    {statusLabel(item)} · {item.category} · {item.severity}
                  </p>
                  {item.trackingToken && (
                    <Button
                      className="mt-1.5"
                      data-testid={`btn-check-support-${item.id}`}
                      onClick={() => {
                        setError("");
                        void api.support.caseStatus(item.id).then(() => {
                          refreshCases();
                        }).catch((err) => setError((err as Error).message));
                      }}
                    >
                      <ArrowClockwise size={12} /> Check status
                    </Button>
                  )}
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[9.5px] text-muted">
              Case status, consent choices and private tracking tokens are retained locally—not message or email text.
            </p>
          </div>
        )}
        <div className="sticky -bottom-5 z-10 -mx-5 -mb-5 mt-5 flex justify-end gap-2 border-t border-line bg-panel px-5 py-3">
          <Button onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            data-testid="btn-open-mail"
            onClick={() => {
              window.open(`mailto:${SUPPORT_EMAIL}`);
              onClose();
            }}
          >
            Open in email app
          </Button>
          {state !== "sent" && state !== "queued" && (
            <Button
              variant="primary"
              data-testid="btn-submit-support"
              disabled={
                state === "sending" ||
                message.trim().length < 10 ||
                !validEmail ||
                !includeMessage ||
                (includeScreenshot && !screenshot)
              }
              onClick={() => void submit()}
            >
              {state === "sending" ? "Sending…" : "Send feedback"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}
