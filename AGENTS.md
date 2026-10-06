# AGENTS.md — Kimmy (Spatius Nadia + Gemini Live)

Next.js 16 + React 19 + TypeScript strict. Single-page realtime avatar; no tests, no lint, no CI.

## Commands

- `cp .env.example .env.local` then fill `SPATIUS_API_KEY` and `GEMINI_API_KEY`
- `npm install` (no lockfile committed) → `npm run dev` → http://localhost:3000
- Verify: `npm run typecheck` then `npm run build`. No test runner exists.
- Scripts are only `dev | build | start | typecheck` (`package.json`).

## Env / security

- Secrets are server-only: never use `NEXT_PUBLIC_*` for `SPATIUS_API_KEY` / `GEMINI_API_KEY`.
- Public IDs live in `.env.example` (`SPATIUS_APP_ID`, `SPATIUS_AVATAR_ID`); model/voice via `GEMINI_LIVE_MODEL` (default `gemini-3.8-live`) / `GEMINI_VOICE` (default `Kore`).
- Browser only ever gets short-lived tokens from `POST /api/spatius/session-token` and `POST /api/gemini/token`.

## Architecture

- Entrypoint: `app/page.tsx` dynamically imports `components/KimmyAvatar.tsx` with `ssr: false` — avatar/Gemini code is client-only, keep it that way.
- `next.config.mjs` must stay wrapped in `withAvatarkit()` from `@spatius/avatarkit/next`.
- Client logic lives in one file: `components/KimmyAvatar.tsx`. Helpers: `lib/audio.ts` (PCM16/base64/resample), `lib/kimmy-prompt.ts` (`KIMMY_SYSTEM_PROMPT` — edit persona here), `lib/live-selling-knowledge.ts` (`LIVE_SELLING_KNOWLEDGE` — seller style/phrases, style-only, never facts).
- API routes (all `runtime = 'nodejs'`): `app/api/config/route.ts` (GET public config), `app/api/spatius/session-token/route.ts` (mints Spatius token), `app/api/gemini/token/route.ts` (one-use ephemeral via `ai.authTokens.create`, 30-min expiry / 1-min new-session window).

## Init order + audio contract (do not reorder)

1. `GET /api/config` → `AvatarSDK.initialize(appId, { drivingServiceMode: DrivingServiceMode.direct })` → `AvatarManager.shared.load(avatarId)` → `new AvatarView(avatar, stage, { audioFormat: { channelCount: 1, sampleRate: 24000 } })` → wait `onFirstRendering` → on Start: fresh `POST /api/spatius/session-token` + `AvatarSDK.setSessionToken(...)` → `controller.start()` → `POST /api/gemini/token` → `ai.live.connect(...)`.
2. `audioFormat` belongs to the `AvatarView` constructor, never to `initialize()` (view defaults to 16 kHz — sending 24 kHz PCM without setting it is a silent mismatch).
3. Mic → Gemini: mono PCM16 @ 16 kHz (`config.geminiInputSampleRate`), mime `audio/pcm;rate=16000`.
4. Gemini → avatar: 24 kHz PCM chunks → `controller.send(pcm, false)` immediately as generated (never pace to wall-clock); on `serverContent.turnComplete` with audio, flush with `controller.send(new ArrayBuffer(0), true)`.
5. On `serverContent.interrupted`: call `controller.interrupt()` immediately and clear speaking state. `interrupt()` is only for barge-in, never the normal end marker.
6. A/V sync is locked with `controller.frameStarvationMode = FrameStarvationMode.strictSync` (audio pauses rather than outrunning lipsync). Mic uses a 2048-sample ScriptProcessor for snappy input.
6. Load progress callback receives `LoadProgressInfo` (`{ type: 'downloading' | 'completed' | 'failed', progress?: 0..1 }`) — switch on `info.type`, not `typeof info.progress`.

## TikTok live feed + autopilot (keeps her talking nonstop)

- `app/api/tiktok/events/route.ts` (SSE, `runtime = 'nodejs'`) watches the live room via `tiktok-live-connector` (`TikTokLiveConnection`, `WebcastEvent.*`) and broadcasts `chat | gift | follow | share | stats | liveEnd`. Needs `TIKTOK_USERNAME`; optional `TIKTOK_SESSION_ID` cookie. Without a username it returns 503 and only the autopilot runs.
- Browser (`KimmyAvatar.tsx`) turns feed events into `[TikTok ...]` director lines via `sendRealtimeInput` (text, not audio) — comments become her conversational topics; follow/share/gift lines tell her to thank by name; `stats` (viewers/likes every 30 s) only gets a reaction on real milestones.
- Watchdog: `lastAudioAt` updates on every Gemini audio chunk; every 2 s, if quiet for `AUTOPILOT_IDLE_MS` (2 s, `lib/autopilot.ts`), she gets the next round-robin line, weighted toward product (`PRODUCT_FAQS ×2 → FOLLOW_SHARE → CHECKOUT → ENGAGE`). Opening line is sent right after connect.
- Product facts live in `product-knowledge/coffee-luxxe.md`, served by `GET /api/product-knowledge` and appended to the system prompt at connect — edit the .md, not code, to change facts. `PRODUCT_FAQS` mirrors it for the autopilot rotation.

## Gotchas

- Path alias is `@/*` → repo root (`tsconfig.json`), e.g. `@/components/...`.
- Spatius token minting defaults to `us-west` when `SPATIUS_REGION=auto` (`console.us-west.spatius.ai`); override only via `SPATIUS_CONSOLE_ENDPOINT`.
- `AvatarView` needs a mounted `stageRef` div; teardown order in the effect cleanup (`mic.stop` → `gemini.close` → `controller.close` → `view.dispose`) matters. End Session must also call `controller.close()`, not just `interrupt()`, or the Motion Server WebSocket stays open and the next `start()` fails.
- `onConnectionState` only fires in Direct Mode; the SDK enters audio-only fallback if the WS fails within 15 s and reports `failed` — surface it, don't hang silently.
- Avatar pose (drag = pan, wheel/pinch = zoom, double-click = reset) is applied inline on `.stage` and persisted in `localStorage` key `kimmy-avatar-pose-v4` — not in CSS.
- Product catalog is not wired: inject authoritative price/stock/promo context into `KIMMY_SYSTEM_PROMPT` or add Gemini function tools — never hard-code facts into the persona (prompt already forbids inventing them).
