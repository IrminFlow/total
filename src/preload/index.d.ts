export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

declare global {
  interface Window {
    total: {
      platform: string
      invoke: (channel: string, payload?: unknown) => Promise<IpcResult>
      /** AI agent events (WP 5.1) — the payload is an AiEvent (src/shared/ai.ts). Returns an unsubscribe. */
      onAiEvent?: (listener: (event: unknown) => void) => () => void
    }
  }
}

export {}
