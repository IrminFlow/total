import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * Channels main is allowed to PUSH to the renderer.
 *
 * Deliberately an explicit set rather than the pattern `invoke` uses: a one-way main -> renderer
 * pipe is a bigger surface than request/response, so it opens one channel at a time rather than
 * anything matching a regex.
 */
const EVENT_CHANNELS = new Set(['menu:command', 'ai:stream'])

const api = {
  platform: process.platform,
  invoke: (channel: string, payload?: unknown): Promise<IpcResult> => {
    if (!/^[a-zA-Z0-9:._-]+$/.test(channel)) {
      return Promise.resolve({ ok: false, error: 'Bad channel' })
    }
    return ipcRenderer.invoke(`total:${channel}`, payload) as Promise<IpcResult>
  },
  /**
   * Subscribe to a main-process event. Returns its own unsubscriber so the renderer never needs
   * a handle on `ipcRenderer`. The `IpcRendererEvent` is stripped before the payload reaches the
   * listener — it carries `sender`, which is a way back into main that the renderer has no
   * business holding.
   */
  on: (channel: string, listener: (payload: unknown) => void): (() => void) => {
    if (!EVENT_CHANNELS.has(channel)) return () => {}
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(`total:${channel}`, wrapped)
    return () => {
      ipcRenderer.removeListener(`total:${channel}`, wrapped)
    }
  }
}

contextBridge.exposeInMainWorld('total', api)

export type TotalBridge = typeof api
