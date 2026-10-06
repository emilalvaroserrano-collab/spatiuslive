import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Headless debug: the page has no console UI, so the browser reports
// failures here where they land in the server log.
export async function POST(req: Request) {
  try {
    const body = await req.json()
    console.error('[client]', String(body?.where || 'unknown'), '—', String(body?.message || '').slice(0, 500))
  } catch {
    console.error('[client] unreadable report')
  }
  return NextResponse.json({ ok: true })
}
