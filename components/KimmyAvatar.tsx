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

type Transcript = { role: 'viewer' | 'kimmy'; text: string }

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

  const [config, setConfig] = useState<AppConfig | null>(null)
  const [status, setStatus] = useState<Status>('booting')
  const [statusText, setStatusText] = useState('Loading Nadia…')
  const [micOn, setMicOn] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [transcript, setTranscript] = useState<Transcript[]>([])
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const cfgRes = await fetch('/api/config', { cache: 'no-store' })
        const cfg = await cfgRes.json()
        if (!cfgRes.ok) throw new Error(cfg.error || 'Configuration failed')

        const tokenRes = await fetch('/api/spatius/session-token', { method: 'POST' })
        const tokenData = await tokenRes.json()
        if (!tokenRes.ok) throw new Error(tokenData.error || 'Could not mint Spatius token')

        await AvatarSDK.initialize(cfg.spatiusAppId, {
          ...(cfg.region && cfg.region !== 'auto' ? { region: cfg.region } : {}),
          drivingServiceMode: DrivingServiceMode.direct,
          audioFormat: { channelCount: 1, sampleRate: cfg.avatarSampleRate },
          logLevel: LogLevel.warning,
        })
        AvatarSDK.setSessionToken(tokenData.sessionToken)

        if (!stageRef.current) throw new Error('Avatar stage is unavailable')
        const avatar = await AvatarManager.shared.load(cfg.avatarId, (info) => {
          if (!cancelled && typeof info.progress === 'number') {
            setStatusText(`Loading Nadia ${Math.round(info.progress * 100)}%`)
          }
        })
        if (cancelled) return

        const view = new AvatarView(avatar, stageRef.current)
        avatarViewRef.current = view
        controllerRef.current = view.controller
        view.onFirstRendering = () => setStatusText('Nadia loaded — ready to start Kimmy')
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
    setStatusText('Connecting Kimmy…')
    setError('')

    try {
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
            parts: [{ text: KIMMY_SYSTEM_PROMPT }],
          },
        },
        callbacks: {
          onopen: () => {
            setStatus('live')
            setStatusText('Kimmy is live')
          },
          onmessage: (message) => {
            const server = message.serverContent

            if (server?.interrupted) {
              turnHasAudio.current = false
              setSpeaking(false)
              controllerRef.current?.interrupt()
            }

            for (const b64 of collectAudio(message)) {
              const pcm = base64ToArrayBuffer(b64)
              if (pcm.byteLength) {
                turnHasAudio.current = true
                setSpeaking(true)
                controllerRef.current?.send(pcm, false)
              }
            }

            const userText = server?.inputTranscription?.text?.trim()
            if (userText) {
              setTranscript(prev => [...prev, { role: 'viewer', text: userText }])
            }

            const kimmyText = server?.outputTranscription?.text?.trim()
            if (kimmyText) {
              setTranscript(prev => [...prev, { role: 'kimmy', text: kimmyText }])
            }

            if (server?.turnComplete) {
              if (turnHasAudio.current) {
                controllerRef.current?.send(new ArrayBuffer(0), true)
                turnHasAudio.current = false
              }
              setSpeaking(false)
            }
          },
          onerror: (e) => {
            setError(e.message || 'Gemini Live error')
            setStatus('error')
          },
          onclose: () => {
            setMicOn(false)
            setSpeaking(false)
            setStatus(prev => prev === 'error' ? prev : 'ready')
            setStatusText('Kimmy disconnected')
          },
        },
      })
      geminiRef.current = session
    } catch (e: any) {
      setError(e?.message || String(e))
      setStatus('error')
    }
  }, [config])

  const toggleMic = useCallback(async () => {
    if (!config || !geminiRef.current) return
    if (micOn) {
      await micRef.current.stop()
      setMicOn(false)
      return
    }

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
      setMicOn(true)
    } catch (e: any) {
      setError(e?.name === 'NotAllowedError' ? 'Microphone permission denied.' : (e?.message || String(e)))
    }
  }, [config, micOn])

  const sendText = useCallback(() => {
    const text = typed.trim()
    if (!text || !geminiRef.current) return
    geminiRef.current.sendRealtimeInput({ text })
    setTyped('')
  }, [typed])

  const disconnect = useCallback(async () => {
    await micRef.current.stop()
    setMicOn(false)
    geminiRef.current?.close()
    geminiRef.current = null
    controllerRef.current?.interrupt()
    setSpeaking(false)
    setStatus('ready')
    setStatusText('Ready to start Kimmy')
  }, [])

  return (
    <main className="shell">
      <section className="stageCard">
        <div className="topbar">
          <div>
            <span className="eyebrow">SPATIUS REALTIME AVATAR</span>
            <h1>Kimmy</h1>
            <p>Nadia visual · Gemini Live voice</p>
          </div>
          <div className={`status ${status}`}><span />{statusText}</div>
        </div>

        <div className="stageWrap sellerStudio">
          <div className="studioBackdrop" aria-hidden="true">
            <div className="studioGlow studioGlowLeft" />
            <div className="studioGlow studioGlowRight" />
            <div className="studioBrand">
              <span>KIMMY</span>
              <strong>LIVE SHOP</strong>
            </div>
            <div className="productShelf productShelfLeft">
              <i /><i /><i />
            </div>
            <div className="productShelf productShelfRight">
              <i /><i /><i />
            </div>
          </div>

          <div className="avatarCrop">
            <div ref={stageRef} className="stage sellerAvatar" />
          </div>

          <div className="sellerDesk" aria-hidden="true">
            <div className="deskProducts">
              <span className="productMock tall" />
              <span className="productMock short" />
              <span className="productMock bottle" />
              <span className="productMock short" />
              <span className="productMock tall" />
            </div>
            <div className="deskFront">KIMMY LIVE</div>
          </div>

          <div className="liveBadge">LIVE</div>
          {speaking && <div className="speakingBadge">Kimmy is speaking</div>}
        </div>

        <div className="controls">
          {status === 'ready' || status === 'error' ? (
            <button className="primary" onClick={connect} disabled={!config}>Start Kimmy</button>
          ) : status === 'connecting' ? (
            <button className="primary" disabled>Connecting…</button>
          ) : (
            <>
              <button className={`mic ${micOn ? 'active' : ''}`} onClick={toggleMic}>{micOn ? 'Mute Viewer Mic' : 'Open Viewer Mic'}</button>
              <button className="secondary" onClick={disconnect}>End Session</button>
            </>
          )}
        </div>

        {error && <div className="errorBox">{error}</div>}
      </section>

      <aside className="panel">
        <div>
          <span className="eyebrow">TEST CONVERSATION</span>
          <h2>Live transcript</h2>
        </div>
        <div className="transcript">
          {transcript.length === 0 ? (
            <p className="empty">Open the mic and talk to Kimmy, or send a test line below.</p>
          ) : transcript.map((t, i) => (
            <div className={`bubble ${t.role}`} key={`${t.role}-${i}`}>
              <strong>{t.role === 'viewer' ? 'Viewer' : 'Kimmy'}</strong>
              <p>{t.text}</p>
            </div>
          ))}
        </div>
        <form className="composer" onSubmit={(e) => { e.preventDefault(); sendText() }}>
          <input value={typed} onChange={e => setTyped(e.target.value)} placeholder="e.g. Magkano sis?" disabled={status !== 'live'} />
          <button disabled={status !== 'live' || !typed.trim()}>Send</button>
        </form>
        <div className="meta">
          <span>Avatar: Nadia</span>
          <span>Persona: Kimmy</span>
          <span>Voice: {config?.geminiVoice || 'Kore'}</span>
          <span>Model: {config?.geminiModel || 'gemini-3.8-live'}</span>
        </div>
      </aside>
    </main>
  )
}
