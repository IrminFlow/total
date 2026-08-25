/**
 * A token bucket for MCP writes.
 *
 * Agent writes already sit behind two independent switches — `--allow-writes` on the command
 * line and Settings → Agent access in the app, either of which alone is enough to stop them. Both
 * are consent controls, and consent is not a rate: a user who legitimately turned writes on has
 * also authorised an agent in a loop to post four thousand vouchers into their books at machine
 * speed. Every one of those is soft-deletable, and every one of them is also a real row in a real
 * trial balance until somebody notices.
 *
 * So the third control is a budget. It is deliberately generous — a genuine backfill of a few
 * dozen vouchers passes without noticing it — and deliberately finite, so a runaway stops in
 * seconds rather than in minutes. The bulk path (the agent inbox, one atomic file drop) is
 * unaffected, which is the right shape: a 200-voucher import should be one reviewed act, not 200
 * unreviewed ones.
 */

export interface RateLimitOptions {
  /** Writes allowed in a burst before the refill rate governs. */
  capacity: number
  /** Tokens added per second. */
  refillPerSecond: number
}

/** 30 in a burst, then one every two seconds: fine for a human-paced agent, fatal to a loop. */
export const MCP_WRITE_LIMIT: RateLimitOptions = { capacity: 30, refillPerSecond: 0.5 }

export interface RateVerdict {
  allowed: boolean
  /** Seconds until the next token, when refused — so the caller can say something useful. */
  retryAfterSeconds: number
  remaining: number
}

/**
 * Token bucket with an injected clock.
 *
 * The clock is a parameter because a rate limiter tested with real time is a test that either
 * sleeps or flakes, and this one needs to assert exactly what happens at the boundary.
 */
export class TokenBucket {
  private tokens: number
  private lastRefill: number

  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number = Date.now
  ) {
    this.tokens = opts.capacity
    this.lastRefill = now()
  }

  private refill(): void {
    const at = this.now()
    const elapsed = Math.max(0, at - this.lastRefill) / 1000
    this.tokens = Math.min(this.opts.capacity, this.tokens + elapsed * this.opts.refillPerSecond)
    this.lastRefill = at
  }

  /** Take one token. Refusal does NOT consume anything — a refused caller retrying must not
   *  push its own recovery further away. */
  take(): RateVerdict {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return { allowed: true, retryAfterSeconds: 0, remaining: Math.floor(this.tokens) }
    }
    const deficit = 1 - this.tokens
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(deficit / this.opts.refillPerSecond),
      remaining: 0
    }
  }
}
