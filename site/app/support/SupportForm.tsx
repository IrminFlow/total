'use client'

import { FormEvent, useState } from 'react'

export default function SupportForm(): React.JSX.Element {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [caseId, setCaseId] = useState('')
  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setState('sending')
    const form = new FormData(event.currentTarget)
    try {
      const response = await fetch('/api/support', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) })
      const result = await response.json() as { caseId?: string }
      if (response.ok) {
        setCaseId(result.caseId ?? '')
        setState('sent')
      } else setState('error')
    } catch {
      setState('error')
    }
  }
  if (state === 'sent') return <div className="support-success"><h2 className="serif">We have it.</h2><p>Thanks—your note is in the support queue.</p>{caseId && <p className="support-case-id">Case {caseId}</p>}</div>
  return <form className="support-form" onSubmit={(event) => void submit(event)}>
    <input name="website" tabIndex={-1} autoComplete="off" className="honeypot" aria-hidden="true" />
    <div className="support-fields">
      <label>Type<select name="category"><option value="question">Question</option><option value="bug">Something is broken</option><option value="accessibility">Accessibility issue</option><option value="idea">Product idea</option></select></label>
      <label>Email<input name="email" type="email" placeholder="you@business.com" /></label>
    </div>
    <label>What can we help with?<textarea name="message" required minLength={10} maxLength={5000} /></label>
    <p className="support-privacy">Your note goes to the Total support queue. We do not ask for passwords, API keys, bank credentials, or full accounting exports.</p>
    {state === 'error' && <p className="form-error">Couldn’t send that. Email total@irminflow.com instead.</p>}
    <button className="btn" disabled={state === 'sending'}>{state === 'sending' ? 'Sending…' : 'Send to Total support'}</button>
  </form>
}
