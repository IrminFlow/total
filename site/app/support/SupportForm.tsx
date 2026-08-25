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
}

export default function SupportForm(): React.JSX.Element {
  const [state, setState] = useState<SupportState>("idle");
  const [caseId, setCaseId] = useState("");
  const [mailto, setMailto] = useState("mailto:total@irminflow.com");
  const [error, setError] = useState("");

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
        {caseId && <p className="support-case-id">Case {caseId}</p>}
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
        {caseId && <p className="support-case-id">Case {caseId}</p>}
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
        {caseId && <p className="support-case-id">Case {caseId}</p>}
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
            <option value="idea">Product idea</option>
          </select>
        </label>
        <label>
          Email
          <input
            name="email"
            type="email"
            required
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
        Your email lets you track the case and receive a reply. Do not send
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
