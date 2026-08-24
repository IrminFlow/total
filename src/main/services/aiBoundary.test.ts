import { describe, expect, it } from 'vitest'
import { AI_MAX_RESPONSE_BYTES, AI_TIMEOUT_MS, boundedProviderFetch, normalizeBaseUrl } from './ai'

describe('AI provider boundary', () => {
  it('requires TLS except for exact loopback hosts and rejects URL-embedded secrets', () => {
    expect(normalizeBaseUrl('openai', 'https://ignored.example')).toBeNull()
    expect(normalizeBaseUrl('compatible', 'https://models.example/v1/')).toBe('https://models.example/v1')
    expect(normalizeBaseUrl('compatible', 'http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434/v1')
    expect(() => normalizeBaseUrl('compatible', 'http://models.example/v1')).toThrow(/HTTPS/)
    expect(() => normalizeBaseUrl('compatible', 'https://user:secret@models.example/v1')).toThrow(/credentials/)
    expect(() => normalizeBaseUrl('compatible', 'https://models.example/v1?key=secret')).toThrow(/query or fragment/)
  })

  it('uses a finite timeout and a bounded response body', async () => {
    expect(AI_TIMEOUT_MS).toBe(45_000)
    expect(AI_MAX_RESPONSE_BYTES).toBe(2 * 1024 * 1024)

    const tooLargeByHeader = async (): Promise<Response> => new Response('small', { headers: { 'content-length': String(AI_MAX_RESPONSE_BYTES + 1) } })
    await expect(boundedProviderFetch('https://provider.example', undefined, tooLargeByHeader)).rejects.toThrow(/2 MB/)

    const chunk = new Uint8Array(1024 * 1024 + 1)
    const tooLargeStream = async (): Promise<Response> => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(chunk)
        controller.enqueue(chunk)
        controller.close()
      }
    }))
    await expect(boundedProviderFetch('https://provider.example', undefined, tooLargeStream)).rejects.toThrow(/2 MB/)
  })

  it('preserves a normal provider response for SDK parsing', async () => {
    const fetchImpl = async (): Promise<Response> => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })
    const response = await boundedProviderFetch('https://provider.example', undefined, fetchImpl)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
  })
})
