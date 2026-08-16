import { create } from 'zustand'

/**
 * In-app replacements for window.confirm / window.prompt. Call `confirmDialog(...)` /
 * `promptDialog(...)` from any handler; the request queues in this store and DialogHost
 * (components/dialogs.tsx, mounted once in App) renders it as a proper Modal. The returned
 * promise resolves with the user's answer.
 */

export interface ConfirmOptions {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive. */
  danger?: boolean
}

export interface PromptOptions {
  title: string
  message?: string
  initial?: string
  placeholder?: string
  confirmLabel?: string
}

export type DialogRequest =
  | (ConfirmOptions & { kind: 'confirm'; id: number; resolve: (ok: boolean) => void })
  | (PromptOptions & { kind: 'prompt'; id: number; resolve: (value: string | null) => void })

interface DialogState {
  queue: DialogRequest[]
  push: (r: DialogRequest) => void
  /** Resolve + remove the frontmost dialog. */
  settle: (id: number, answer: boolean | string | null) => void
}

let dialogSeq = 0

export const useDialogs = create<DialogState>((set, get) => ({
  queue: [],
  push: (r) => set((s) => ({ queue: [...s.queue, r] })),
  settle: (id, answer) => {
    const req = get().queue.find((r) => r.id === id)
    if (!req) return
    set((s) => ({ queue: s.queue.filter((r) => r.id !== id) }))
    if (req.kind === 'confirm') req.resolve(answer === true)
    else req.resolve(typeof answer === 'string' ? answer : null)
  }
}))

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    useDialogs.getState().push({ kind: 'confirm', id: ++dialogSeq, resolve, ...opts })
  })
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    useDialogs.getState().push({ kind: 'prompt', id: ++dialogSeq, resolve, ...opts })
  })
}
