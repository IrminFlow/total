// Phase 3a: the simple AI helper's "Which AI service" card — the same ai:provider:set as Settings →
// AI (one choice for every business on this computer, the same shared-key rule). A preset is a
// chip; a local one (Ollama, LM Studio) or another service asks its address; another service also
// says what it can do. Custom headers stay in the full app. What the chosen service can't do is
// said in plain words.
import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { AI_CAPABILITY_KEYS, AI_PRESETS, AI_PRESET_IDS, checkBaseUrl, type AiCapabilities, type AiPresetId, type BaseUrlProblem } from '@shared/aiProviders'
import type { AiSettingsView } from '@shared/ai'
import type { MessageKey } from '@shared/i18n'
import { classifyAiError, type AiPlainError } from '@shared/simple/aiPlain'
import { aiApi } from '../../lib/aiClient'
import { confirmDialog } from '../../lib/dialogs'
import { useT } from '../../lib/i18n'
import { useSession, useToasts } from '../../state/stores'
import { Button, Checkbox, Field, TextInput } from '../../components/ui'

const SETTINGS_KEY = ['aiSettings'] // i18n-technical

/** Names that need words in the reader's language; the others are brand names, shown as they are. */
const PRESET_WORDS: Partial<Record<AiPresetId, MessageKey>> = {
  ollama: 'simple.ai.provider.name.ollama',
  lmstudio: 'simple.ai.provider.name.lmstudio',
  custom: 'simple.ai.provider.name.custom'
}

export function presetName(id: AiPresetId, t: ReturnType<typeof useT>): string {
  const key = PRESET_WORDS[id]
  return key ? t(key) /* i18n-technical: keys in PRESET_WORDS */ : AI_PRESETS[id].label
}

const URL_PROBLEM: Record<BaseUrlProblem, MessageKey> = {
  empty: 'simple.ai.provider.url.empty',
  notUrl: 'simple.ai.provider.url.notUrl',
  scheme: 'simple.ai.provider.url.scheme',
  credentials: 'simple.ai.provider.url.credentials',
  query: 'simple.ai.provider.url.query',
  notLocal: 'simple.ai.provider.url.notLocal',
  notHttps: 'simple.ai.provider.url.notHttps'
}

const CAP_TEXT: Record<keyof AiCapabilities, MessageKey> = {
  tools: 'simple.ai.provider.cap.tools',
  structured: 'simple.ai.provider.cap.structured',
  images: 'simple.ai.provider.cap.images',
  files: 'simple.ai.provider.cap.files'
}

/** "can't: read photos of bills, read scanned PDFs" for the chosen service (null = it can do all). */
export function cannotList(caps: AiCapabilities, t: ReturnType<typeof useT>): string | null {
  const missing = AI_CAPABILITY_KEYS.filter((k) => !caps[k])
  return missing.length ? missing.map((k) => t(CAP_TEXT[k]).toLowerCase()) /* i18n-technical: keys in CAP_TEXT */.join(', ') : null
}

