/**
 * A pocket-sized property tester.
 *
 * Why this exists instead of fast-check: Total is built offline and the repo blocks postinstall
 * scripts, so every dependency is something we carry forever. The part of property testing that
 * earns its keep here is small — a deterministic stream of cases, and a counterexample that can
 * be replayed from a seed printed in the failure. That is this file.
 *
 * Determinism is the point. A property test that explores a different space on every CI run is a
 * flake generator, and a flake fails the run (see docs/contributing.md). So: a fixed default seed,
 * an env override for soak runs, and every reported failure carries the exact seed that produced
 * it.
 */

/**
 * mulberry32 — 32-bit state, one multiply-xor round. Chosen because it is short enough to read
 * and verify by eye; we need reproducible spread, not cryptographic quality.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Mix a run index into a base seed so each case has its own replayable seed. */
export function mixSeed(seed: number, index: number): number {
  let h = (seed ^ Math.imul(index + 1, 0x9e3779b1)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0
  return (h ^ (h >>> 16)) >>> 0
}

/** The generator's source of randomness. Every draw comes from here, so a seed replays a case. */
export class Rng {
  private readonly next01: () => number

  constructor(readonly seed: number) {
    this.next01 = mulberry32(seed)
  }

  /** Float in [0, 1). */
  next(): number {
    return this.next01()
  }

  /** Integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    if (max < min) throw new Error(`Rng.int: empty range ${min}..${max}`)
    return min + Math.floor(this.next01() * (max - min + 1))
  }

  bool(pTrue = 0.5): boolean {
    return this.next01() < pTrue
  }

  pick<T>(xs: readonly T[]): T {
    if (xs.length === 0) throw new Error('Rng.pick: empty array')
    return xs[this.int(0, xs.length - 1)] as T
  }

  /** Fisher-Yates on a copy — generators must never mutate what the caller handed them. */
  shuffle<T>(xs: readonly T[]): T[] {
    const out = xs.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i)
      ;[out[i], out[j]] = [out[j] as T, out[i] as T]
    }
    return out
  }

  /**
   * Split `total` into `parts` positive integers. Money is integer paise, so a partition that
   * loses or invents a paisa would make every "balanced voucher" property meaningless.
   */
  partition(total: number, parts: number): number[] {
    if (parts < 1) throw new Error('Rng.partition: need at least one part')
    if (total < parts) throw new Error(`Rng.partition: cannot split ${total} into ${parts} positive parts`)
    // Pick parts-1 distinct cut points in 1..total-1, then take the gaps.
    const cuts = new Set<number>()
    let guard = 0
    while (cuts.size < parts - 1 && guard++ < 1000) cuts.add(this.int(1, total - 1))
    const sorted = [...cuts].sort((a, b) => a - b)
    const out: number[] = []
    let prev = 0
    for (const c of sorted) {
      out.push(c - prev)
      prev = c
    }
    out.push(total - prev)
    // The guard above can under-fill when total is tiny; pad with 1s taken off the fattest part.
    while (out.length < parts) {
      const fattest = out.indexOf(Math.max(...out))
      out[fattest] = (out[fattest] as number) - 1
      out.push(1)
    }
    return out
  }
}

export type Gen<T> = (rng: Rng) => T

/**
 * A property either returns false or throws (an expect() failure counts) to signal a
 * counterexample. Returning true/undefined means it held.
 */
export type Property<T> = (value: T) => boolean | void

export interface ForAllOptions<T> {
  /** Stated in plain words; shows up at the top of the failure report. */
  name?: string
  /** Smaller candidates to try once a failure is found. Greedy, first-failing-wins. */
  shrink?: (value: T) => T[]
  /** Budget so a badly-behaved shrinker cannot hang the suite. */
  shrinkSteps?: number
}

export class PropertyFailure extends Error {
  constructor(
    message: string,
    readonly seed: number,
    readonly caseSeed: number,
    readonly run: number,
    readonly counterexample: unknown
  ) {
    super(message)
    this.name = 'PropertyFailure'
  }
}

function evaluate<T>(prop: Property<T>, value: T): string | null {
  try {
    return prop(value) === false ? 'property returned false' : null
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

function render(value: unknown): string {
  let text: string
  try {
    text = JSON.stringify(value, (_k, v) => (typeof v === 'function' ? '[fn]' : v), 2) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > 4000 ? `${text.slice(0, 4000)}\n… (truncated)` : text
}

/**
 * Run `prop` over `runs` generated cases. Throws a PropertyFailure naming the seed, the run index
 * and the (shrunken) counterexample, so a red CI line is enough to reproduce it locally.
 */
export function forAll<T>(
  seed: number,
  runs: number,
  gen: Gen<T>,
  prop: Property<T>,
  opts: ForAllOptions<T> = {}
): void {
  const budget = opts.shrinkSteps ?? 300
  for (let i = 0; i < runs; i++) {
    const caseSeed = mixSeed(seed, i)
    const value = gen(new Rng(caseSeed))
    const reason = evaluate(prop, value)
    if (reason === null) continue

    let best = value
    let bestReason = reason
    let steps = 0
    if (opts.shrink) {
      outer: while (steps < budget) {
        for (const candidate of opts.shrink(best)) {
          if (++steps > budget) break outer
          const r = evaluate(prop, candidate)
          if (r !== null) {
            best = candidate
            bestReason = r
            continue outer
          }
        }
        break
      }
    }

    throw new PropertyFailure(
      [
        `Property failed${opts.name ? `: ${opts.name}` : ''}`,
        `  seed ${seed}, run ${i} (case seed ${caseSeed})${opts.shrink ? `, shrunk in ${steps} steps` : ''}`,
        `  reason: ${bestReason}`,
        `  counterexample: ${render(best)}`,
        `  replay: re-run with the same seed, or set the suite's seed env var to ${seed}`
      ].join('\n'),
      seed,
      caseSeed,
      i,
      best
    )
  }
}

/**
 * Fixed seed by default so CI is deterministic; override in a soak run to explore further, e.g.
 * `POSTING_PROP_SEED=$RANDOM npm test`.
 */
export function seedFromEnv(varName: string, fallback: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[varName] : undefined
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? Math.abs(Math.trunc(n)) >>> 0 : fallback
}
