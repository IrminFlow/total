/**
 * Frames streamed from main to the renderer during an assistant run.
 *
 * A discriminated union rather than loose events: the renderer's reducer is exhaustive over `t`,
 * so adding a frame kind is a compile error at every consumer rather than a silently ignored
 * message.
 *
 * `seq` is monotonic per run. IPC preserves order today, so nothing depends on it — but a frame
 * arriving out of order would corrupt an answer mid-sentence, and dropping it is cheaper than
 * discovering that later over a different transport.
 */

import type { DraftIssue, VoucherDraftProposal } from './draft'

export type AiFinish = 'stop' | 'length' | 'cancelled' | 'cap' | 'error'

export type AiFrame =
  | { t: 'start'; runId: string; seq: number; model: string; host: string; local: boolean }
  | { t: 'delta'; runId: string; seq: number; text: string }
  | { t: 'tool_call'; runId: string; seq: number; name: string; args: unknown }
  | { t: 'tool_result'; runId: string; seq: number; name: string; result: unknown }
  | { t: 'usage'; runId: string; seq: number; promptTokens: number; completionTokens: number }
  /**
   * A proposed voucher. Its own frame rather than a tool_result the renderer digs through,
   * because the drawer renders it as a card with a button, and the type is what guarantees the
   * button is wired to a draft the same code validated.
   */
  | {
      t: 'draft'
      runId: string
      seq: number
      draft: VoucherDraftProposal
      summary: string
      openable: boolean
      issues: DraftIssue[]
    }
  /** Running cost, after each exchange. Zero throughout on a local endpoint. */
  | {
      t: 'spend'
      runId: string
      seq: number
      runPaise: number
      sessionPaise: number
      todayPaise: number
      /** False when the model was not in the price table and a fallback rate was used. */
      priced: boolean
    }
  | { t: 'done'; runId: string; seq: number; finish: AiFinish }
  | { t: 'error'; runId: string; seq: number; kind: string; message: string }

/**
 * A frame without the fields the runner stamps on.
 *
 * Distributive on purpose: a plain `Omit<AiFrame, 'runId' | 'seq'>` over a union collapses to
 * the keys every member shares, which is none of the interesting ones.
 */
export type AiFramePayload = AiFrame extends infer F ? (F extends AiFrame ? Omit<F, 'runId' | 'seq'> : never) : never

export function isAiFrame(value: unknown): value is AiFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string' &&
    typeof (value as { runId?: unknown }).runId === 'string' &&
    typeof (value as { seq?: unknown }).seq === 'number'
  )
}

/**
 * Coalesces text deltas.
 *
 * One IPC message per token is 1,500 structured-clone round trips through the same thread that
 * serves every SQLite query, which is felt as a stuttering UI during an answer. Buffering to a
 * short interval or a character budget makes it a few dozen. Non-delta frames flush first so
 * ordering between text and tool calls is never scrambled.
 */
export class DeltaCoalescer {
  private buffer = ''
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly emit: (text: string) => void,
    private readonly intervalMs = 50,
    private readonly charCap = 400
  ) {}

  push(text: string): void {
    this.buffer += text
    if (this.buffer.length >= this.charCap) {
      this.flush()
      return
    }
    if (this.timer === null) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs)
    }
  }

  flush(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.buffer === '') return
    const text = this.buffer
    this.buffer = ''
    this.emit(text)
  }

  dispose(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    this.buffer = ''
  }
}
