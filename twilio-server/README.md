# Uno ReVoice phone server (SignalWire)

Answers forwarded calls on the SignalWire number with a Gemini voice agent and streams the call to the phone app (Live mode).

```
Caller → your carrier forwards it → SignalWire +1 208 485 0663 → POST /voice
      → <Connect><Stream> → WS /media ⇄ Gemini Live agent (gemini-3.8-live)
      → transcript → warning signs (gemini-4-hydrogen) and verdict (gemini-4-neon)
      → WS /app → the phone app (Join · End · Block · Steer)
```

| File | Job |
| --- | --- |
| `src/index.js` | HTTP routes, WebSockets, audio bridge |
| `src/telephony.js` | Everything SignalWire-specific (cXML, REST, signature, stream messages). Swap this file to go back to Twilio. |
| `src/agent.js` | Gemini Live session per call: caller audio in, agent audio and transcripts out, steering |
| `src/brain.js` | Regex signs (instant), Hydrogen signs after each caller line, Neon verdict |
| `src/calls.js` | Call state, app sockets, devices, Expo push, block list (`data/`) |
| `src/audio.js` | µ-law ⇄ PCM16, resampling, WAV |
| `scripts/sim.js` | Fake SignalWire call for testing without a phone |

## Setup

```bash
cd twilio-server
cp .env.example .env     # fill in the SignalWire and Gemini values yourself
npm install
npm start                # or: npm run dev (restarts on file changes)
```

Never commit `.env` (it's git-ignored) and never paste its values into chat.

## Test without a phone

```bash
npm run sim
```

It streams a scripted scam caller (macOS `say` voice) into `/media` exactly like SignalWire, prints the events the app receives, and saves the agent's replies to `sim-agent.wav`. Use `npm run sim -- --wav caller.wav` for your own recording.

## Real calls

1. `ngrok http 3000`, then put the host (without `https://`) in `.env` as `PUBLIC_HOST` and restart.
2. In SignalWire: **Phone Numbers → +1 208 485 0663 → Inbound Call Settings**:
   - Assign Resource → **cXML Script** (or cXML/LaML webhook) → External URL `https://<ngrok-host>/voice`, method **POST**.
   - Status Change Webhook: `https://<ngrok-host>/voice/status`.
3. In the app: Setup → **Live**, server address `https://<ngrok-host>`, your phone number, then **Save and connect** (this registers the phone for pushes and for Join).

**Trial limit:** only verified numbers can call in or be called. Verify the callers' phones and your own phone (Join rings it).

**Join tip:** Join rings you from +1 208 485 0663. Save that number as a contact, or Silence Unknown Callers / forwarding sends it straight back to the agent.

## Call forwarding codes

Dial on your phone, with the SignalWire number:

| Carrier | Turn on | Turn off |
| --- | --- | --- |
| Verizon | `*71` + number | `*73` |
| AT&T / T-Mobile | `**004*1` + number + `#` | `##004#` |

On iPhone also turn on **Settings → Apps → Phone → Screen Unknown Callers → Silence**, so unknown callers go to "voicemail", which forwards to the agent.

## API

| Route | Body | Does |
| --- | --- | --- |
| `POST /voice` | SignalWire form | Rejects blocked callers; otherwise streams the call to `/media` |
| `POST /voice/status` | SignalWire form | Sends `call.ended` when the call is over |
| `POST /voice/join?phone=` | SignalWire form | cXML `<Dial>` to the user's phone (target of Join's redirect) |
| `WS /media` | SignalWire stream | Audio bridge to Gemini Live |
| `WS /app?phone=` | – | Events to the app: `call.started`, `transcript`, `signal`, `verdict`, `call.ended` |
| `POST /api/device` | `phone, pushToken, platform` | Saves the phone; Expo push on each new call |
| `POST /api/calls/:id/join` | `phone` | Stops the agent and redirects the call to ring `phone` |
| `POST /api/calls/:id/end` | – | Hangs up |
| `POST /api/calls/:id/say` | `text` | Steering: a private instruction for the agent's next line |
| `POST /api/block` | `phone, number, callId` | Adds `number` to the block list (`data/blocked.json`) |
| `GET /api/health` | – | Status and live call IDs |

Set `VALIDATE_SIGNATURE=true` and `SIGNALWIRE_SIGNING_KEY` to reject webhooks that don't come from SignalWire (`x-signalwire-signature`).

**No sign-in yet:** anyone who knows the ngrok URL could watch or end calls. Fine for a demo; add a token before real use.
