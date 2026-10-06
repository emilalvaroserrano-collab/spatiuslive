# SpatiusLive — Nadia realtime seller

Realtime Nadia avatar starter using **Spatius AvatarKit + LiveKit Agents**, with a Vite/React frontend ready for Vercel.

## What is already wired

- Nadia Spatius App ID: `app_muw1329w_1n3by9r`
- Nadia Avatar ID: `9078fde3-8e55-4311-a8d6-7740185b5b0d`
- Browser-side AvatarKit RTC renderer
- Vercel `/api/token` function using short-lived LiveKit JWTs
- Explicit dispatch to the `nadia-seller` LiveKit agent
- Reconnect handling for stalled avatar motion
- Microphone enable/disable for realtime conversation
- 9:16 seller-stage UI with a placeholder product panel
- Server secrets excluded from the browser bundle and Git

## Architecture

```text
Browser / TikTok UI
       |
       | POST /api/token
       v
Vercel Function ---- LiveKit signed room token
       |
       v
LiveKit Room <---- persistent Nadia agent worker
       |                    |
       |                    +-- Gemini realtime voice model
       |                    +-- Spatius plugin -> Motion Server
       v
AvatarKit RTC adapter -> local Nadia render + synchronized audio
```

## Deploy the web app to Vercel

Import this GitHub repository into Vercel. Framework is Vite and `vercel.json` is already included.

Set these **server-side Vercel Environment Variables**:

```env
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=...
LIVEKIT_API_SECRET=...
LIVEKIT_AGENT_NAME=nadia-seller
```

No Spatius API key belongs in Vercel's client-side `VITE_*` variables. Nadia's App ID and Avatar ID are already client-safe defaults in `src/App.tsx`; optional overrides are documented in `.env.example`.

## Run locally

```bash
npm install
npm run dev
```

For local `/api/token`, either run through Vercel CLI (`vercel dev`) or point `VITE_TOKEN_ENDPOINT` at a compatible token endpoint.

## Agent worker

The Vercel deployment cannot replace the long-running LiveKit Agents worker. Deploy `backend/agent.py` to LiveKit Agents Cloud, a VPS, or another persistent runtime and give it the server-side keys in `backend/.env.example`.

See [`backend/README.md`](backend/README.md).

## Security

- Never commit `SPATIUS_API_KEY`, `LIVEKIT_API_SECRET`, or `GOOGLE_API_KEY`.
- The Spatius key previously pasted into chat should be rotated before use.
- Only short-lived LiveKit participant tokens are returned to the browser.

## Next seller integration

The current app is the avatar/runtime layer. The next production step is:

```text
TikTok comments/events
 -> seller router / product state
 -> generated short reply
 -> agent/TTS
 -> Spatius Nadia avatar
 -> product/video compositor
 -> TikTok Live output
```
