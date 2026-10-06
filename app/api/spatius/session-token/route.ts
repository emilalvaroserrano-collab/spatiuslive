import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function extractToken(data: any): string | undefined {
  for (const key of ['sessionKey', 'sessionToken', 'token']) {
    if (typeof data?.[key] === 'string' && data[key]) return data[key]
    if (typeof data?.data?.[key] === 'string' && data.data[key]) return data.data[key]
  }
}

export async function POST() {
  const apiKey = process.env.SPATIUS_API_KEY
  if (!apiKey) return NextResponse.json({ error: 'Missing SPATIUS_API_KEY' }, { status: 500 })

  const ttlMinutes = Number(process.env.SPATIUS_SESSION_TTL_MINUTES || 55)
  const expireAt = Math.floor(Date.now() / 1000) + ttlMinutes * 60
  const configuredRegion = process.env.SPATIUS_REGION || 'auto'
  const tokenRegion = configuredRegion === 'auto' ? 'us-west' : configuredRegion
  // cn-beijing uses a different console domain; other regions follow the
  // console.{region}.spatius.ai pattern.
  const base = (
    process.env.SPATIUS_CONSOLE_ENDPOINT ||
    (tokenRegion === 'cn-beijing'
      ? 'https://console.cn-beijing.spatialwalk.top/v1/console'
      : `https://console.${tokenRegion}.spatius.ai/v1/console`)
  ).replace(/\/$/, '')

  const upstream = await fetch(`${base}/session-tokens`, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ expireAt }),
    cache: 'no-store',
  })

  const text = await upstream.text()
  let payload: any
  try { payload = JSON.parse(text) } catch { payload = { raw: text } }

  if (!upstream.ok || payload?.errors) {
    return NextResponse.json({ error: 'Spatius session token request failed', detail: payload }, { status: 502 })
  }

  const sessionToken = extractToken(payload)
  if (!sessionToken) {
    return NextResponse.json({ error: 'Spatius session token missing', detail: payload }, { status: 502 })
  }

  return NextResponse.json({
    sessionToken,
    expiresAt: new Date(expireAt * 1000).toISOString(),
  })
}
