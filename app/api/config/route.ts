import { NextResponse } from 'next/server'

export const runtime = 'nodejs'

export async function GET() {
  const appId = process.env.SPATIUS_APP_ID
  const avatarId = process.env.SPATIUS_AVATAR_ID
  if (!appId || !avatarId) {
    return NextResponse.json({ error: 'Missing SPATIUS_APP_ID or SPATIUS_AVATAR_ID' }, { status: 500 })
  }

  return NextResponse.json({
    spatiusAppId: appId,
    avatarId,
    region: process.env.SPATIUS_REGION || 'auto',
    avatarSampleRate: 24000,
    geminiInputSampleRate: 16000,
    geminiModel: process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live',
    geminiVoice: process.env.GEMINI_VOICE || 'Sulafat',
  })
}
