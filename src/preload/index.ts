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
  }
}

contextBridge.exposeInMainWorld('total', api)

export type TotalBridge = typeof api
