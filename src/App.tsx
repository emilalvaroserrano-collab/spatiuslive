import { useEffect, useRef, useState } from 'react'
import {
  AvatarManager,
  AvatarSDK,
  AvatarView,
  DrivingServiceMode,
} from '@spatius/avatarkit'
import { AvatarPlayer, LiveKitProvider } from '@spatius/avatarkit-rtc'

type TokenResponse = {
  token: string
  url: string
  room: string
  identity?: string
}

const NADIA_APP_ID = 'app_muw1329w_1n3by9r'
const NADIA_AVATAR_ID = '9078fde3-8e55-4311-a8d6-7740185b5b0d'

const appId = (import.meta.env.VITE_SPATIUS_APP_ID || NADIA_APP_ID) as string
const avatarId = (import.meta.env.VITE_SPATIUS_AVATAR_ID || NADIA_AVATAR_ID) as string
const tokenEndpoint = (import.meta.env.VITE_TOKEN_ENDPOINT || '/api/token') as string
const roomPrefix = (import.meta.env.VITE_ROOM_NAME || 'nadia-live-seller') as string

let sdkReady = false

export default function App() {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<AvatarPlayer | null>(null)
  const viewRef = useRef<AvatarView | null>(null)

  const [status, setStatus] = useState('Ready')
  const [connected, setConnected] = useState(false)
  const [micOn, setMicOn] = useState(false)
  const [busy, setBusy] = useState(false)

  const cleanup = async () => {
    try {
      await playerRef.current?.stopPublishing()
    } catch {}
    try {
      await playerRef.current?.disconnect()
    } catch {}
    try {
      viewRef.current?.dispose()
    } catch {}
    playerRef.current = null
    viewRef.current = null
    setConnected(false)
    setMicOn(false)
  }

  useEffect(() => {
    return () => {
      void cleanup()
    }
  }, [])

  const connect = async () => {
    if (busy || connected || !stageRef.current) return

    setBusy(true)
    setStatus('Requesting secure LiveKit session…')

    try {
      const response = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ room: roomPrefix }),
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        throw new Error(payload?.error || `Token request failed (${response.status})`)
      }

      const session = (await response.json()) as TokenResponse
      if (!session.url || !session.token || !session.room) {
        throw new Error('Token endpoint returned incomplete LiveKit credentials')
      }

      if (!sdkReady) {
        setStatus('Initializing AvatarKit…')
        await AvatarSDK.initialize(appId, {
          drivingServiceMode: DrivingServiceMode.rtc,
        })
        sdkReady = true
      }

      setStatus('Loading Nadia…')
      const avatar = await AvatarManager.shared.load(avatarId)
      const view = new AvatarView(avatar, stageRef.current)
      viewRef.current = view

      await new Promise<void>((resolve) => {
        view.onFirstRendering = () => resolve()
      })

      const player = new AvatarPlayer(new LiveKitProvider(), view, {
        logLevel: 'warning',
        enableJitterBuffer: true,
        maxBufferDelayMs: 80,
      })
      playerRef.current = player

      player.on('stalled', () => {
        setStatus('Avatar stream stalled; reconnecting…')
        void player
          .reconnect()
          .then(() => setStatus('Connected'))
          .catch((error) => setStatus(`Reconnect failed: ${String(error)}`))
      })

      setStatus('Connecting Nadia…')
      await player.connect({
        url: session.url,
        token: session.token,
        roomName: session.room,
      })

      setConnected(true)
      setStatus('Connected — enable microphone to talk to Nadia')
    } catch (error) {
      await cleanup()
      setStatus(error instanceof Error ? error.message : 'Connection failed')
    } finally {
      setBusy(false)
    }
  }

  const toggleMic = async () => {
    const player = playerRef.current
    if (!player || busy) return

    setBusy(true)
    try {
      if (micOn) {
        await player.stopPublishing()
        setMicOn(false)
        setStatus('Connected — microphone off')
      } else {
        await player.startPublishing()
        setMicOn(true)
        setStatus('Microphone on — speak naturally')
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Microphone error')
    } finally {
      setBusy(false)
    }
  }

  const disconnect = async () => {
    if (busy) return
    setBusy(true)
    setStatus('Disconnecting…')
    await cleanup()
    setBusy(false)
    setStatus('Disconnected')
  }

  return (
    <main className="app-shell">
      <section className="phone-stage" aria-label="Nadia realtime seller preview">
        <div className="live-bar">
          <div>
            <span className="live-pill">LIVE</span>
            <span className="seller-name">Nadia</span>
          </div>
          <span className="status-dot" data-on={connected ? '1' : '0'}>
            {connected ? 'online' : 'offline'}
          </span>
        </div>

        <div className="avatar-wrap">
          <div ref={stageRef} className="avatar-stage" />
          {!connected && <div className="avatar-placeholder">NADIA</div>}
        </div>

        <div className="product-panel">
          <div className="product-thumb">PRODUCT</div>
          <div>
            <div className="product-title">Product showcase area</div>
            <div className="product-subtitle">
              TikTok product clips, promos, and checkout overlays plug in here next.
            </div>
          </div>
        </div>

        <div className="controls">
          {!connected ? (
            <button className="primary" disabled={busy} onClick={() => void connect()}>
              {busy ? 'Connecting…' : 'Connect Nadia'}
            </button>
          ) : (
            <>
              <button className="primary" disabled={busy} onClick={() => void toggleMic()}>
                {micOn ? 'Turn Mic Off' : 'Enable Mic'}
              </button>
              <button className="secondary" disabled={busy} onClick={() => void disconnect()}>
                Disconnect
              </button>
            </>
          )}
        </div>

        <div className="status-line">{status}</div>
      </section>

      <aside className="notes">
        <h1>Nadia · Spatius + LiveKit</h1>
        <p>
          Realtime Spatius avatar rendered in-browser. Vercel issues short-lived
          LiveKit room tokens; the long-running Nadia agent worker stays on LiveKit
          Agents Cloud or another persistent Python runtime.
        </p>
        <div className="pipeline">
          <span>Mic / future TikTok comments</span>
          <b>→</b>
          <span>LiveKit Agent</span>
          <b>→</b>
          <span>Spatius Motion Server</span>
          <b>→</b>
          <span>Nadia</span>
        </div>
        <p className="small">
          Nadia App ID and Avatar ID are client-safe defaults. Spatius, LiveKit, and
          Gemini server secrets are never shipped in the browser bundle.
        </p>
      </aside>
    </main>
  )
}
