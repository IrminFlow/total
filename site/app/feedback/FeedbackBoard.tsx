"use client";

import { FormEvent, useEffect, useState } from "react";

interface Idea {
  id: string;
  title: string;
  detail: string;
  status: "considering" | "planned" | "building" | "released";
  votes: number;
  releaseVersion: string | null;
}

interface FeedbackResponse {
  ideas?: Idea[];
  error?: string;
}

async function responseBody(response: Response): Promise<FeedbackResponse> {
  return response.json().catch(() => ({})) as Promise<FeedbackResponse>;
}

export default function FeedbackBoard(): React.JSX.Element {
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [compose, setCompose] = useState(false);
  const [sending, setSending] = useState(false);
  const [busyAction, setBusyAction] = useState("");
  const [followEmail, setFollowEmail] = useState("");
  const [voted, setVoted] = useState<Set<string>>(new Set());
  const [followed, setFollowed] = useState<Set<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    const load = async (): Promise<void> => {
      try {
        const response = await fetch("/api/feedback", {
          signal: controller.signal,
        });
        const value = await responseBody(response);
        if (!response.ok)
          throw new Error(value.error ?? "The board could not be loaded.");
        setIdeas(value.ideas ?? []);
      } catch (caught) {
        if (controller.signal.aborted) return;
        setError(
          caught instanceof Error
            ? caught.message
            : "The board could not be loaded.",
        );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  const action = async (
    name: "vote" | "follow",
    ideaId: string,
  ): Promise<void> => {
    if (name === "follow" && !followEmail.trim()) {
      setNotice("");
      setError("Enter your email before following an idea.");
      return;
    }
    setError("");
    setNotice("");
    setBusyAction(`${name}:${ideaId}`);
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: name,
          ideaId,
          email: name === "follow" ? followEmail.trim() : "",
        }),
      });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(
          body.error ?? "That action is temporarily unavailable.",
        );
      if (name === "vote") {
        setIdeas((rows) =>
          rows.map((row) =>
            row.id === ideaId ? { ...row, votes: row.votes + 1 } : row,
          ),
        );
        setVoted((current) => new Set(current).add(ideaId));
        setNotice("Your vote was recorded.");
      } else {
        setFollowed((current) => new Set(current).add(ideaId));
        setNotice("You will receive updates for this idea.");
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "That action is temporarily unavailable.",
      );
    } finally {
      setBusyAction("");
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const formElement = event.currentTarget;
    setSending(true);
    setError("");
    setNotice("");
    try {
      const form = new FormData(formElement);
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", ...Object.fromEntries(form) }),
      });
      const body = await responseBody(response);
      if (!response.ok)
        throw new Error(body.error ?? "That idea could not be submitted.");
      formElement.reset();
      setCompose(false);
      setNotice(
        "Your idea is awaiting review. It will appear here after publication.",
      );
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "That idea could not be submitted. Use Support instead.",
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="feedback-board" aria-busy={loading}>
      <div className="feedback-toolbar">
        <p>
          {loading
            ? "Loading customer ideas"
            : `${ideas.length} visible idea${ideas.length === 1 ? "" : "s"}. Accounting data is never attached.`}
        </p>
        <label>
          Email for updates
          <input
            type="email"
            value={followEmail}
            onChange={(event) => setFollowEmail(event.target.value)}
            placeholder="you@business.com"
            autoComplete="email"
          />
        </label>
        <button
          type="button"
          className="btn"
          onClick={() => {
            setCompose((value) => !value);
            setError("");
            setNotice("");
          }}
        >
          {compose ? "Cancel" : "Suggest an idea"}
        </button>
      </div>

      {compose && (
        <form
          className="feedback-compose"
          onSubmit={(event) => void submit(event)}
        >
          <label>
            Short title
            <input name="title" required minLength={5} maxLength={120} />
          </label>
          <label>
            What job would this improve?
            <textarea name="detail" required minLength={10} maxLength={2000} />
          </label>
          <label>
            Email for status updates (optional)
            <input name="email" type="email" autoComplete="email" />
          </label>
          <button className="btn" disabled={sending}>
            {sending ? "Sending…" : "Submit for review"}
          </button>
        </form>
      )}

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="form-notice" role="status">
          {notice}
        </p>
      )}

      {loading ? (
        <div className="idea-loading" aria-hidden="true">
          <div className="idea-skeleton" />
          <div className="idea-skeleton" />
        </div>
      ) : ideas.length === 0 ? (
        <div className="idea-empty">
          <h2 className="serif">No published ideas yet</h2>
          <p>Suggest the first one. New ideas appear after review.</p>
        </div>
      ) : (
        <div className="idea-grid">
          {ideas.map((idea) => {
            const voteBusy = busyAction === `vote:${idea.id}`;
            const followBusy = busyAction === `follow:${idea.id}`;
            return (
              <article key={idea.id} className="idea-card">
                <div className="idea-meta">
                  <span>{idea.status}</span>
                  {idea.releaseVersion && (
                    <b>Released in v{idea.releaseVersion}</b>
                  )}
                </div>
                <h2>{idea.title}</h2>
                <p>{idea.detail}</p>
                <div className="idea-actions">
                  <button
                    type="button"
                    disabled={voteBusy || voted.has(idea.id)}
                    onClick={() => void action("vote", idea.id)}
                  >
                    {voted.has(idea.id)
                      ? `Voted (${idea.votes})`
                      : voteBusy
                        ? "Recording…"
                        : `Vote (${idea.votes})`}
                  </button>
                  <button
                    type="button"
                    disabled={followBusy || followed.has(idea.id)}
                    onClick={() => void action("follow", idea.id)}
                  >
                    {followed.has(idea.id)
                      ? "Following"
                      : followBusy
                        ? "Saving…"
                        : "Follow updates"}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
