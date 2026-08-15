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
    }
  }
}

export {}
