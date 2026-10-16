import { contextBridge, ipcRenderer } from 'electron'

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
  /** WP 8.5 structured error fields (see src/shared/errors): code, field path, params, issues. */
  code?: string
  field?: string
  params?: Record<string, string | number>
  issues?: { code: string; field?: string; line?: number; params?: Record<string, string | number>; message?: string }[]
}

/** Scripted runs only: the shifted day main accepted (main/e2eClock.ts), else null. */
const e2eToday = process.argv.find((a) => a.startsWith('--total-e2e-today='))?.slice('--total-e2e-today='.length) ?? null

const api = {
  platform: process.platform,
  e2eToday,
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
  },
  /** WP 7.2: main locked the session (⌘L elsewhere, or the idle auto-lock). Returns an unsubscribe. */
  onSessionLocked: (listener: (event: { reason: 'manual' | 'idle'; kind?: 'pin' | 'passphrase' | 'privacy' }) => void): (() => void) => {
    const wrapped = (_e: unknown, event: { reason: 'manual' | 'idle'; kind?: 'pin' | 'passphrase' | 'privacy' }): void => listener(event)
    ipcRenderer.on('total:session:locked', wrapped)
    return () => {
      ipcRenderer.removeListener('total:session:locked', wrapped)
    }
  },
  /** Update notices (available / downloading / ready, or null), pushed by main. Returns an unsubscribe. */
  onUpdateEvent: (listener: (notice: unknown) => void): (() => void) => {
    const wrapped = (_e: unknown, notice: unknown): void => listener(notice)
    ipcRenderer.on('total:updates:event', wrapped)
    return () => {
      ipcRenderer.removeListener('total:updates:event', wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('total', api)

export type TotalBridge = typeof api
