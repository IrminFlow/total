import { contextBridge, ipcRenderer } from 'electron'

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

const api = {
  platform: process.platform,
  invoke: (channel: string, payload?: unknown): Promise<IpcResult> => {
    if (!/^[a-zA-Z0-9:._-]+$/.test(channel)) {
      return Promise.resolve({ ok: false, error: 'Bad channel' })
    }
    return ipcRenderer.invoke(`total:${channel}`, payload) as Promise<IpcResult>
  },
  /** AI agent events (WP 5.1), pushed by main while an answer streams. Returns an unsubscribe. */
  onAiEvent: (listener: (event: unknown) => void): (() => void) => {
    const wrapped = (_e: unknown, event: unknown): void => listener(event)
    ipcRenderer.on('total:ai:event', wrapped)
    return () => {
      ipcRenderer.removeListener('total:ai:event', wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('total', api)

export type TotalBridge = typeof api
