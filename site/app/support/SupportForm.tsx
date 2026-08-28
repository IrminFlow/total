"use client";

import { FormEvent, useState } from "react";

type SupportState =
  "idle" | "sending" | "sent" | "delayed" | "fallback" | "error";

interface SupportResponse {
  caseId?: string;
  status?: string;
  notification?: string;
  mailto?: string;
  error?: string;
  trackingToken?: string;
}

function TrackingReceipt({ caseId, trackingToken }: { caseId: string; trackingToken: string }): React.JSX.Element | null {
  const [notice, setNotice] = useState("");
  if (!caseId) return null;
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`Case ${caseId}\nTracking token ${trackingToken}`);
      setNotice("Tracking details copied.");
    } catch {
      setNotice("Select the case number and token above to copy them.");
    }
  };
  return (
    <div className="support-receipt">
      <p className="support-case-id">Case {caseId}</p>
      {trackingToken && <p className="support-case-id">Tracking token {trackingToken}</p>}
      {trackingToken && <button type="button" className="support-copy-link" onClick={() => void copy()}>Copy tracking details</button>}
      {notice && <p className="form-notice" role="status">{notice}</p>}
    </div>
  );
}

export default function SupportForm(): React.JSX.Element {
  const [state, setState] = useState<SupportState>("idle");
  const [caseId, setCaseId] = useState("");
  const [mailto, setMailto] = useState("mailto:total@irminflow.com");
  const [error, setError] = useState("");
  const [trackingToken, setTrackingToken] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState("sending");
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/support", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(Object.fromEntries(form)),
      });
      const result = (await response
        .json()
        .catch(() => ({}))) as SupportResponse;
      if (!response.ok)
        throw new Error(
          result.error ?? "The support request could not be sent.",
        );
      const nextCaseId = result.caseId ?? "";
      setCaseId(nextCaseId);
      setTrackingToken(result.trackingToken ?? "");
      if (result.status === "fallback") {
        setMailto(result.mailto ?? "mailto:total@irminflow.com");
        setState("fallback");
      } else if (
        result.notification === "failed" ||
        result.notification === "not_configured"
      ) {
        const subject = nextCaseId
          ? `?subject=${encodeURIComponent(`[${nextCaseId}] Total support follow-up`)}`
          : "";
        setMailto(`mailto:total@irminflow.com${subject}`);
        setState("delayed");
      } else {
        setState("sent");
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "The support request could not be sent.",
      );
      setState("error");
    }
  }

  if (state === "sent") {
    return (
      <div className="support-success" role="status">
        <h2 className="serif">Your case is in the queue.</h2>
        <p>Keep the case number below so you can check its status.</p>
        <TrackingReceipt caseId={caseId} trackingToken={trackingToken} />
      </div>
    );
  }
  if (state === "delayed") {
    return (
      <div className="support-success" role="status">
        <h2 className="serif">Your case was recorded.</h2>
        <p>
          The notification to the support team is delayed. Send the follow-up
          email to make sure it is seen promptly.
        </p>
        <TrackingReceipt caseId={caseId} trackingToken={trackingToken} />
        <a className="btn" href={mailto}>
          Send follow-up email
        </a>
      </div>
    );
  }
  if (state === "fallback") {
    return (
      <div className="support-success" role="status">
        <h2 className="serif">Keep this case number.</h2>
        <p>
          The support queue could not confirm delivery. Send the prepared email
          so the case is not lost.
        </p>
        <TrackingReceipt caseId={caseId} trackingToken={trackingToken} />
        <a className="btn" href={mailto}>
          Open prepared email
        </a>
      </div>
    );
  }

  return (
    <form
      className="support-form"
      onSubmit={(event) => void submit(event)}
      aria-busy={state === "sending"}
    >
      <input
        name="website"
        tabIndex={-1}
        autoComplete="off"
        className="honeypot"
        aria-hidden="true"
      />
      <div className="support-fields">
        <label>
          Type
          <select name="category">
            <option value="question">Question</option>
            <option value="bug">Something is broken</option>
            <option value="accessibility">Accessibility issue</option>
            <option value="privacy">Privacy or deletion request</option>
            <option value="idea">Product idea</option>
          </select>
        </label>
        <label>
          Severity
          <select name="severity" defaultValue="normal">
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">Work blocked</option>
            <option value="critical">Data or security risk</option>
          </select>
        </label>
        <label>
          Email (optional)
          <input
            name="email"
            type="email"
            placeholder="you@business.com"
            autoComplete="email"
          />
        </label>
      </div>
      <label>
        What can we help with?
        <textarea name="message" required minLength={10} maxLength={5000} />
      </label>
      <p className="support-privacy">
        If you provide an email, support can reply to you. Your private tracking token lets you check the case without an account. Do not send
        passwords, API keys, bank credentials or full accounting exports.
      </p>
      {state === "error" && (
        <p className="form-error" role="alert">
          {error} You can also email{" "}
          <a href="mailto:total@irminflow.com">total@irminflow.com</a>.
        </p>
      )}
      <button className="btn" disabled={state === "sending"}>
        {state === "sending" ? "Sending…" : "Send to Total support"}
      </button>
    </form>
  );
}
