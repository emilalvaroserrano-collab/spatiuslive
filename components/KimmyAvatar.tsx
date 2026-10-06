'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai'
import {
  AvatarManager,
  AvatarSDK,
  AvatarView,
  DrivingServiceMode,
  FrameStarvationMode,
  LogLevel,
  type AvatarController,
} from '@spatius/avatarkit'
import { KIMMY_SYSTEM_PROMPT } from '@/lib/kimmy-prompt'
import { LIVE_SELLING_KNOWLEDGE } from '@/lib/live-selling-knowledge'
import { AUDIENCE_MS, AUTOPILOT_IDLE_MS, nextAutopilotLine } from '@/lib/autopilot'
import { arrayBufferToBase64, base64ToArrayBuffer, float32ToPcm16, resampleMono } from '@/lib/audio'

type AppConfig = {
  spatiusAppId: string
  avatarId: string
  region: string
  avatarSampleRate: number
  geminiInputSampleRate: number
  geminiModel: string
  geminiVoice: string
}

type Status = 'booting' | 'ready' | 'connecting' | 'live' | 'error'

// Viewer mic stays muted: Kimmy takes all input from TikTok comments and
// the autopilot director via text. Flip to true to listen on the laptop mic.
const VIEWER_MIC_ENABLED = false

type Pose = { x: number; y: number; s: number } // pan fractions + zoom
const DEFAULT_POSE: Pose = { x: 0, y: 0.04, s: 1.0 }
const POSE_KEY = 'kimmy-avatar-pose-v4'
const PROD_POSE_KEY = 'kimmy-product-pose-v2'
const DEFAULT_PROD_POSE: Pose = { x: 0, y: 0, s: 1 }
const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

function loadPose(key: string, fallback: Pose): Pose {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p?.s === 'number') {
        return {
          x: clampNum(Number(p.x) || 0, -0.6, 0.6),
          y: clampNum(Number(p.y) || 0, -0.6, 0.6),
          s: clampNum(p.s, 0.5, 3),
        }
      }
    }
  } catch {
    // corrupted pose — fall through to default
  }
  return fallback
}

class MicCapture {
  context: AudioContext | null = null
  stream: MediaStream | null = null
  source: MediaStreamAudioSourceNode | null = null
  processor: ScriptProcessorNode | null = null

  async start(rate: number, onChunk: (pcm: ArrayBuffer) => void) {
    if (this.context) return
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })
    this.context = new AudioContext()
    this.source = this.context.createMediaStreamSource(this.stream)
    this.processor = this.context.createScriptProcessor(2048, 1, 1)
    this.processor.onaudioprocess = (event) => {
      event.outputBuffer.getChannelData(0).fill(0)
      const input = event.inputBuffer.getChannelData(0)
      const mono = resampleMono(input, this.context?.sampleRate || rate, rate)
      if (mono.length) onChunk(float32ToPcm16(mono))
    }
    this.source.connect(this.processor)
    this.processor.connect(this.context.destination)
  }

  async stop() {
    this.processor?.disconnect()
    this.source?.disconnect()
    this.stream?.getTracks().forEach(t => t.stop())
    await this.context?.close()
    this.processor = null
    this.source = null
    this.stream = null
    this.context = null
  }
}

function collectAudio(message: LiveServerMessage): string[] {
  const parts = message.serverContent?.modelTurn?.parts || []
  return parts.flatMap((part: any) => part?.inlineData?.data ? [part.inlineData.data as string] : [])
}

