import type { EvalCase } from './types'

/** `--case` filters: exact ids, or prefixes ending in "*" ("acc.*"); `--sample n` keeps n cases
 *  spread evenly over the catalogue (deterministic). */
export function selectCases(all: readonly EvalCase[], filters: readonly string[] = [], sample = 0): EvalCase[] {
  let out = filters.length
    ? all.filter((c) => filters.some((f) => (f.endsWith('*') ? c.id.startsWith(f.slice(0, -1)) : c.id === f)))
    : [...all]
  if (sample > 0 && sample < out.length) {
    const step = out.length / sample
    out = Array.from({ length: sample }, (_, i) => out[Math.floor(i * step)]!)
  }
  return out
}
