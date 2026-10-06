import { ControlEvent, TikTokLiveConnection, WebcastEvent } from 'tiktok-live-connector'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Server-sent events from the TikTok live room, forwarded to the browser so
// Kimmy can react to comments, gifts, follows and live status in real time.
// Configure with TIKTOK_USERNAME (the streamer). Optional TIKTOK_SESSION_ID
// cookie value improves connection reliability.

type FeedEvent =
  | { type: 'chat'; user: string; text: string }
  | { type: 'gift'; user: string; gift: string; count: number }
  | { type: 'follow'; user: string }
  | { type: 'share'; user: string }
  | { type: 'stats'; viewers: number; likes: number }
  | { type: 'liveEnd' }
  | { type: 'error'; message: string }

type Listener = (event: FeedEvent) => void

let conn: TikTokLiveConnection | null = null
let connFor = ''
let connectPromise: Promise<void> | null = null
const listeners = new Set<Listener>()

let viewers = 0
let likes = 0
let statsTimer: ReturnType<typeof setInterval> | null = null
let lastSocialAt = 0
let lastGiftAt = 0
let giftQueue: string[] = []
const GIFT_WINDOW_MS = 120_000

function broadcast(event: FeedEvent) {
  listeners.forEach((fn) => {
    try {
      fn(event)
    } catch {
      // ignore slow/broken listeners
    }
  })
}

function nickOf(user: any): string {
  return String(user?.nickname || user?.uniqueId || 'viewer').slice(0, 40)
}

// TikTok holds LIVE hosts responsible for everything said on stream —
// including comments read aloud by third-party tools. Drop anything unsafe
// before Kimmy can see it: links, phone numbers, emails, sexual content,
// slurs. Mild banter passes; the persona rules handle the rest gracefully.
const UNSAFE_PATTERNS: RegExp[] = [
  /https?:\/\/|www\.|\.\w{2,}\/\S*|t\.me\/\S+|bit\.ly/i,
  /\b[\w.+-]+@[\w-]+\.[\w.]+\b/,
  /(\+?\d[\d\s-]{6,}\d)/,
  /\b(putang\s?ina|putangina|kingina|kinangina|punyeta|leche|tarantado|t*ngina|gago ka|bobo ka|ulol|burat|tite|puke|pekpek|kantot|jakol|salsal|boso|bosoero|porn|xxx|nude|hubad|rape|patayin|papatayin|mamatay ka|suntukan|bugbog|shit|fuck|bitch|slut|whore|nigga|retard|kill yourself|kys)\b/i,
]

function isUnsafeComment(text: string): boolean {
  return UNSAFE_PATTERNS.some((re) => re.test(text))
}

function wireConnection(c: TikTokLiveConnection) {
  c.on(WebcastEvent.CHAT, (msg: any) => {
    const text = String(msg?.comment || '').trim()
    if (!text || isUnsafeComment(text)) return
    broadcast({ type: 'chat', user: nickOf(msg?.user), text: text.slice(0, 200) })
  })

  // Gifts are batched: one thanks per burst, never one per gift, so Kimmy
  // doesn't repeat herself when gifts rain in.
  c.on(WebcastEvent.GIFT, (msg: any) => {
    if (msg?.repeatEnd === false) return // only count the final total
    const who = nickOf(msg?.user)
    const what = String(msg?.extendedGiftInfo?.name || msg?.giftName || 'a gift').slice(0, 60)
    const count = Number(msg?.repeatEnd ? msg?.repeatCount || 1 : 1) || 1
    giftQueue.push(count > 1 ? `@${who} (${what} x${count})` : `@${who} (${what})`)
    const now = Date.now()
    if (now - lastGiftAt < GIFT_WINDOW_MS) return
    lastGiftAt = now
    const batch = giftQueue.splice(0)
    const names = batch.slice(0, 3).join(', ')
    const extra = batch.length > 3 ? ` and ${batch.length - 3} more` : ''
    broadcast({ type: 'gift', user: `${names}${extra}`, gift: 'gifts', count: batch.length })
  })

  // Follows + shares arrive as social events; throttle so Kimmy isn't spammed.
  const social = (type: 'follow' | 'share') => (msg: any) => {
    const now = Date.now()
    if (now - lastSocialAt < 20_000) return
    lastSocialAt = now
    broadcast({ type, user: nickOf(msg?.user) })
  }
  c.on(WebcastEvent.FOLLOW, social('follow'))
  c.on(WebcastEvent.SHARE, social('share'))

  c.on(WebcastEvent.ROOM_USER, (msg: any) => {
    if (typeof msg?.viewerCount === 'number') viewers = msg.viewerCount
  })
  c.on(WebcastEvent.LIKE, (msg: any) => {
    likes += Number(msg?.count || 1) || 1
  })

  c.on(WebcastEvent.STREAM_END, () => {
    broadcast({ type: 'liveEnd' })
  })
  c.on(ControlEvent.DISCONNECTED, () => {
    broadcast({ type: 'error', message: 'TikTok connection dropped — retrying.' })
    scheduleReconnect()
  })
}

function startStatsLoop() {
  if (statsTimer) return
  statsTimer = setInterval(() => {
    if (listeners.size === 0) return
    broadcast({ type: 'stats', viewers, likes })
  }, 30_000)
}

function scheduleReconnect() {
  if (listeners.size === 0) return
  setTimeout(() => {
    if (listeners.size === 0 || conn?.isConnected) return
    connectPromise = null
    void ensureConnection().catch(() => scheduleReconnect())
  }, 10_000)
}

async function ensureConnection(): Promise<void> {
  const username = process.env.TIKTOK_USERNAME || ''
  if (!username) throw new Error('Missing TIKTOK_USERNAME')
  if (conn && connFor === username && conn.isConnected) return
  if (connectPromise && connFor === username) {
    await connectPromise
    return
  }
  connFor = username
  if (conn) {
    try {
      await conn.disconnect()
    } catch {
      // fall through to fresh connection
    }
  }
  const sessionId = process.env.TIKTOK_SESSION_ID
  const next = new TikTokLiveConnection(username, {
    session: sessionId ? { cookie: { sessionId } } : undefined,
  } as any)
  wireConnection(next)
  conn = next
  connectPromise = next.connect().then(() => undefined)
  try {
    await connectPromise
  } finally {
    if (conn === next && !next.isConnected) connectPromise = null
  }
  startStatsLoop()
}

export async function GET(req: Request) {
  const username = process.env.TIKTOK_USERNAME
  if (!username) {
    return Response.json(
      { error: 'TikTok feed disabled — set TIKTOK_USERNAME to the streamer account.' },
      { status: 503 },
    )
  }

  try {
    await ensureConnection()
  } catch (e: any) {
    const offline = /offline|not live|room/i.test(e?.message || '')
    return Response.json(
      { error: offline ? `@${username} is not live right now.` : `TikTok connect failed: ${e?.message || e}` },
      { status: 503 },
    )
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (event: FeedEvent) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      const listener: Listener = send
      listeners.add(listener)
      controller.enqueue(encoder.encode(`: connected @${username}\n\n`))
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          // client gone
        }
      }, 20_000)
      req.signal.addEventListener('abort', () => {
        clearInterval(ping)
        listeners.delete(listener)
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
