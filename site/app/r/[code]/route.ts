import { NextResponse, type NextRequest } from 'next/server'
import { normaliseCode, REF_COOKIE, REF_MAX_AGE } from '@/lib/referral'

/**
 * A referral link. /r/SHARMA10 remembers the code and sends the visitor to the front page.
 *
 * One first-party cookie holding one short string, and that is the entire tracking apparatus.
 * No script, no pixel, no identifier, nothing that survives leaving this site, and no record at
 * all of a visitor who does not buy. See lib/referral.ts.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ code: string }> }
): Promise<NextResponse> {
  const { code } = await context.params
  const clean = normaliseCode(code)
  const response = NextResponse.redirect(new URL(clean ? '/buy' : '/', request.nextUrl.origin))
  if (clean) {
    response.cookies.set(REF_COOKIE, clean, {
      maxAge: REF_MAX_AGE,
      httpOnly: false,
      sameSite: 'lax',
      path: '/',
      secure: true
    })
  }
  return response
}
