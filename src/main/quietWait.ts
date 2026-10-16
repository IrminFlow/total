// Launch to Home: when a deferred main-thread job (the open's backup restore check) may run.
// Pure, so the rule is unit-tested (quietWait.test.ts); ipc.ts feeds it the IPC activity.

export interface QuietWaitInput {
  /** Date.now() at this tick. */
  now: number
  /** When the job was scheduled. */
  scheduledAt: number
  /** IPC calls running right now. */
  inFlight: number
  /** When the last IPC call started or ended. */
  lastActivityAt: number
  /** Run once nothing has happened for this long… */
  quietMs: number
  /** …or this long after scheduling, however busy. */
  latestMs: number
}

/** 0 = run now; otherwise wait this many ms and ask again. */
export function quietWaitMs(i: QuietWaitInput): number {
  if (i.now - i.scheduledAt >= i.latestMs) return 0
  const quietFor = i.now - i.lastActivityAt
  if (i.inFlight === 0 && quietFor >= i.quietMs) return 0
  return Math.max(100, i.quietMs - Math.max(0, quietFor))
}
