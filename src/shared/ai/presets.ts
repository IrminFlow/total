/**
 * Endpoint presets, local ones first.
 *
 * The assistant's best configuration for a Total user is a model running on their own laptop:
 * no key, no bill, no books leaving the machine, and the app's central promise intact. That
 * configuration is also the one people fail to reach, because it means knowing that Ollama
 * listens on 11434 and speaks an OpenAI-shaped API at `/v1`, and that LM Studio uses 1234 and
 * ignores the key entirely.
 *
 * So the presets are not a convenience — they are the difference between "bring your own key"
 * and "runs offline like the rest of the app". The remote presets exist for symmetry and to
 * spell out that those DO send the books somewhere else.
 */

export interface EndpointPreset {
  id: string
  label: string
  baseUrl: string
  /** A model these tools ship or fetch by default. The user can change it; this is a start. */
  model: string
  /** False for local servers, which accept and ignore any key. */
  needsKey: boolean
  local: boolean
  /** One line under the button: what to do before this will work. */
  hint: string
}

export const ENDPOINT_PRESETS: EndpointPreset[] = [
  {
    id: 'ollama',
    label: 'Ollama (this machine)',
    // 127.0.0.1 rather than localhost: on a machine where localhost resolves to ::1 first, and
    // Ollama binds v4 only, "localhost" fails with a connection-refused that looks like Ollama
    // is not running when it is.
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false,
    local: true,
    hint: 'Install Ollama, then run: ollama pull qwen2.5:7b. Nothing leaves this machine.'
  },
  {
    id: 'lmstudio',
    label: 'LM Studio (this machine)',
    baseUrl: 'http://127.0.0.1:1234/v1',
    model: 'local-model',
    needsKey: false,
    local: true,
    hint: 'In LM Studio, load a model and start the local server. Nothing leaves this machine.'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true,
    local: false,
    hint: 'Sends your question and the rows the tools return to OpenAI. Needs an API key.'
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'openai/gpt-4o-mini',
    needsKey: true,
    local: false,
    hint: 'Sends your question and the rows the tools return to OpenRouter. Needs an API key.'
  }
]

export function presetById(id: string): EndpointPreset | undefined {
  return ENDPOINT_PRESETS.find((p) => p.id === id)
}

/**
 * The settings patch a preset applies.
 *
 * Consent is deliberately part of it. Picking a local preset consents to a host that is this
 * machine, which is no disclosure at all; picking a remote one clears `consentedHost`, so the
 * settings form re-arms its "you are about to send your books to X" prompt rather than
 * inheriting an agreement the user gave about a different company's endpoint.
 */
export function applyPreset(preset: EndpointPreset): {
  baseUrl: string
  model: string
  consentedHost: string
} {
  return {
    baseUrl: preset.baseUrl,
    model: preset.model,
    consentedHost: preset.local ? new URL(preset.baseUrl).host : ''
  }
}

/** The preset a configuration currently matches, if any — used to light up the button. */
export function matchPreset(baseUrl: string): EndpointPreset | undefined {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return ENDPOINT_PRESETS.find((p) => p.baseUrl.replace(/\/+$/, '') === trimmed)
}
