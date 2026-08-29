import { NextResponse } from 'next/server'
import { deliver } from '@/lib/store'

export const runtime = 'nodejs'

/**
 * Trial-expiry reminder sign-up.
 *
 * Opt-in in the strict sense. The request is rejected unless `agreed` is literally true, the
 * address is recorded for one message and nothing else, and no address arrives here from the
 * app: Total makes no network call, so the only way we learn an address is that somebody typed
 * it on this page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  let body: { email?: string; agreed?: boolean }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 })
  }

  const email = String(body.email ?? '').trim().slice(0, 200)
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return NextResponse.json({ ok: false, error: 'That email address does not look right.' }, { status: 400 })
  }
  if (body.agreed !== true) {
    return NextResponse.json({ ok: false, error: 'Tick the box and we will send the one reminder.' }, { status: 400 })
  }

  const result = await deliver({
    title: `Trial reminder: ${email}`,
    labels: ['reminder'],
    body: [
      `Address: ${email}`,
      `Asked on: ${new Date().toISOString().slice(0, 10)}`,
      '',
      'Send one message about a week before day thirty, then delete the address.'
    ].join('\n')
  })

  if (!result.configured) {
    return NextResponse.json(
      { ok: false, error: 'Reminders are not wired up on this site yet.' },
      { status: 503 }
    )
  }
  if (!result.stored && !result.forwarded) {
    return NextResponse.json({ ok: false, error: 'That did not save. Try again in a moment.' }, { status: 502 })
  }

  return NextResponse.json({ ok: true })
}