export function ProviderCard({
  view,
  canEdit,
  blocked,
  busy,
  onError,
  onDirty
}: {
  view: AiSettingsView
  canEdit: boolean
  blocked: boolean
  busy: boolean
  onError: (e: AiPlainError) => void
  /** The card holds a choice not saved yet (the key box waits for it). */
  onDirty?: (dirty: boolean) => void
}): React.JSX.Element {
  const t = useT()
  const toast = useToasts()
  const queryClient = useQueryClient()
  const user = useSession((s) => s.user)
  const p = view.provider
  const [preset, setPreset] = useState<AiPresetId>(p.preset)
  const [url, setUrl] = useState(p.baseUrlOverride ?? p.baseUrl)
  const [caps, setCaps] = useState<AiCapabilities>(p.caps)
  const [saving, setSaving] = useState(false)
  const def = AI_PRESETS[preset]
  const check = def.editableUrl ? checkBaseUrl(preset, url) : null
  const disabled = !canEdit || blocked || busy || saving
  const changed = preset !== p.preset || (def.editableUrl && url.trim() !== (p.baseUrlOverride ?? p.baseUrl)) || (preset === 'custom' && JSON.stringify(caps) !== JSON.stringify(p.caps))
  const service = presetName(p.preset, t)
  useEffect(() => {
    onDirty?.(changed)
  }, [changed, onDirty])
  const cannot = cannotList(p.caps, t)

  const choose = (id: AiPresetId): void => {
    setPreset(id)
    setUrl(id === p.preset ? (p.baseUrlOverride ?? p.baseUrl) : AI_PRESETS[id].baseUrl)
    setCaps(id === p.preset ? p.caps : AI_PRESETS[id].caps)
  }

  const save = async (): Promise<void> => {
    let confirmed = false
    if (!user) {
      const ok = await confirmDialog({ title: t('simple.ai.provider.confirmTitle'), message: t('simple.ai.provider.confirmText'), confirmLabel: t('simple.ai.provider.confirmOk') })
      if (!ok) return
      confirmed = true
    }
    setSaving(true)
    try {
      await aiApi.setProvider({ preset, baseUrl: def.editableUrl ? url.trim() : null, ...(preset === 'custom' ? { caps } : {}), confirmNoUsers: confirmed })
      await queryClient.invalidateQueries({ queryKey: SETTINGS_KEY })
      toast.push('success', t('simple.ai.provider.saved', { service: presetName(preset, t) }))
    } catch (err) {
      onError(classifyAiError((err as Error)?.message ?? String(err)))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-lg border border-line bg-panel px-panel py-4 shadow-elev-1" data-testid="simple-ai-provider">
      <h2 className="mb-2 text-detail font-semibold text-ink">{t('simple.ai.provider.title')}</h2>
      <p className="mb-3 text-small text-muted">{t('simple.ai.provider.what')}</p>
      <div role="radiogroup" aria-label={t('simple.ai.provider.title')} className="flex flex-wrap gap-2">
        {AI_PRESET_IDS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={preset === id}
            disabled={disabled}
            data-testid={`simple-ai-provider-${id}`}
            onClick={() => choose(id)}
            className={`rounded-md border px-3 py-1.5 text-detail transition-colors ${
              preset === id ? 'border-amber bg-amberbar/15 font-semibold text-ink' : 'border-line bg-panel text-ink hover:border-amber/60'
            }`}
          >
            {presetName(id, t)}
          </button>
        ))}
      </div>
      {def.editableUrl && (
        <div className="mt-3">
          <Field label={t('simple.ai.provider.address')} hint={def.local ? t('simple.ai.provider.addressLocal') : t('simple.ai.provider.addressHint')} error={check && !check.ok ? t(URL_PROBLEM[check.code]) /* i18n-technical: keys in URL_PROBLEM */ : undefined}>
            <TextInput className="num" value={url} disabled={disabled} onChange={(e) => setUrl(e.target.value)} data-testid="simple-ai-provider-url" />
          </Field>
        </div>
      )}
      {preset === 'custom' && (
        <fieldset className="mt-3 flex flex-col gap-2">
          <legend className="mb-1 text-small text-muted">{t('simple.ai.provider.can')}</legend>
          {AI_CAPABILITY_KEYS.map((k) => (
            <Checkbox key={k} label={t(CAP_TEXT[k]) /* i18n-technical: keys in CAP_TEXT */} checked={caps[k]} disabled={disabled} onChange={(v) => setCaps((c) => ({ ...c, [k]: v }))} testId={`simple-ai-cap-${k}`} />
          ))}
        </fieldset>
      )}
      {changed && canEdit && !blocked && (
        <div className="mt-3 flex justify-end">
          <Button variant="primary" disabled={disabled || (check !== null && !check.ok)} loading={saving} onClick={() => void save()} data-testid="simple-ai-provider-save">
            {t('simple.ai.provider.use')}
          </Button>
        </div>
      )}
      {!changed && p.local && <p className="mt-3 text-small text-ink" data-testid="simple-ai-provider-local">{t('simple.ai.provider.local')}</p>}
      {!changed && cannot && (
        <p className="mt-2 text-small text-warning" data-testid="simple-ai-provider-cannot">
          {t('simple.ai.provider.cannot', { service, list: cannot })}
        </p>
      )}
    </section>
  )
}
