// Phase 3a: Settings → AI (accountant) — which AI service the app talks to. One choice for every
// company on this computer (like the key), so the same shared-key rule applies: main refuses a
// change it may not make, and a company without users asks first. Header values never come back
// from main — a stored header shows its name, and an empty value keeps it.
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AI_CAPABILITY_KEYS, AI_PRESETS, AI_PRESET_IDS, checkBaseUrl, type AiCapabilities, type AiPresetId } from '@shared/aiProviders'
import type { AiSettingsView } from '@shared/ai'
import { aiApi } from '../../lib/aiClient'
import { confirmDialog } from '../../lib/dialogs'
import { useSession, useToasts } from '../../state/stores'
import { Banner, Button, Checkbox, Field, Panel, Select, TextInput } from '../../components/ui'

export const CAPABILITY_LABELS: Record<keyof AiCapabilities, string> = {
  tools: 'Uses Total’s tools (reads the books, makes drafts)',
  structured: 'Gives structured answers (reads bills and bank lines)',
  images: 'Reads photos of bills',
  files: 'Reads scanned PDF files'
}

interface HeaderRow {
  name: string
  value: string
  stored: boolean
}

export function AiProviderPanel({ view, isOwner, onDirty }: { view: AiSettingsView; isOwner: boolean; onDirty?: (dirty: boolean) => void }): React.JSX.Element {
  const p = view.provider
  const toast = useToasts()
  const queryClient = useQueryClient()
  const { user } = useSession()
  const { data: canSet } = useQuery({ queryKey: ['aiKeyCanSet'], queryFn: aiApi.keyCanSet })
  const blocked = !!canSet && !canSet.allowed && (canSet.reason === 'other_company_has_users' || (canSet.reason === 'owner_only' && !isOwner))
  const [preset, setPreset] = useState<AiPresetId>(p.preset)
  const [url, setUrl] = useState(p.baseUrlOverride ?? p.baseUrl)
  const [caps, setCaps] = useState<AiCapabilities>(p.caps)
  const [headers, setHeaders] = useState<HeaderRow[]>(p.headerNames.map((name) => ({ name, value: '', stored: true })))
  const [busy, setBusy] = useState(false)
  const def = AI_PRESETS[preset]
  const urlCheck = def.editableUrl ? checkBaseUrl(preset, url) : null
  const urlError = urlCheck && !urlCheck.ok ? urlCheck.error : undefined
  const disabled = !isOwner || blocked || busy
  const changed =
    preset !== p.preset ||
    (def.editableUrl && url.trim() !== (p.baseUrlOverride ?? p.baseUrl)) ||
    (preset === 'custom' && JSON.stringify(caps) !== JSON.stringify(p.caps)) ||
    headers.some((h) => !h.stored || h.value !== '') ||
    headers.length !== p.headerNames.length

  const pick = (id: AiPresetId): void => {
    setPreset(id)
    const next = AI_PRESETS[id]
    // The stored address only when going back to the stored preset; else the preset's own.
    setUrl(id === p.preset ? (p.baseUrlOverride ?? p.baseUrl) : next.baseUrl)
    setCaps(id === p.preset ? p.caps : next.caps)
    setHeaders(id === p.preset ? p.headerNames.map((name) => ({ name, value: '', stored: true })) : [])
  }

  useEffect(() => {
    onDirty?.(changed)
  }, [changed, onDirty])

  const save = async (): Promise<void> => {
    let confirmed = false
    if (!user) {
      const ok = await confirmDialog({
        title: 'Shared AI service',
        message: 'This company has no users, so anyone using this computer can change the AI service shared by all companies here. Continue?',
        confirmLabel: 'Continue'
      })
      if (!ok) return
      confirmed = true
    }
    setBusy(true)
    try {
      await aiApi.setProvider({
        preset,
        baseUrl: def.editableUrl ? url.trim() : null,
        ...(preset === 'custom' ? { caps } : {}),
        ...(def.headers ? { headers: headers.filter((h) => h.name.trim()).map((h) => ({ name: h.name.trim(), value: h.value })) } : {}),
        confirmNoUsers: confirmed
      })
      await queryClient.invalidateQueries({ queryKey: ['aiSettings'] })
      toast.push('success', `AI service: ${def.label}`)
    } catch (err) {
      toast.push('error', (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel className="p-5" testId="ai-provider">
      <h3 className="mb-1 text-detail font-semibold">AI service</h3>
      <p className="mb-3 text-body-sm text-muted">
        Any service that speaks the OpenAI API, with your own key — or a model running on this computer (Ollama, LM Studio), which needs no key
        and sends nothing over the internet. The choice is shared by every company on this computer.
      </p>
      {blocked && (
        <Banner tone="info" className="mb-3">
          {canSet?.reason === 'owner_only'
            ? 'Only the owner of this company can change the AI service.'
            : 'Another company on this computer has users, so the AI service can only be changed from that company, by its owner.'}
        </Banner>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Service">
          <Select value={preset} disabled={disabled} onChange={(e) => pick(e.target.value as AiPresetId)} data-testid="input-ai-provider">
            {AI_PRESET_IDS.map((id) => (
              <option key={id} value={id}>
                {AI_PRESETS[id].label}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Address"
          error={urlError}
          hint={def.local ? 'Only an address on this computer (localhost).' : def.editableUrl ? 'https://…/v1 — plain http only on this computer.' : 'Fixed for this service.'}
        >
          <TextInput className="num" value={def.editableUrl ? url : preset === p.preset ? p.baseUrl : ''}
            placeholder={def.editableUrl ? '' : 'Set by Total'} disabled={disabled || !def.editableUrl} onChange={(e) => setUrl(e.target.value)} data-testid="input-ai-base-url" />
        </Field>
      </div>
      {preset === 'custom' ? (
        <fieldset className="mt-3 flex flex-col gap-2" data-testid="ai-provider-caps">
          <legend className="mb-1 text-caption text-muted">What this service can do (Total won’t ask it for anything else)</legend>
          {AI_CAPABILITY_KEYS.map((k) => (
            <Checkbox key={k} label={CAPABILITY_LABELS[k]} checked={caps[k]} disabled={disabled} onChange={(v) => setCaps((c) => ({ ...c, [k]: v }))} testId={`input-ai-cap-${k}`} />
          ))}
        </fieldset>
      ) : (
        <p className="mt-3 text-caption text-muted" data-testid="ai-provider-caps">
          {AI_CAPABILITY_KEYS.filter((k) => def.caps[k]).map((k) => CAPABILITY_LABELS[k]).join(' · ')}
          {AI_CAPABILITY_KEYS.some((k) => !def.caps[k]) && <> — not: {AI_CAPABILITY_KEYS.filter((k) => !def.caps[k]).map((k) => CAPABILITY_LABELS[k].toLowerCase()).join(', ')}</>}
          . What a service can do also depends on the model you pick; Total says so in plain words when a model refuses.
        </p>
      )}
      {def.headers && (
        <div className="mt-3" data-testid="ai-provider-headers">
          <p className="mb-1 text-caption text-muted">Extra headers (optional; kept in the keychain with the key — a saved value is never shown; leave it empty to keep it)</p>
          {headers.map((h, i) => (
            <div key={i} className="mb-1 flex items-end gap-2">
              <TextInput aria-label="Header name" className="num" value={h.name} disabled={disabled || h.stored} onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <TextInput
                aria-label={`Value of ${h.name || 'the header'}`}
                type="password"
                autoComplete="off"
                className="num"
                value={h.value}
                placeholder={h.stored ? '•••••• (saved)' : 'value'}
                disabled={disabled}
                onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
              />
              <Button disabled={disabled} onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                Remove
              </Button>
            </div>
          ))}
          {headers.length < 10 && (
            <Button disabled={disabled} onClick={() => setHeaders((hs) => [...hs, { name: '', value: '', stored: false }])} data-testid="btn-ai-add-header">
              Add a header
            </Button>
          )}
        </div>
      )}
      {p.urlProblem && preset === p.preset && <p className="mt-2 text-hint text-danger">{p.urlProblem}</p>}
      <div className="mt-3 flex justify-end">
        <Button variant="primary" disabled={disabled || !!urlError || !changed} onClick={() => void save()} data-testid="btn-ai-save-provider">
          Use this service
        </Button>
      </div>
    </Panel>
  )
}
