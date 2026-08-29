'use client'

import { useState } from 'react'

/**
 * A reminder a few days before a thirty-day trial runs out.
 *
 * Opt-in in the strict sense: nothing is collected unless somebody types it here and ticks the
 * box, the box is never pre-ticked, and the address is used for exactly one message. The app
 * itself does not know this page exists and sends nothing, because it does not make network
 * calls. If you never fill this in, we never learn that you downloaded anything.
 */
export default function ReminderForm(): React.JSX.Element {
  const [email, setEmail] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle')
  const [message, setMessage] = useState('')

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState('sending')
    const res = await fetch('/api/reminder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, agreed })
    })
    const data = (await res.json()) as { ok: boolean; error?: string }
    if (!data.ok) {
      setState('error')
      setMessage(data.error ?? 'That did not go through. Try again, or write to us instead.')
      return
    }
    setState('done')
    setMessage('Noted. One message, a few days before day thirty, and then the address is deleted.')
  }

  if (state === 'done') {
    return (
      <p className="field-help" role="status">
        {message}
      </p>
    )
  }

  return (
    <form className="reminder" onSubmit={submit}>
      <div className="field">
        <label htmlFor="reminder-email">Email</label>
        <input
          id="reminder-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </div>
      <label className="check">
        <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} required />
        <span>Send me one reminder before my trial ends. No newsletter, no other mail.</span>
      </label>
      <button className="btn ghost" type="submit" disabled={state === 'sending' || !agreed}>
        {state === 'sending' ? 'Saving' : 'Remind me'}
      </button>
      {state === 'error' ? (
        <p className="field-error" role="status">
          {message}
        </p>
      ) : null}
    </form>
  )
}
