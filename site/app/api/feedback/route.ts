import { NextResponse } from 'next/server'
import { deliver } from '@/lib/store'

export const runtime = 'nodejs'

/**
 * Where the app's Support screen posts.
 *
 * The app half of this is elsewhere: it shows the visitor exactly what it is about to send, and
 * sends nothing until they press the button. This half stores the message durably and forwards
 * it so somebody reads it today. See lib/store.ts for the sinks.
 *
 * If no sink is configured the route says so, with a status the app can act on, rather than
 * accepting the message and dropping it. A support form that silently discards a bug report is
 * worse than no support form.
 */

const MAX = 8000

function cors(response: NextResponse): NextResponse {
  // The sender is a desktop application, not a browser on this origin, so there is no useful
  // origin to restrict to. The endpoint accepts a message and returns nothing sensitive.
  response.headers.set('Access-Control-Allow-Origin', '*')
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type')
  response.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  return response
}

export function OPTIONS(): NextResponse {
  return cors(new NextResponse(null, { status: 204 }))
}

export async function POST(request: Request): Promise<NextResponse> {
  let body: { message?: string; email?: string; version?: string; platform?: string; log?: string }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return cors(NextResponse.json({ ok: false, error: 'Malformed request.' }, { status: 400 }))
  }

  const message = String(body.message ?? '').trim().slice(0, MAX)
  if (message.length < 5) {
    return cors(NextResponse.json({ ok: false, error: 'Tell us what happened.' }, { status: 400 }))
  }

  const email = String(body.email ?? '').trim().slice(0, 200)
  const version = String(body.version ?? '').trim().slice(0, 40)
  const platform = String(body.platform ?? '').trim().slice(0, 80)
  const log = String(body.log ?? '').trim().slice(0, MAX)

  const first = message.split('\n')[0].slice(0, 70)
  const result = await deliver({
    title: `Feedback: ${first}`,
    labels: ['feedback'],
    body: [
      message,
      '',
      '---',
      `Version: ${version || 'not given'}`,
      `Platform: ${platform || 'not given'}`,
      `Reply to: ${email || 'no address given'}`,
      log ? `\nRecent log:\n\n\`\`\`\n${log}\n\`\`\`` : ''
    ].join('\n')
  })

  if (!result.configured) {
    return cors(
      NextResponse.json(
        { ok: false, error: 'Feedback is not wired up on this site yet. Please send it by email instead.' },
        { status: 503 }
      )
    )
  }
  if (!result.stored && !result.forwarded) {
    return cors(
      NextResponse.json(
        { ok: false, error: 'That did not reach us. Please try again, or send it by email.' },
        { status: 502 }
      )
    )
  }

  return cors(NextResponse.json({ ok: true, stored: result.stored, forwarded: result.forwarded }))
}
