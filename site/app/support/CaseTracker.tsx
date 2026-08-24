'use client'

import { FormEvent, useState } from 'react'

interface CaseStatus { caseId: string; category: string; status: string; receivedAt: string; updatedAt: string }

export default function CaseTracker(): React.JSX.Element {
  const [result, setResult] = useState<CaseStatus | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const lookup = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setBusy(true); setError(''); setResult(null)
    const form = new FormData(event.currentTarget)
    const query = new URLSearchParams({ caseId: String(form.get('caseId') ?? '').trim().toUpperCase(), email: String(form.get('email') ?? '').trim() })
    const response = await fetch(`/api/support?${query}`)
    const body = await response.json() as CaseStatus & { error?: string }
    setBusy(false)
    if (response.ok) setResult(body); else setError(body.error ?? 'Case not found')
  }
  return <section className="support-form" aria-labelledby="track-case"><h2 id="track-case" className="serif">Track a case</h2><p className="support-privacy">Use the case number and email from your submission. The message and diagnostics are never returned here.</p><form onSubmit={(event) => void lookup(event)}><div className="support-fields"><label>Case number<input name="caseId" required pattern="TOT-[0-9]{8}-([A-Fa-f0-9]{6}|[A-Fa-f0-9]{12})" placeholder="TOT-20260824-A1B2C3D4E5F6" /></label><label>Email<input name="email" type="email" required /></label></div><button className="btn" disabled={busy}>{busy ? 'Checking…' : 'Check status'}</button></form>{error && <p className="form-error">{error}</p>}{result && <p className="support-success"><b>{result.caseId}</b> · {result.status.replaceAll('_', ' ')} · updated {new Date(result.updatedAt).toLocaleDateString()}</p>}</section>
}
