'use client'

import { useState } from 'react'

/**
 * The contact form.
 *
 * It posts to `/api/feedback`, the same endpoint the app's own Support dialog uses, so a message
 * sent from the site and a message sent from a customer's machine land in one place and get one
 * answer. Nothing else is collected: no analytics call, no third-party form service, no hidden
 * fields about where you came from.
 *
 * The failure path is the part worth reading. That endpoint answers with an error rather than
 * swallowing a message when it has nowhere to put it, so this form must not report success it did
 * not get. When it fails it hands back everything typed as a pre-filled email, because the one
 * unforgivable outcome is a person writing three paragraphs about a bug and losing them.
 */

const TOPICS = [
  { id: 'buying', label: 'A question before buying' },
  { id: 'tally', label: 'Moving my books across from Tally' },
  { id: 'wrong', label: 'Something is wrong, or a figure looks off' },
  { id: 'practice', label: "I'm a CA or a reseller" },
  { id: 'other', label: 'Something else' }
]

type State = 'idle' | 'sending' | 'sent' | 'failed'

export default function ContactForm(props: { salesEmail: string }): React.JSX.Element {
  const [topic, setTopic] = useState(TOPICS[0].id)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [state, setState] = useState<State>('idle')
  const [error, setError] = useState('')

  const label = TOPICS.find((t) => t.id === topic)?.label ?? 'Something else'
  const mailto =
    `mailto:${props.salesEmail}` +
    `?subject=${encodeURIComponent(label)}` +
    `&body=${encodeURIComponent(message)}`

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState('sending')
    setError('')

    let data: { ok?: boolean; error?: string } = {}
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `[${label}]\n\n${message}`,
          email,
          platform: 'website contact form'
        })
      })
      data = (await res.json()) as typeof data
    } catch {
      data = { ok: false, error: 'That did not reach us — the request never left the browser.' }
    }

    if (!data.ok) {
      setState('failed')
      setError(data.error ?? 'That did not reach us.')
      return
    }
    setState('sent')
  }

  if (state === 'sent') {
    return (
      <div className="callout contact-done" role="status">
        <p>
          <b>It arrived, and a person will read it.</b>
        </p>
        <p>
          {email
            ? `The answer goes to ${email}. Most things are answered the same working day; anything that needs a fix in the app takes longer and you will be told which it is.`
            : 'You did not leave an address, so there is no way to reply. If you want an answer rather than only to be heard, send it again with an email address.'}
        </p>
      </div>
    )
  }

  return (
    <form className="buy-card contact-form" onSubmit={submit}>
      <div className="field">
        <label htmlFor="topic">What is it about</label>
        <select id="topic" value={topic} onChange={(e) => setTopic(e.target.value)}>
          {TOPICS.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </div>

      <div className="field">
        <label htmlFor="message">Your message</label>
        <textarea
          id="message"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          required
          minLength={5}
          rows={6}
          placeholder="What you are trying to do, and what happened instead."
        />
        <p className="field-help">
          If it is about your own books, a screenshot helps and email is the better route for it. We
          will never ask you to send us your data.
        </p>
      </div>

      <div className="field">
        <label htmlFor="contact-email">Email for the reply</label>
        <input
          id="contact-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          placeholder="Optional, but there is no other way to answer you"
        />
      </div>

      <button className="btn" type="submit" disabled={state === 'sending'}>
        {state === 'sending' ? 'Sending' : 'Send it'}
      </button>

      {state === 'failed' ? (
        <div className="field-error" role="status">
          <p>{error}</p>
          <p style={{ marginTop: 6 }}>
            Nothing was lost —{' '}
            <a href={mailto}>open this as an email instead</a>, with what you typed already in it.
          </p>
        </div>
      ) : null}
    </form>
  )
}
