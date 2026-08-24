'use client'

import { FormEvent, useEffect, useState } from 'react'

interface Idea { id: string; title: string; detail: string; status: 'considering' | 'planned' | 'building' | 'released'; votes: number; releaseVersion: string | null }

export default function FeedbackBoard(): React.JSX.Element {
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [error, setError] = useState('')
  const [compose, setCompose] = useState(false)
  const [sending, setSending] = useState(false)
  useEffect(() => { void fetch('/api/feedback').then((response) => response.json()).then((value: { ideas: Idea[] }) => setIdeas(value.ideas ?? [])).catch(() => setError('The board could not be loaded.')) }, [])
  const action = async (name: 'vote' | 'follow', ideaId: string): Promise<void> => {
    const response = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: name, ideaId }) })
    if (!response.ok) setError('Voting and follows are temporarily unavailable. The public roadmap is still readable.')
    else if (name === 'vote') setIdeas((rows) => rows.map((row) => row.id === ideaId ? { ...row, votes: row.votes + 1 } : row))
  }
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault(); setSending(true); setError('')
    const form = new FormData(event.currentTarget)
    const response = await fetch('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'submit', ...Object.fromEntries(form) }) })
    setSending(false)
    if (response.ok) setCompose(false); else setError('Couldn’t submit that idea. Use Support and we’ll preserve it for the board.')
  }
  return <div className="feedback-board">
    <div className="feedback-toolbar"><p>{ideas.length} visible ideas · accounting data is never attached</p><button className="btn" onClick={() => setCompose((value) => !value)}>{compose ? 'Cancel' : 'Suggest an idea'}</button></div>
    {compose && <form className="feedback-compose" onSubmit={(event) => void submit(event)}><label>Short title<input name="title" required minLength={5} maxLength={120} /></label><label>What job would this improve?<textarea name="detail" required minLength={10} maxLength={2000} /></label><label>Email for status updates (optional)<input name="email" type="email" /></label><button className="btn" disabled={sending}>{sending ? 'Sending…' : 'Submit for review'}</button></form>}
    {error && <p className="form-error">{error}</p>}
    <div className="idea-grid">{ideas.map((idea) => <article key={idea.id} className="idea-card"><div className="idea-meta"><span>{idea.status}</span>{idea.releaseVersion && <b>Released in v{idea.releaseVersion}</b>}</div><h2>{idea.title}</h2><p>{idea.detail}</p><div className="idea-actions"><button onClick={() => void action('vote', idea.id)}>△ {idea.votes} votes</button><button onClick={() => void action('follow', idea.id)}>Follow updates</button></div></article>)}</div>
  </div>
}
