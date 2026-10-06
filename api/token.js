import { randomBytes } from 'node:crypto'
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol'
import { AccessToken } from 'livekit-server-sdk'

const DEFAULT_AGENT_NAME = 'nadia-seller'
const DEFAULT_ROOM_PREFIX = 'nadia-live-seller'

function cleanSlug(value, fallback) {
  if (typeof value !== 'string') return fallback
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug || fallback
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST')
    return response.status(405).json({ error: 'Method not allowed' })
  }

  const livekitUrl = process.env.LIVEKIT_URL
  const apiKey = process.env.LIVEKIT_API_KEY
  const apiSecret = process.env.LIVEKIT_API_SECRET
  const agentName = process.env.LIVEKIT_AGENT_NAME || DEFAULT_AGENT_NAME

  if (!livekitUrl || !apiKey || !apiSecret) {
    return response.status(500).json({
      error: 'Server is missing LIVEKIT_URL, LIVEKIT_API_KEY, or LIVEKIT_API_SECRET',
    })
  }

  let body = {}
  if (request.body && typeof request.body === 'object') {
    body = request.body
  } else if (typeof request.body === 'string') {
    try {
      body = JSON.parse(request.body)
    } catch {
      return response.status(400).json({ error: 'Invalid JSON body' })
    }
  }

  const prefix = cleanSlug(body.room, DEFAULT_ROOM_PREFIX)
  const room = `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`
  const identity = cleanSlug(
    body.identity,
    `browser-${randomBytes(4).toString('hex')}`,
  )

  try {
    const token = new AccessToken(apiKey, apiSecret, {
      identity,
      name: identity,
      ttl: '1h',
    })

    token.addGrant({
      roomJoin: true,
      room,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })

    token.roomConfig = new RoomConfiguration({
      agents: [
        new RoomAgentDispatch({
          agentName,
          metadata: JSON.stringify({ seller: 'Nadia', source: 'spatiuslive-vercel' }),
        }),
      ],
    })

    return response.status(200).json({
      token: await token.toJwt(),
      url: livekitUrl,
      room,
      identity,
    })
  } catch (error) {
    console.error('token generation failed', error)
    return response.status(500).json({ error: 'Unable to create LiveKit session' })
  }
}
