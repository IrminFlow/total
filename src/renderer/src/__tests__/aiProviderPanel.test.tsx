// Phase 3a — Settings → AI (accountant): the AI service panel. A hosted preset has a fixed
// address; a custom one takes an address, its abilities and extra headers (a stored header's
// value is never shown — an empty value keeps it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { AiSettingsView } from '@shared/ai'
import { providerViewOf } from '@shared/aiProviders'
import { AiProviderPanel } from '../screens/settings/AiProviderPanel'
import { useSession } from '../state/stores'

const invoke = vi.fn()

function viewWith(provider = providerViewOf()): AiSettingsView {
  return {
    settings: { enabled: true, noticeAcceptedAt: 'x', noticeAcceptedBy: null, noticeVersion: 1, defaultModel: 'm', fastModel: 'm', privacy: { maskIds: true, pseudonymiseParties: false }, prices: {}, maxSteps: 8, useMemory: true },
    provider, keyPresent: false, keyHint: null, secureStorageAvailable: true, mock: false, ready: true, blocker: null
  }
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'ai:key:canSet') return { ok: true, data: { allowed: true, reason: 'ok' } }
    if (channel === 'ai:provider:set') return { ok: true, data: viewWith() }
    return { ok: true, data: null }
  })
  window.total = { platform: 'test', invoke, onAiEvent: () => () => {} } as never
  useSession.setState({ user: { id: 1, name: 'Owner', role: 'owner' } } as never)
})
afterEach(() => cleanup())

const wrap = (view: AiSettingsView): void => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><AiProviderPanel view={view} isOwner /></QueryClientProvider>)
}
const calls = (ch: string): unknown[] => invoke.mock.calls.filter(([c]) => c === ch).map(([, p]) => p)

describe('AI service panel', () => {
  it('a hosted preset: fixed address, its abilities listed; saving sends just the preset', async () => {
    wrap(viewWith())
    const select = screen.getByTestId('input-ai-provider') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'groq' } })
    expect((screen.getByTestId('input-ai-base-url') as HTMLInputElement).disabled).toBe(true)
    expect(screen.getByTestId('ai-provider-caps').textContent).toMatch(/not: reads scanned pdf files/)
    expect(screen.queryByTestId('ai-provider-headers')).toBeNull()
    fireEvent.click(screen.getByTestId('btn-ai-save-provider'))
    await waitFor(() => expect(calls('ai:provider:set')).toEqual([{ preset: 'groq', baseUrl: null, confirmNoUsers: false }]))
  })

  it('custom: address checked, abilities and headers sent; a stored header keeps its value when left empty', async () => {
    wrap(viewWith({ ...providerViewOf({ preset: 'custom', baseUrl: 'https://llm.example.com/v1', caps: null }), headerNames: ['X-Api-Key'] }))
    const url = screen.getByTestId('input-ai-base-url') as HTMLInputElement
    expect(url.value).toBe('https://llm.example.com/v1')
    fireEvent.change(url, { target: { value: 'http://llm.example.com/v1' } })
    expect((screen.getByTestId('btn-ai-save-provider') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(url, { target: { value: 'https://llm.example.com/v2' } })
    fireEvent.click(screen.getByTestId('input-ai-cap-images'))
    expect((screen.getByLabelText('Value of X-Api-Key') as HTMLInputElement).placeholder).toMatch(/saved/)
    fireEvent.click(screen.getByTestId('btn-ai-save-provider'))
    await waitFor(() =>
      expect(calls('ai:provider:set')).toEqual([
        { preset: 'custom', baseUrl: 'https://llm.example.com/v2', caps: { tools: true, structured: true, images: true, files: false }, headers: [{ name: 'X-Api-Key', value: '' }], confirmNoUsers: false }
      ])
    )
  })
})
