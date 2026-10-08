// The chat panel's state, built from stored messages plus the streamed AiEvents (WP 5.1). Pure —
// tested in __tests__/aiPanel.test.tsx.
import type { AiDraftDto, AiEvent, AiMessageDto } from '@shared/ai'

export interface PendingTool {
  callId: string
  name: string
  input: unknown
}

export interface AiPanelState {
  threadId: number | null
  /** A question was sent with no thread yet — adopt the thread the next run-start names. */
  awaitingThread: boolean
  messages: AiMessageDto[]
  /** Text streamed for the step in progress (cleared when its message is stored). */
  streaming: string
  running: boolean
  runId: string | null
  pendingTools: PendingTool[]
  drafts: Record<number, AiDraftDto>
  error: string | null
}

export const emptyPanel = (threadId: number | null = null): AiPanelState => ({
  threadId,
  awaitingThread: false,
  messages: [],
  streaming: '',
  running: false,
  runId: null,
  pendingTools: [],
  drafts: {},
  error: null
})

export function loadThread(threadId: number, messages: AiMessageDto[], running: boolean): AiPanelState {
  return { ...emptyPanel(threadId), messages, running }
}

const addMessage = (list: AiMessageDto[], m: AiMessageDto): AiMessageDto[] =>
  list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : [...list, m].sort((a, b) => a.id - b.id)

export function applyAiEvent(state: AiPanelState, e: AiEvent): AiPanelState {
  if (e.type === 'run-start') {
    if (state.threadId !== e.threadId && !(state.threadId === null && state.awaitingThread)) return state
    return {
      ...state,
      threadId: e.threadId,
      awaitingThread: false,
      messages: addMessage(state.messages, e.userMessage),
      running: true,
      runId: e.runId,
      streaming: '',
      pendingTools: [],
      error: null
    }
  }
  if (e.threadId !== state.threadId) return state
  switch (e.type) {
    case 'delta':
      return { ...state, streaming: state.streaming + e.text }
    case 'tool-start':
      return { ...state, pendingTools: [...state.pendingTools.filter((t) => t.callId !== e.callId), { callId: e.callId, name: e.name, input: e.input }] }
    case 'message': {
      const m = e.message
      return {
        ...state,
        messages: addMessage(state.messages, m),
        streaming: m.role === 'assistant' ? '' : state.streaming,
        pendingTools: m.role === 'tool' ? state.pendingTools.filter((t) => t.callId !== m.toolCallId) : state.pendingTools
      }
    }
    case 'draft':
      return { ...state, drafts: { ...state.drafts, [e.draft.id]: e.draft } }
    case 'done':
      return { ...state, running: false, streaming: '', pendingTools: [], runId: null }
    case 'cancelled':
      return { ...state, running: false, streaming: '', pendingTools: [], runId: null }
    case 'error':
      return { ...state, running: false, streaming: '', pendingTools: [], runId: null, error: e.error }
    default:
      return state
  }
}

/** The tool result message answering a call, if stored yet. */
export function resultFor(messages: readonly AiMessageDto[], callId: string): AiMessageDto | undefined {
  return messages.find((m) => m.role === 'tool' && m.toolCallId === callId)
}

/** A user's question and everything the assistant did for it — for the per-answer cost line. */
export function turnCost(messages: readonly AiMessageDto[], finalId: number): { cost: number | null; input: number; output: number } {
  const at = messages.findIndex((m) => m.id === finalId)
  let start = at
  while (start > 0 && messages[start - 1]!.role !== 'user') start--
  let cost: number | null = null
  let input = 0
  let output = 0
  for (const m of messages.slice(start, at + 1)) {
    if (m.role !== 'assistant') continue
    input += m.inputTokens ?? 0
    output += m.outputTokens ?? 0
    if (m.costMicroUsd != null) cost = (cost ?? 0) + m.costMicroUsd
  }
  return { cost, input, output }
}
