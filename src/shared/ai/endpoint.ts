/**
 * The parts of the assistant's configuration that carry no zod.
 *
 * Split out of `config.ts` because the Settings screen reads these five, and `config.ts` derives
 * its type and its defaults FROM the schema — so importing it at runtime brings the whole
 * validator into a renderer chunk to describe an object the renderer only reads. Types are free;
 * a schema is not.
 */

export const EGRESS_MODES = ['full', 'names-redacted'] as const
export type EgressMode = (typeof EGRESS_MODES)[number]

/** The mask the renderer sees in place of a stored key, mirroring the NIC credentials pattern. */
export const KEY_MASK = '••••••••'

/**
 * A loopback endpoint means the model runs on this machine: nothing leaves it, and there is no
 * cost. Both the consent copy and the cost display key off this.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host.endsWith('.local')
  } catch {
    return false
  }
}

/** Host shown in consent and error copy. Never the full URL — query strings can carry keys. */
export function endpointHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host
  } catch {
    return baseUrl.slice(0, 60)
  }
}

/** Refuse a plaintext endpoint that is not on this machine. */
export function isInsecureEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).protocol === 'http:' && !isLocalEndpoint(baseUrl)
  } catch {
    return false
  }
}
