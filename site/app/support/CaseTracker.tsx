"use client";

import { FormEvent, useState } from "react";

interface CaseStatus {
  caseId: string;
  category: string;
  status: string;
  receivedAt: string;
  updatedAt: string;
}

const STATUS_LABELS: Record<string, string> = {
  submitted: "Submitted",
  in_review: "In review",
  waiting_for_customer: "Waiting for your reply",
  resolved: "Resolved",
};

export default function CaseTracker(): React.JSX.Element {
  const [result, setResult] = useState<CaseStatus | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const lookup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    const form = new FormData(event.currentTarget);
    const token = String(form.get("token") ?? "").trim();
    const email = String(form.get("email") ?? "").trim();
    if (!token && !email) {
      setError("Enter the private tracking token or the reply email used for the case.");
      setBusy(false);
      return;
    }
    const query = new URLSearchParams({
      caseId: String(form.get("caseId") ?? "")
        .trim()
        .toUpperCase(),
      ...(token ? { token } : {}),
      ...(email ? { email } : {}),
    });
    try {
      const response = await fetch(`/api/support?${query}`);
      const body = (await response.json().catch(() => ({}))) as CaseStatus & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(body.error ?? "The case could not be found.");
      setResult(body);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Case tracking is temporarily unavailable.",
      );
    } finally {
      setBusy(false);
    }
  };

  const copyCaseId = async (): Promise<void> => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.caseId);
      setNotice("Case number copied.");
    } catch {
      setNotice("Select the case number above to copy it.");
    }
  };

  return (
    <section className="support-form" aria-labelledby="track-case">
      <h2 id="track-case" className="serif">
        Track a case
      </h2>
      <p className="support-privacy">
        Use the case number with its private tracking token, or the reply email from your submission. The message and
        diagnostics are never returned here.
      </p>
      <form onSubmit={(event) => void lookup(event)} aria-busy={busy}>
        <div className="support-fields">
          <label>
            Case number
            <input
              name="caseId"
              required
              pattern="TOT-[0-9]{8}-([A-Fa-f0-9]{6}|[A-Fa-f0-9]{12})"
              placeholder="TOT-20260824-A1B2C3D4E5F6"
              autoComplete="off"
            />
          </label>
          <label>
            Private tracking token
            <input name="token" autoComplete="off" />
          </label>
          <label>
            Reply email (alternative)
            <input name="email" type="email" autoComplete="email" />
          </label>
        </div>
        <button className="btn" disabled={busy}>
          {busy ? "Checking…" : "Check status"}
        </button>
      </form>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {result && (
        <div className="case-result" role="status">
          <b>{result.caseId}</b>
          <span>
            {STATUS_LABELS[result.status] ?? result.status.replaceAll("_", " ")}
          </span>
          <span className="case-result-meta">
            Updated{" "}
            {new Date(result.updatedAt).toLocaleDateString("en-IN", {
              day: "numeric",
              month: "short",
              year: "numeric",
            })}
          </span>
          <button type="button" onClick={() => void copyCaseId()}>
            Copy case number
          </button>
        </div>
      )}
      {notice && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}
