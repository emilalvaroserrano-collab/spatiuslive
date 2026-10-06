# Kimmy — Spatius Nadia + Gemini Live

Realtime Filipina live-seller avatar built with:

- **Spatius AvatarKit Direct Mode** for Nadia rendering, lip sync, and motion
- **Gemini Live** for realtime listening, reasoning, and native voice
- **Next.js** for the UI plus server-only token minting

## Architecture

```text
Viewer microphone (PCM16 16 kHz)
        ↓
Gemini Live — Kimmy persona + native voice
        ↓ PCM16 24 kHz
Spatius AvatarController.send()
        ↓
Nadia rendering + synced audio/motion
```

Both long-lived API keys stay on the Next.js server. The browser receives only short-lived session credentials.

## 1. Requirements

- Node.js 20+
- A Spatius App ID/API key and avatar ID
- A Gemini API key with Live API access

## 2. Configure

```bash
cp .env.example .env.local
```

Fill in `SPATIUS_API_KEY` and `GEMINI_API_KEY`. The provided `.env.example` already contains the selected public IDs:

- Spatius App ID: `app_muw59ima_rgef1v`
- Nadia Avatar ID: `9078fde3-8e55-4311-a8d6-7740185b5b0d`

Do **not** put either secret key into a `NEXT_PUBLIC_*` variable.

## 3. Run

```bash
npm install
npm run dev
```

Open `http://localhost:3000` and press **Start Live** — the mic opens on that tap and the button hides itself 5 seconds after Kimmy goes live, leaving just the avatar.

## 4. Flow

1. `/api/spatius/session-token` exchanges the server-only Spatius key for a short-lived Session Token.
2. Browser initializes AvatarKit in `DrivingServiceMode.direct` at PCM16 mono / 24 kHz.
3. Nadia is loaded into the stage and `controller.start()` connects Motion Server.
4. `/api/gemini/token` uses the server-only Gemini key to mint a one-use ephemeral Live token.
5. Browser connects directly to `gemini-3.8-live` with the Kimmy system prompt and Kore voice.
6. Viewer mic is converted to PCM16 / 16 kHz and streamed into Gemini.
7. Gemini native audio (24 kHz PCM) is sent directly to `AvatarController.send()`.
8. Gemini interruptions call `controller.interrupt()` so Nadia stops stale playback immediately.

## 5. Customize Kimmy

Edit `lib/kimmy-prompt.ts`.

Change Gemini voice/model in `.env.local`:

```env
GEMINI_LIVE_MODEL=gemini-3.8-live
GEMINI_VOICE=Kore
```

## 6. Product data

The current build is the realtime avatar foundation. To attach a product catalog, inject verified product context into `KIMMY_SYSTEM_PROMPT` or add Gemini function tools for your product/price/stock backend. Keep price, stock, promo and shipping data authoritative rather than hard-coded into the persona.

## Security

The ZIP intentionally contains **no secret API keys**. If a key was previously pasted into a chat or another exposed location, rotate it before deployment.

## Stage

The stage is a clean portrait 9:16 frame with a transparent background: just the Nadia avatar, no backdrop, desk, or overlay badges. (The SDK canvas is transparent, so she floats over the page.) Speaking state is shown in the status pill up top.
