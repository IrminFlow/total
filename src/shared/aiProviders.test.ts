// Phase 3a: the provider presets, the base-URL rule, reading a stored choice (anything unreadable
// = OpenAI as before), capability refusals in plain words and the model pick on non-OpenAI lists.
import { describe, expect, it } from 'vitest'
import {
  AI_PRESETS, AI_PRESET_IDS, DEFAULT_AI_PROVIDER, aiProviderSetSchema, capabilityRefusal, checkBaseUrl, pickModels, presetHeadersSecret, presetKeySecret, providerViewOf,
  readAiProviderSettings, resolveAiProvider
} from './aiProviders'

describe('presets', () => {
  it('no stored choice = OpenAI through the Responses API, every capability, the key it always had', () => {
    expect(readAiProviderSettings(undefined)).toEqual(DEFAULT_AI_PROVIDER)
    const r = resolveAiProvider(DEFAULT_AI_PROVIDER, { openai: 'https://api.openai.com/v1' })
    expect(r).toMatchObject({ preset: 'openai', api: 'responses', baseUrl: 'https://api.openai.com/v1', needsKey: true, local: false, urlProblem: null })
    expect(r.caps).toEqual({ tools: true, structured: true, images: true, files: true })
    expect(presetKeySecret('openai')).toBe('openai_api_key')
  })

  it('every other preset speaks Chat Completions; local ones need no key and default to localhost', () => {
    for (const id of AI_PRESET_IDS.filter((p) => p !== 'openai')) expect(AI_PRESETS[id].api).toBe('chat')
    expect(AI_PRESETS.ollama).toMatchObject({ local: true, needsKey: false, baseUrl: 'http://localhost:11434/v1' })
    expect(AI_PRESETS.lmstudio).toMatchObject({ local: true, needsKey: false, baseUrl: 'http://localhost:1234/v1' })
    expect(resolveAiProvider({ preset: 'ollama', baseUrl: null, caps: null })).toMatchObject({ baseUrl: 'http://localhost:11434/v1', urlProblem: null })
    // Keys and headers are kept per preset.
    expect(new Set(AI_PRESET_IDS.map(presetKeySecret)).size).toBe(AI_PRESET_IDS.length)
    expect(presetHeadersSecret('custom')).toBe('ai_headers:custom')
  })

  it('shared code carries no hosted API address (it would land in the renderer bundle)', () => {
    for (const id of AI_PRESET_IDS) if (!AI_PRESETS[id].editableUrl) expect(AI_PRESETS[id].baseUrl).toBe('')
    expect(JSON.stringify(AI_PRESETS)).not.toContain('api.openai.com')
  })

  it('a custom service has no address until one is typed, and its own capability list', () => {
    expect(resolveAiProvider({ preset: 'custom', baseUrl: null, caps: null }).urlProblem).toMatch(/Type the address/)
    const caps = { tools: false, structured: true, images: false, files: false }
    expect(resolveAiProvider({ preset: 'custom', baseUrl: 'https://llm.example.com/v1', caps }).caps).toEqual(caps)
    // only custom takes declared caps
    expect(resolveAiProvider({ preset: 'groq', baseUrl: null, caps }).caps).toEqual(AI_PRESETS.groq.caps)
  })

  it('garbage in the settings file reads as the default', () => {
    expect(readAiProviderSettings({ preset: 'skynet', baseUrl: null, caps: null })).toEqual(DEFAULT_AI_PROVIDER)
    expect(readAiProviderSettings('ollama')).toEqual(DEFAULT_AI_PROVIDER)
    expect(readAiProviderSettings({ preset: 'ollama', baseUrl: 'http://localhost:9999/v1', caps: null })).toEqual({ preset: 'ollama', baseUrl: 'http://localhost:9999/v1', caps: null })
  })

  it('a stored local address that is not on this computer is a problem, never used', () => {
    const r = resolveAiProvider({ preset: 'ollama', baseUrl: 'http://10.0.0.5:11434/v1', caps: null })
    expect(r.urlProblem).toMatch(/localhost/)
    expect(r.baseUrl).toBe('http://localhost:11434/v1')
  })

  it('providerViewOf builds a renderer view without secrets', () => {
    expect(providerViewOf()).toMatchObject({ preset: 'openai', label: 'OpenAI', keyPresent: false, headerNames: [] })
  })
})

describe('checkBaseUrl', () => {
  it('local presets: localhost / 127.0.0.1 / ::1 only', () => {
    expect(checkBaseUrl('ollama', 'http://localhost:11434/v1/')).toEqual({ ok: true, url: 'http://localhost:11434/v1', origin: 'http://localhost:11434' })
    expect(checkBaseUrl('lmstudio', 'http://127.0.0.1:1234/v1')).toMatchObject({ ok: true, url: 'http://127.0.0.1:1234/v1' })
    expect(checkBaseUrl('ollama', 'http://[::1]:11434/v1')).toMatchObject({ ok: true })
    expect(checkBaseUrl('ollama', 'http://192.168.1.20:11434/v1')).toMatchObject({ ok: false, code: 'notLocal' })
    expect(checkBaseUrl('ollama', 'https://ollama.example.com/v1')).toMatchObject({ ok: false })
    expect(checkBaseUrl('lmstudio', 'http://localhost.evil.com/v1')).toMatchObject({ ok: false })
  })

  it('custom: https anywhere, http only on this computer; no credentials, query or other schemes', () => {
    expect(checkBaseUrl('custom', 'https://llm.example.com/v1')).toMatchObject({ ok: true, url: 'https://llm.example.com/v1', origin: 'https://llm.example.com' })
    expect(checkBaseUrl('custom', 'http://localhost:8080/v1')).toMatchObject({ ok: true })
    expect(checkBaseUrl('custom', 'http://llm.example.com/v1')).toMatchObject({ ok: false, code: 'notHttps', error: expect.stringMatching(/https/) })
    expect(checkBaseUrl('custom', 'https://user:pw@llm.example.com/v1')).toMatchObject({ ok: false })
    expect(checkBaseUrl('custom', 'https://llm.example.com/v1?key=1')).toMatchObject({ ok: false })
    expect(checkBaseUrl('custom', 'file:///etc/passwd')).toMatchObject({ ok: false })
    expect(checkBaseUrl('custom', '')).toMatchObject({ ok: false })
    expect(checkBaseUrl('custom', 'not a url')).toMatchObject({ ok: false })
  })
})

