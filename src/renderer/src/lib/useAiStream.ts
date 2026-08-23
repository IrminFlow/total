/**
 * Renderer side of an assistant run.
 *
 * Subscribes to the one-way `ai:stream` channel, reduces frames into a conversation, and makes
 * sure a run never outlives the component that started it — an orphaned run on a paid endpoint
 * is the user's money.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './client'
import { isAiFrame, type AiFrame } from '@shared/ai/stream'

export interface ToolTrace {
  name: string
  args?: unknown
  result?: unknown
}

export interface AiTurn {
  role: 'user' | 'assistant'
  content: string
  /** Populated for assistant turns: the tool calls behind the answer, shown as its sources. */
  tools?: ToolTrace[]
  error?: string
}

export interface AiStreamState {
  turns: AiTurn[]
  running: boolean
  usage: { promptTokens: number; completionTokens: number } | null
  endpoint: { host: string; model: string; local: boolean } | null
}

const EMPTY: AiStreamState = { turns: [], running: false, usage: null, endpoint: null }

export function useAiStream(): {
  state: AiStreamState
  ask: (question: string, screen?: string) => Promise<void>
  cancel: () => void
  reset: () => void
} {
  const [state, setState] = useState<AiStreamState>(EMPTY)
  const runIdRef = useRef<string | null>(null)
  const seqRef = useRef(-1)

  const reduce = useCallback((frame: AiFrame) => {
    setState((prev) => {
      const turns = [...prev.turns]
      const last = turns[turns.length - 1]
      const assistant = last?.role === 'assistant' ? { ...last } : null

      switch (frame.t) {
        case 'start':
          return {
            ...prev,
            running: true,
            endpoint: { host: frame.host, model: frame.model, local: frame.local }
          }
        case 'delta':
          if (!assistant) return prev
          assistant.content += frame.text
          turns[turns.length - 1] = assistant
          return { ...prev, turns }
        case 'tool_call':
          if (!assistant) return prev
          assistant.tools = [...(assistant.tools ?? []), { name: frame.name, args: frame.args }]
          turns[turns.length - 1] = assistant
          return { ...prev, turns }
        case 'tool_result': {
          if (!assistant?.tools) return prev
          const tools = [...assistant.tools]
          // Attach to the most recent call of this name that is still awaiting a result.
          for (let i = tools.length - 1; i >= 0; i--) {
            if (tools[i]!.name === frame.name && tools[i]!.result === undefined) {
              tools[i] = { ...tools[i]!, result: frame.result }
              break
            }
          }
          assistant.tools = tools
          turns[turns.length - 1] = assistant
          return { ...prev, turns }
        }
        case 'usage':
          return {
            ...prev,
            usage: { promptTokens: frame.promptTokens, completionTokens: frame.completionTokens }
          }
        case 'error':
          if (!assistant) return { ...prev, running: false }
          assistant.error = frame.message
          turns[turns.length - 1] = assistant
          return { ...prev, turns }
        case 'done':
          return { ...prev, running: false }
      }
    })
  }, [])

  useEffect(() => {
    const off = window.total.on('ai:stream', (payload) => {
      if (!isAiFrame(payload)) return
      if (payload.runId !== runIdRef.current) return
      // IPC preserves order, so this is belt and braces — but a frame applied out of order would
      // corrupt an answer mid-sentence, and dropping it is the cheaper failure.
      if (payload.seq <= seqRef.current) return
      seqRef.current = payload.seq
      reduce(payload)
    })
    return () => {
      off()
      // Unmounting with a run in flight (the drawer closed, the screen changed) must stop the
      // work, not just stop listening to it.
      if (runIdRef.current) void api.ai.cancel(runIdRef.current)
    }
  }, [reduce])

  const ask = useCallback(async (question: string, screen?: string) => {
    // One run per drawer: asking again replaces the previous answer rather than interleaving.
    if (runIdRef.current) await api.ai.cancel(runIdRef.current)

    let history: { role: 'user' | 'assistant'; content: string }[] = []
    setState((prev) => {
      history = prev.turns.filter((t) => !t.error).map((t) => ({ role: t.role, content: t.content }))
      return {
        ...prev,
        running: true,
        turns: [...prev.turns, { role: 'user', content: question }, { role: 'assistant', content: '' }]
      }
    })

    try {
      seqRef.current = -1
      const { runId } = await api.ai.chat({ question, screen, history })
      runIdRef.current = runId
    } catch (err) {
      runIdRef.current = null
      setState((prev) => {
        const turns = [...prev.turns]
        const last = turns[turns.length - 1]
        if (last?.role === 'assistant') turns[turns.length - 1] = { ...last, error: (err as Error).message }
        return { ...prev, turns, running: false }
      })
    }
  }, [])

  const cancel = useCallback(() => {
    if (runIdRef.current) void api.ai.cancel(runIdRef.current)
    runIdRef.current = null
    setState((prev) => ({ ...prev, running: false }))
  }, [])

  const reset = useCallback(() => {
    if (runIdRef.current) void api.ai.cancel(runIdRef.current)
    runIdRef.current = null
    seqRef.current = -1
    setState(EMPTY)
  }, [])

  return { state, ask, cancel, reset }
}
