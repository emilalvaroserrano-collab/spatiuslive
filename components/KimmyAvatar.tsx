'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { GoogleGenAI, Modality, type LiveServerMessage } from '@google/genai'
import {
  AvatarManager,
  AvatarSDK,
  AvatarView,
  DrivingServiceMode,
  LogLevel,
  type AvatarController,
} from '@spatius/avatarkit'
import { KIMMY_SYSTEM_PROMPT } from '@/lib/kimmy-prompt'
import { LIVE_SELLING_KNOWLEDGE } from '@/lib/live-selling-knowledge'
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
    this.processor = this.context.createScriptProcessor(4096, 1, 1)
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
  const firstFrameRef = useRef<Promise<void> | null>(null)

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<Status>('booting')
  const [error, setError] = useState('')
  const [hideButton, setHideButton] = useState(false)

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

  const connect = useCallback(async () => {
    if (!config || !controllerRef.current || geminiRef.current) return
    setStatus('connecting')
    setError('')

    // Mic first, synchronously inside the tap gesture. Chunks are dropped
    // until the Gemini session exists, then flow automatically.
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
            parts: [{ text: `${KIMMY_SYSTEM_PROMPT}\n\n${LIVE_SELLING_KNOWLEDGE}` }],
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
              controllerRef.current?.interrupt()
            }

            for (const b64 of collectAudio(message)) {
              const pcm = base64ToArrayBuffer(b64)
              if (pcm.byteLength) {
                turnHasAudio.current = true
                controllerRef.current?.send(pcm, false)
              }
            }

            if (server?.turnComplete) {
              if (turnHasAudio.current) {
                controllerRef.current?.send(new ArrayBuffer(0), true)
                turnHasAudio.current = false
              }
            }
          },
          onerror: (e) => {
            setError(e.message || 'Gemini Live error')
            setStatus('error')
          },
          onclose: () => {
            void micRef.current.stop()
            setStatus(prev => prev === 'error' ? prev : 'ready')
          },
        },
      })
      geminiRef.current = session
    } catch (e: any) {
      setError(e?.message || String(e))
      setStatus('error')
    }
  }, [config])

  return (
    <main className="shell">
      <div className="stageWrap cleanStage">
        <div ref={stageRef} className="stage" />
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