describe('aiProviderSetSchema', () => {
  it('takes a preset, an address, caps and headers; refuses reserved header names', () => {
    expect(aiProviderSetSchema.parse({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1' })).toMatchObject({ preset: 'ollama', confirmNoUsers: false })
    expect(() => aiProviderSetSchema.parse({ preset: 'custom', headers: [{ name: 'Authorization', value: 'x' }] })).toThrow()
    expect(() => aiProviderSetSchema.parse({ preset: 'custom', headers: [{ name: 'bad name', value: 'x' }] })).toThrow()
    expect(() => aiProviderSetSchema.parse({ preset: 'nope' })).toThrow()
    expect(() => aiProviderSetSchema.parse({ preset: 'openai', extra: 1 })).toThrow()
    expect(aiProviderSetSchema.parse({ preset: 'custom', baseUrl: 'https://x.example/v1', headers: [{ name: 'X-Api-Key', value: 'abc' }] }).headers).toEqual([{ name: 'X-Api-Key', value: 'abc' }])
  })
})

describe('capabilityRefusal', () => {
  it('reads "not supported" errors from compatible servers', () => {
    expect(capabilityRefusal('registry.ollama.ai/library/gemma:2b does not support tools')).toBe('tools')
    expect(capabilityRefusal('400 Invalid content type. image_url is only supported by certain models')).toBe('images')
    expect(capabilityRefusal('This model does not support image input')).toBe('images')
    expect(capabilityRefusal("response_format json_schema is not supported by this model")).toBe('structured')
    expect(capabilityRefusal('file inputs are not supported')).toBe('files')
    expect(capabilityRefusal('Incorrect API key provided')).toBeNull()
    // A bare "invalid" is another failure, said as it is (review of #210).
    expect(capabilityRefusal("Invalid schema for response_format 'bill': missing required")).toBeNull()
    expect(capabilityRefusal('Invalid image: could not process the file')).toBeNull()
    expect(capabilityRefusal("Invalid 'tools[3].function.name': string too long")).toBeNull()
    expect(capabilityRefusal('The model `x` does not exist')).toBeNull()
  })
})

describe('pickModels on any endpoint', () => {
  it('OpenRouter ids (vendor/model): the newest GPT, a small one for fast', () => {
    const ids = ['openai/gpt-4o', 'openai/gpt-5', 'openai/gpt-5-mini', 'meta-llama/llama-3.3-70b-instruct', 'openai/text-embedding-3-small']
    expect(pickModels(ids, { defaultModel: '', fastModel: '' })).toEqual({ defaultModel: 'openai/gpt-5', fastModel: 'openai/gpt-5-mini', changed: true, found: true })
  })

  it('Groq / Ollama ids: never an embedding or guard model; the 8b one is the fast one', () => {
    const groq = ['llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'llama-guard-4-12b', 'whisper-large-v3']
    expect(pickModels(groq, { defaultModel: '', fastModel: '' })).toMatchObject({ defaultModel: 'llama-3.3-70b-versatile', fastModel: 'llama-3.1-8b-instant', found: true })
    const ollama = ['nomic-embed-text:latest', 'qwen2.5:14b']
    expect(pickModels(ollama, { defaultModel: '', fastModel: '' })).toMatchObject({ defaultModel: 'qwen2.5:14b', fastModel: 'qwen2.5:14b', found: true })
  })

  it('Gemini: "gemini" is not a mini; previews, aqa, imagen and embeddings never win; gemma is another family', () => {
    const ids = ['models/gemini-2.5-pro', 'models/gemini-2.5-flash', 'models/gemini-2.5-flash-lite', 'models/gemini-1.5-pro', 'models/gemini-2.0-flash', 'models/aqa', 'models/text-embedding-004', 'models/gemini-3-pro-preview', 'models/gemma-3-27b-it', 'models/imagen-3.0-generate-002']
    expect(pickModels(ids, { defaultModel: '', fastModel: '' })).toMatchObject({ defaultModel: 'models/gemini-2.5-pro', fastModel: 'models/gemini-2.5-flash', found: true })
  })

  it('Groq: a compound system or alphabetical first never wins', () => {
    const ids = ['compound-beta', 'llama-3.1-8b-instant', 'llama-3.3-70b-versatile', 'whisper-large-v3']
    expect(pickModels(ids, { defaultModel: '', fastModel: '' })).toMatchObject({ defaultModel: 'llama-3.3-70b-versatile', fastModel: 'llama-3.1-8b-instant' })
  })

  it('keeps a model the list offers; an empty list keeps whatever is set (the user types one)', () => {
    expect(pickModels(['a', 'b'], { defaultModel: 'b', fastModel: 'a' })).toMatchObject({ defaultModel: 'b', fastModel: 'a', changed: false })
    expect(pickModels([], { defaultModel: '', fastModel: '' })).toEqual({ defaultModel: '', fastModel: '', changed: false, found: false })
  })
})
