import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../lib/client'
import { useToasts, type Toast } from '../../state/stores'
import { Button, Panel, SectionTitle } from '../../components/ui'

const PLATFORM_LABELS: Record<string, string> = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }

function statusToast(r: { status: 'dev' | 'available' | 'up-to-date' | 'error'; current: string; latest?: string }): {
  kind: Toast['kind']
  text: string
} {
  switch (r.status) {
    case 'dev':
      return { kind: 'info', text: 'Running from source — update checks only apply to packaged builds' }
    case 'up-to-date':
      return { kind: 'success', text: `You're on the latest version (${r.current})` }
    case 'available':
      return { kind: 'info', text: `Total ${(r.latest ?? '').replace(/^v/, '')} is available — see the download dialog` }
    case 'error':
      return { kind: 'error', text: "Couldn't check for updates — check your internet connection" }
  }
}

export function AboutSection(): React.JSX.Element {
  const toast = useToasts()
  const { data: info } = useQuery({ queryKey: ['appInfo'], queryFn: api.app.info })
  const [checking, setChecking] = useState(false)

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      const r = await api.app.checkUpdates()
      const t = statusToast(r)
      toast.push(t.kind, t.text)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setChecking(false)
    }
  }

  return (
    <div>
      <SectionTitle>About</SectionTitle>
      <Panel className="p-5">
        <p className="font-serif text-[17px] font-semibold">Total</p>
        <p className="mt-1 text-[13px] text-muted">
          Version <span className="num">{info?.version ?? '—'}</span> ·{' '}
          {info ? (PLATFORM_LABELS[info.platform] ?? info.platform) : '—'}
        </p>
        <div className="mt-4 flex gap-2">
          <Button disabled={checking} onClick={() => void checkUpdates()}>
            {checking ? 'Checking…' : 'Check for updates'}
          </Button>
          <Button onClick={() => void api.log.reveal()}>Reveal logs</Button>
        </div>
        <p className="mt-6 text-[11.5px] text-muted">
          Your data lives at <span className="num">~/Documents/total</span> — fully offline, no cloud, no accounts.
        </p>
        <p className="mt-2 text-[11px] text-muted/70">© Irmin Labs — proprietary</p>
      </Panel>
    </div>
  )
}