export default function KimmyAvatar() {
  const stageRef = useRef<HTMLDivElement>(null)
  const avatarViewRef = useRef<AvatarView | null>(null)
  const controllerRef = useRef<AvatarController | null>(null)
  const geminiRef = useRef<any>(null)
  const micRef = useRef(new MicCapture())
  const turnHasAudio = useRef(false)
  const turnActive = useRef(false)
  const pendingLines = useRef<string[]>([])
  const firstFrameRef = useRef<Promise<void> | null>(null)
  const lastAudioAt = useRef(0)
  const productKnowledge = useRef('')
  const tiktokRef = useRef<{
    es: EventSource | null
    timer: ReturnType<typeof setInterval> | null
    audience: ReturnType<typeof setInterval> | null
  }>({
    es: null,
    timer: null,
    audience: null,
  })
  const statsRef = useRef({ viewers: 0, likes: 0 })

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<Status>('booting')
  const [error, setError] = useState('')
  const [hideButton, setHideButton] = useState(false)
  const zoneRef = useRef<HTMLDivElement>(null)
  const [pose, setPose] = useState<Pose>(() => {
    try {
      const raw = localStorage.getItem(POSE_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p?.s === 'number') {
          return {
            x: clampNum(Number(p.x) || 0, -0.6, 0.6),
            y: clampNum(Number(p.y) || 0, -0.6, 0.6),
            s: clampNum(p.s, 0.5, 3),
          }
        }
      }
    } catch {
      // corrupted pose — fall through to default
    }
    return DEFAULT_POSE
  })

  // Drag to pan, wheel / pinch to zoom, double-click to reset. Native
  // listeners (wheel is non-passive so the page doesn't scroll/zoom).
  useEffect(() => {
    const zone = zoneRef.current
    if (!zone) return
    const pointers = new Map<number, { x: number; y: number }>()
    let lastPinch = 0

    const onDown = (e: PointerEvent) => {
      // Corner handles have their own drag logic below.
      if ((e.target as HTMLElement)?.closest?.('.resizeHandle')) return
      zone.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        lastPinch = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (lastPinch > 0 && d > 0) {
          const ratio = d / lastPinch
          setPose(p => ({ ...p, s: clampNum(p.s * ratio, 0.5, 3) }))
        }
        lastPinch = d
        return
      }
      const rect = zone.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      const dx = (e.clientX - prev.x) / rect.width
      const dy = (e.clientY - prev.y) / rect.height
      setPose(p => ({ x: clampNum(p.x + dx, -0.6, 0.6), y: clampNum(p.y + dy, -0.6, 0.6), s: p.s }))
    }
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) lastPinch = 0
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setPose(p => ({ ...p, s: clampNum(p.s * Math.exp(-e.deltaY * 0.0012), 0.5, 3) }))
    }
    const onDbl = () => setPose(DEFAULT_POSE)

    zone.addEventListener('pointerdown', onDown)
    zone.addEventListener('pointermove', onMove)
    zone.addEventListener('pointerup', onUp)
    zone.addEventListener('pointercancel', onUp)
    zone.addEventListener('wheel', onWheel, { passive: false })
    zone.addEventListener('dblclick', onDbl)
    return () => {
      zone.removeEventListener('pointerdown', onDown)
      zone.removeEventListener('pointermove', onMove)
      zone.removeEventListener('pointerup', onUp)
      zone.removeEventListener('pointercancel', onUp)
      zone.removeEventListener('wheel', onWheel)
      zone.removeEventListener('dblclick', onDbl)
    }
  }, [])

  // Persist avatar pose between visits.
  useEffect(() => {
    try {
      localStorage.setItem(POSE_KEY, JSON.stringify(pose))
    } catch {
      // storage unavailable — pose just won't persist
    }
  }, [pose])

  // Product strip gets the same treatment: drag to move, wheel/pinch to
  // scale, double-click to reset. Pan is in raw pixels (percentages of a
  // thin strip can't reach the whole frame); scale 0.5–3. Persisted.
  const prodRef = useRef<HTMLDivElement>(null)
  const [prodPose, setProdPose] = useState<Pose>(() => {
    try {
      const raw = localStorage.getItem(PROD_POSE_KEY)
      if (raw) {
        const p = JSON.parse(raw)
        if (typeof p?.s === 'number') {
          return {
            x: clampNum(Number(p.x) || 0, -1200, 1200),
            y: clampNum(Number(p.y) || 0, -1200, 1200),
            s: clampNum(p.s, 0.5, 3),
          }
        }
      }
    } catch {
      // corrupted pose — fall through to default
    }
    return DEFAULT_PROD_POSE
  })
  useEffect(() => {
    try {
      localStorage.setItem(PROD_POSE_KEY, JSON.stringify(prodPose))
    } catch {
      // storage unavailable — pose just won't persist
    }
  }, [prodPose])
  useEffect(() => {
    const el = prodRef.current
    if (!el) return
    const pointers = new Map<number, { x: number; y: number }>()
    let lastPinch = 0

    const onDown = (e: PointerEvent) => {
      // Corner handles have their own drag logic below.
      if ((e.target as HTMLElement)?.closest?.('.resizeHandle')) return
      el.setPointerCapture(e.pointerId)
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        lastPinch = Math.hypot(a.x - b.x, a.y - b.y)
      }
    }
    const onMove = (e: PointerEvent) => {
      const prev = pointers.get(e.pointerId)
      if (!prev) return
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const d = Math.hypot(a.x - b.x, a.y - b.y)
        if (lastPinch > 0 && d > 0) {
          const ratio = d / lastPinch
          setProdPose(p => ({ ...p, s: clampNum(p.s * ratio, 0.5, 3) }))
        }
        lastPinch = d
        return
      }
      const dxRaw = e.clientX - prev.x
      const dyRaw = e.clientY - prev.y
      // Keep the strip inside the stage: clamp the step so its box never
      // leaves the backdrop (if zoomed larger than the stage, center it).
      const stage = el.parentElement?.getBoundingClientRect()
      const r = el.getBoundingClientRect()
      let dx = dxRaw
      let dy = dyRaw
      if (stage && r.width && r.height) {
        const minDx = stage.left - r.left
        const maxDx = stage.right - r.right
        const minDy = stage.top - r.top
        const maxDy = stage.bottom - r.bottom
        dx = minDx <= maxDx ? clampNum(dxRaw, minDx, maxDx) : (stage.left + stage.right) / 2 - (r.left + r.right) / 2
        dy = minDy <= maxDy ? clampNum(dyRaw, minDy, maxDy) : (stage.top + stage.bottom) / 2 - (r.top + r.bottom) / 2
      }
      setProdPose(p => ({ x: p.x + dx, y: p.y + dy, s: p.s }))
    }
    const onUp = (e: PointerEvent) => {
      pointers.delete(e.pointerId)
      if (pointers.size < 2) lastPinch = 0
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setProdPose(p => ({ ...p, s: clampNum(p.s * Math.exp(-e.deltaY * 0.0012), 0.5, 3) }))
    }
    const onDbl = () => setProdPose(DEFAULT_PROD_POSE)

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('dblclick', onDbl)
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('dblclick', onDbl)
    }
  }, [])

  // Corner-handle resize: pull away from center to grow, push in to shrink.
  const resizeRef = useRef<{ id: number | null; startDist: number; startS: number }>({
    id: null,
    startDist: 0,
    startS: 1,
  })
  const onCornerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const zone = zoneRef.current
    if (!zone) return
    const rect = zone.getBoundingClientRect()
    const d = Math.hypot(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    )
    if (!d) return
    resizeRef.current = { id: e.pointerId, startDist: d, startS: pose.s }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onCornerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = resizeRef.current
    if (r.id !== e.pointerId) return
    const zone = zoneRef.current
    if (!zone) return
    const rect = zone.getBoundingClientRect()
    const d = Math.hypot(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    )
    if (d <= 0) return
    setPose(p => ({ ...p, s: clampNum((r.startS * d) / r.startDist, 0.5, 3) }))
  }
  const onCornerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (resizeRef.current.id === e.pointerId) resizeRef.current.id = null
  }
  // Corner-handle resize for the product strip: same pull-to-scale behavior.
  const prodResizeRef = useRef<{ id: number | null; startDist: number; startS: number }>({
    id: null,
    startDist: 0,
    startS: 1,
  })
  const onProdCornerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    const el = prodRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const d = Math.hypot(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    )
    if (!d) return
    prodResizeRef.current = { id: e.pointerId, startDist: d, startS: prodPose.s }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onProdCornerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = prodResizeRef.current
    if (r.id !== e.pointerId) return
    const el = prodRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const d = Math.hypot(
      e.clientX - (rect.left + rect.width / 2),
      e.clientY - (rect.top + rect.height / 2),
    )
    if (d <= 0) return
    setProdPose(p => ({ ...p, s: clampNum((r.startS * d) / r.startDist, 0.5, 3) }))
  }
  const onProdCornerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (prodResizeRef.current.id === e.pointerId) prodResizeRef.current.id = null
  }

  // Auto-hide the button 5s after going live; show it again otherwise.
  useEffect(() => {
    if (status !== 'live') {
      setHideButton(false)
      return
    }
    const timer = setTimeout(() => setHideButton(true), 5000)
    return () => clearTimeout(timer)
  }, [status])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cfgRes = await fetch('/api/config', { cache: 'no-store' })
        const cfg = await cfgRes.json()
        if (!cfgRes.ok) throw new Error(cfg.error || 'Configuration failed')

        // Product facts (single source: product-knowledge/coffee-luxxe.md).
        // Missing file = sell with style only, never invent facts.
        try {
          const pkRes = await fetch('/api/product-knowledge', { cache: 'no-store' })
          const pk = await pkRes.json()
          if (pkRes.ok && typeof pk.knowledge === 'string') productKnowledge.current = pk.knowledge
        } catch {
          // knowledge unavailable — persona accuracy rules still apply
        }

        await AvatarSDK.initialize(cfg.spatiusAppId, {
          ...(cfg.region && cfg.region !== 'auto' ? { region: cfg.region } : {}),
          drivingServiceMode: DrivingServiceMode.direct,
          logLevel: LogLevel.warning,
        })

        if (!stageRef.current) throw new Error('Avatar stage is unavailable')
        const avatar = await AvatarManager.shared.load(cfg.avatarId)
        if (cancelled) return

        // Audio format belongs to the view, not initialize(). The view
        // defaults to 16 kHz; Gemini sends 24 kHz PCM, so set it here.
        const view = new AvatarView(avatar, stageRef.current, {
          audioFormat: { channelCount: 1, sampleRate: cfg.avatarSampleRate },
        })
        avatarViewRef.current = view
        controllerRef.current = view.controller
        // Strict A/V lock: never let voice run ahead of lipsync. If motion
        // data runs out, audio pauses and resumes with it (default mode would
        // keep playing audio while lips lag behind).
        view.controller.frameStarvationMode = FrameStarvationMode.strictSync
        let resolveFirstFrame!: () => void
        firstFrameRef.current = new Promise<void>((resolve) => {
          resolveFirstFrame = resolve
        })
        view.onFirstRendering = () => resolveFirstFrame()
        view.controller.onConnectionState = (state) => {
          // Direct Mode only. SDK enters audio-only fallback on timeout and
          // reports 'failed' — surface it instead of hanging silently.
          if (!cancelled && state === 'failed') {
            setError('Avatar connection failed — check network and session token.')
            setStatus('error')
          }
        }
        view.controller.onError = (e: Error) => {
          setError(e.message)
          setStatus('error')
        }
        setConfig(cfg)
        setStatus('ready')
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || String(e))
          setStatus('error')
        }
      }
    })()

    return () => {
      cancelled = true
      void micRef.current.stop()
      geminiRef.current?.close()
      controllerRef.current?.close()
      avatarViewRef.current?.dispose()
      geminiRef.current = null
      controllerRef.current = null
      avatarViewRef.current = null
    }
  }, [])

  // Director line into the live session (comment, gift, stat, or autopilot
  // nudge). Also resets the nonstop-talk watchdog. Lines marked defer:true
  // wait for her current turn to finish instead of cutting her off.
  const sendDirectorLine = useCallback((line: string, opts?: { defer?: boolean }) => {
    if (opts?.defer && turnActive.current) {
      pendingLines.current.push(line)
      if (pendingLines.current.length > 3) pendingLines.current.shift()
      return
    }
    const session = geminiRef.current
    if (!session) return
    lastAudioAt.current = Date.now()
    session.sendRealtimeInput({ text: line })
  }, [])

  const stopTikTokFeed = useCallback(() => {
    tiktokRef.current.es?.close()
    tiktokRef.current.es = null
    if (tiktokRef.current.timer) {
      clearInterval(tiktokRef.current.timer)
      tiktokRef.current.timer = null
    }
    if (tiktokRef.current.audience) {
      clearInterval(tiktokRef.current.audience)
      tiktokRef.current.audience = null
    }
  }, [])

  // TikTok live comments/status → interactive prompts for Kimmy's topics.
  const startTikTokFeed = useCallback(() => {
    stopTikTokFeed()
    let es: EventSource
    try {
      es = new EventSource('/api/tiktok/events')
    } catch {
      return // feed disabled (no TIKTOK_USERNAME) — autopilot still runs
    }
    tiktokRef.current.es = es
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === 'chat' && data.text) {
          sendDirectorLine(`[TikTok live comment from @${data.user}]: ${data.text}`)
        } else if (data.type === 'gift') {
          sendDirectorLine(`[TikTok: @${data.user} sent ${data.gift} x${data.count}! Thank them excitedly by name, then tie it back to the product.]`)
        } else if (data.type === 'follow') {
          sendDirectorLine(`[TikTok: @${data.user} just followed! Welcome them warmly by name and invite a question.]`, { defer: true })
        } else if (data.type === 'share') {
          sendDirectorLine(`[TikTok: @${data.user} shared the live! Thank them and remind everyone to share. Keep it to one line, then back to selling.]`, { defer: true })
        } else if (data.type === 'stats') {
          statsRef.current = {
            viewers: Number(data.viewers) || 0,
            likes: Number(data.likes) || 0,
          }
          sendDirectorLine(`[TikTok live status: ${data.viewers} viewers, ${data.likes} total likes. If there is a milestone worth celebrating, celebrate it in one line; otherwise just keep selling.]`, { defer: true })
        } else if (data.type === 'liveEnd') {
          sendDirectorLine('[DIRECTOR: The TikTok live just ended. Thank everyone, do a final checkout push, and close the show warmly.]')
        }
      } catch {
        // malformed feed payload — ignore
      }
    }
  }, [sendDirectorLine, stopTikTokFeed])

  // Nonstop-talk trigger: when Kimmy herself has been quiet too long, feed
  // her the next autopilot topic (FAQ, follow/share, checkout, engagement).
  const startAutopilot = useCallback(() => {
    if (tiktokRef.current.timer) clearInterval(tiktokRef.current.timer)
    if (tiktokRef.current.audience) clearInterval(tiktokRef.current.audience)
    sendDirectorLine('[DIRECTOR: You just went live on TikTok. Open the show with energy: name the Luxe Slim Caffe Macchiato Decaf, its 3 hooks (decaf anytime, slimming + glow actives, stevia-sweetened smooth taste), and invite everyone to stay.]')
    tiktokRef.current.timer = setInterval(() => {
      if (!geminiRef.current) return
      // Never cut her off: only nudge when her turn fully finished.
      if (!turnActive.current && Date.now() - lastAudioAt.current >= AUTOPILOT_IDLE_MS) {
        sendDirectorLine(`[DIRECTOR: Quiet room — do not stop talking. ${nextAutopilotLine()}]`)
      }
    }, 1000)
    // Every minute: make her look at the room and acknowledge the audience.
    // Deferred when she's mid-turn, so it never interrupts — just waits.
    tiktokRef.current.audience = setInterval(() => {
      if (!geminiRef.current) return
      const { viewers, likes } = statsRef.current
      const room = viewers > 0
        ? `right now ${viewers} people are watching with ${likes} total likes`
        : 'people are watching right now'
      sendDirectorLine(
        `[DIRECTOR: audience check — ${room}. Look at the camera, greet and acknowledge the viewers warmly so they feel seen, then roll straight back into selling the coffee. One or two lines, then keep going.]`,
        { defer: true },
      )
    }, AUDIENCE_MS)
  }, [sendDirectorLine])

  // Stop feed/autopilot on unmount.
  useEffect(() => {
    const feed = tiktokRef.current
    return () => {
      feed.es?.close()
      feed.es = null
      if (feed.timer) {
        clearInterval(feed.timer)
        feed.timer = null
      }
      if (feed.audience) {
        clearInterval(feed.audience)
        feed.audience = null
      }
    }
  }, [])

  const connect = useCallback(async () => {
    if (!config || !controllerRef.current || geminiRef.current) return
    setStatus('connecting')
    setError('')

    // Mic first, synchronously inside the tap gesture. Chunks are dropped
    // until the Gemini session exists, then flow automatically.
    if (VIEWER_MIC_ENABLED) {
      try {
        await micRef.current.start(config.geminiInputSampleRate, (pcm) => {
          const session = geminiRef.current
          if (!session) return
          session.sendRealtimeInput({
            audio: {
              data: arrayBufferToBase64(pcm),
              mimeType: `audio/pcm;rate=${config.geminiInputSampleRate}`,
            },
          })
        })
      } catch (e: any) {
        setError(e?.name === 'NotAllowedError' ? 'Microphone permission denied.' : (e?.message || String(e)))
        setStatus('error')
        return
      }
    }

    try {
      // Lifecycle: wait for the first rendered frame before start(), and
      // mint a fresh short-lived token for each new connection.
      if (firstFrameRef.current) {
        await Promise.race([
          firstFrameRef.current,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Avatar renderer did not become ready')), 20000),
          ),
        ])
      }

      const spatRes = await fetch('/api/spatius/session-token', { method: 'POST' })
      const spatData = await spatRes.json()
      if (!spatRes.ok) throw new Error(spatData.error || 'Could not mint Spatius token')
      AvatarSDK.setSessionToken(spatData.sessionToken)

      const controller = controllerRef.current
      await (controller as any).initializeAudioContext?.()
      await controller.start()

      const tokenRes = await fetch('/api/gemini/token', { method: 'POST' })
      const tokenData = await tokenRes.json()
      if (!tokenRes.ok) throw new Error(tokenData.error || 'Could not mint Gemini token')

      const ai = new GoogleGenAI({ apiKey: tokenData.token, httpOptions: { apiVersion: 'v1beta' } })
      const session = await ai.live.connect({
        model: config.geminiModel,
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: config.geminiVoice },
            },
          },
          systemInstruction: {
            parts: [
              {
                text: `${KIMMY_SYSTEM_PROMPT}\n\n${LIVE_SELLING_KNOWLEDGE}\n\n${productKnowledge.current}`,
              },
            ],
          },
          // Long live sessions would otherwise die at the context limit.
          contextWindowCompression: {
            triggerTokens: '104857',
            slidingWindow: { targetTokens: '52428' },
          },
        },
        callbacks: {
          onopen: () => {
            setStatus('live')
          },
          onmessage: (message) => {
            const server = message.serverContent

            if (server?.interrupted) {
              turnHasAudio.current = false
              turnActive.current = false
              controllerRef.current?.interrupt()
            }

            for (const b64 of collectAudio(message)) {
              const pcm = base64ToArrayBuffer(b64)
              if (pcm.byteLength) {
                turnHasAudio.current = true
                turnActive.current = true
                lastAudioAt.current = Date.now()
                controllerRef.current?.send(pcm, false)
              }
            }

            if (server?.turnComplete) {
              turnActive.current = false
              if (turnHasAudio.current) {
                controllerRef.current?.send(new ArrayBuffer(0), true)
                turnHasAudio.current = false
              }
              // Deliver anything that waited for her to finish (thanks,
              // stats), then keep talking if the room is still quiet.
              const pending = pendingLines.current.splice(0)
              if (pending.length && geminiRef.current) {
                lastAudioAt.current = Date.now()
                geminiRef.current.sendRealtimeInput({ text: pending.slice(-2).join('\n') })
              }
            }
          },
          onerror: (e) => {
            setError(e.message || 'Gemini Live error')
            setStatus('error')
          },
          onclose: () => {
            void micRef.current.stop()
            stopTikTokFeed()
            setStatus(prev => prev === 'error' ? prev : 'ready')
          },
        },
      })
      geminiRef.current = session
      lastAudioAt.current = Date.now()
      startTikTokFeed()
      startAutopilot()
    } catch (e: any) {
      setError(e?.message || String(e))
      setStatus('error')
    }
  }, [config, startAutopilot, startTikTokFeed])

  return (
    <main className="shell">
      <div className="stageWrap sellerStage">
        <div ref={zoneRef} className="avatarLayer">
          <div
            ref={stageRef}
            className="stage"
            style={{
              transform: `translate(${pose.x * 100}%, ${pose.y * 100}%) scale(${pose.s})`,
              transformOrigin: '50% 40%',
            }}
          />
          {(['tl', 'tr', 'bl', 'br'] as const).map(corner => (
            <div
              key={corner}
              className={`resizeHandle ${corner}`}
              onPointerDown={onCornerDown}
              onPointerMove={onCornerMove}
              onPointerUp={onCornerUp}
              onPointerCancel={onCornerUp}
            />
          ))}
        </div>
        <div className="counterFront" aria-hidden="true" />
        <div
          ref={prodRef}
          className="productDrift"
          aria-hidden="true"
          style={{
            transform: `translate(${prodPose.x}px, ${prodPose.y}px) scale(${prodPose.s})`,
            transformOrigin: '50% 50%',
          }}
        >
          <img src="/product-lineup.png" alt="" draggable={false} />
          {(['tl', 'tr', 'bl', 'br'] as const).map(corner => (
            <div
              key={corner}
              className={`resizeHandle ${corner}`}
              onPointerDown={onProdCornerDown}
              onPointerMove={onProdCornerMove}
              onPointerUp={onProdCornerUp}
              onPointerCancel={onProdCornerUp}
            />
          ))}
        </div>
      </div>
      {!hideButton && (
        <button
          className="startLive"
          onClick={connect}
          disabled={status === 'connecting' || status === 'booting' || !config}
          title={error || undefined}
        >
          {status === 'connecting' || status === 'booting' ? 'Connecting…' : status === 'error' ? 'Retry Live' : 'Start Live'}
        </button>
      )}
    </main>
  )
}
