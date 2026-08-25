/**
 * Sending a support message from inside the app.
 *
 * A `mailto:` link is not a support channel. It needs a configured mail client, it silently does
 * nothing on a machine that has none, and launch week reaches machines nobody has seen. This
 * posts to the site's /api/feedback route instead — the one place in the app, outside the
 * optional AI and NIC clients, that talks to the network at all.
 *
 * Two rules make that acceptable:
 *
 *   * Nothing leaves until the user presses send, and what they press send on is the same string
 *     the dialog printed. The renderer assembles the report, shows it, and hands it back here
 *     verbatim. There is no second, richer payload.
 *   * The log tail is safe to attach by construction, not by filtering: `log()` records channel
 *     names, event names and error messages, never IPC payloads, so no ledger, party or amount
 *     can be in it.
 */
import { app } from 'electron'
import { SITE_URL } from '../../shared/product'
import { log } from '../log'

export type FeedbackInput = {
  message: string
  email: string | null
  /** The diagnostics block, exactly as previewed — or null when the user chose not to attach it. */
  log: string | null
}

/** Ten seconds: long enough for a slow line, short enough that a dead endpoint is not a hang. */
const TIMEOUT_MS = 10_000

/**
 * Where the message goes. `TOTAL_SUPPORT_URL` exists so the E2E scenario can point it at a
 * recording server on localhost and assert what actually left the process — the only honest way
 * to test "nothing but the preview is sent". It is a main-process environment variable, so
 * setting it already requires control of the machine; it grants nothing that was not already had.
 */
function endpoint(): string {
  return process.env.TOTAL_SUPPORT_URL || `${SITE_URL}/api/feedback`
}

export async function sendFeedback(input: FeedbackInput): Promise<{ delivered: true }> {
  const body = {
    message: input.message,
    email: input.email ?? '',
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch} · Electron ${process.versions.electron}`,
    log: input.log ?? ''
  }

  let response: Response
  try {
    response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    // Offline is the expected case for this app, so it gets a sentence rather than a stack.
    log('warn', 'feedback-send-failed', { error: String(err) })
    throw new Error(
      'Could not reach the support server — this needs a connection. You can copy the report and email it instead.'
    )
  }

  if (!response.ok) {
    // The route answers 5xx with a real reason when no sink is configured, rather than accepting
    // a message and dropping it. Pass that reason on instead of inventing one.
    let reason = `The support server answered ${response.status}.`
    try {
      const parsed = (await response.json()) as { error?: string }
      if (parsed.error) reason = parsed.error
    } catch {
      // Not JSON. The status line is all there is.
    }
    log('warn', 'feedback-send-rejected', { status: response.status })
    throw new Error(`${reason} You can copy the report and email it instead.`)
  }

  log('info', 'feedback-sent', { attachedLog: input.log != null })
  return { delivered: true }
}
