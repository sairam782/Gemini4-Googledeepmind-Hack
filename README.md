# Uno ReVoice

When a call comes in from an unknown number, Uno ReVoice hands it to a clearly identified AI assistant. The assistant asks the caller who they are and checks them for scam signs while Alex watches live, steers its next line in private, and can take the call back, end it or block the number in one tap. Several Gemini models listen in parallel: they flag scam warning signs, keep notes, and suggest the next line. App code makes every decision that matters. Gemini 4 NYC Hackathon.

```
Unknown caller ──► Alex's phone declines it (Android) / silences it (iPhone)
                   └─► carrier forwards it to the Twilio number
                        └─► the agent answers ──► server ──WebSocket──► phone app
```

## What's in this repo

| Folder | What it is | Run it |
| --- | --- | --- |
| `/` (root) | **Phone app** (Expo / React Native): Live call, History, Setup, Android call check | `npm install`, then `npx expo run:ios` or `npx expo run:android` |
| `server/` | **Agent server** (TypeScript): Twilio bridge, Gemini transcription, the multi-model brain, call review | `cd server && npm install && npm run dev` |
| `web/` | **Brain test desk** (Vite + React) for the server | `cd web && npm install && npm run dev` |
| `shared/` | Event contract shared by `server/` and `web/` (`shared/brain.ts`) | – |
| `twilio-server/` | **Phone app's server**: answers forwarded calls on the Twilio number and talks to the phone app over `/app` | `cd twilio-server && npm install && npm start` |

Each folder installs on its own. The root `package.json` belongs to the phone app, so there is no npm workspace; `web/` uses React 18 and the app uses React 19, and they must not share `node_modules`. From the root, `npm run dev:agent` starts `server/` and `web/` together (install both first).

## Status

| Part | State |
| --- | --- |
| Phone app | Built: Live call, History and Setup screens, demo calls, Android call check, forwarding codes, push handling. |
| Agent server + brain | Built in `server/`: 56/56 evals pass on the 8 scripted calls (see below). |
| **Two paths, on purpose** | The **phone app** talks to `twilio-server/` using the [phone app contract](#phone-app-server-contract) (`/app` socket, `/api/...` routes). The **web test desk** talks to `server/` over `/ws` with `shared/brain.ts` events. Both stay; testing goes through the phone app. |

Until `twilio-server/` is running and set in the app's Setup screen, the phone app's demo calls are the only way to see the Live call screen.

---

# Agent server

## Architecture

![ReVoice architecture](docs/architecture.png)

Each finished caller line is sent to every lane at once. The app merges the results.

| Box | Lane | Model (env) | Typical latency | Job |
|---|---|---|---|---|
| Caller turn | transcribe | `gemini-3.5-transcribe-live` (`TRANSCRIBE_MODEL`) | final line ~1 s after the caller stops | One Live session per phone track, so speakers are known without diarization. Interim words stream as captions. |
| Fast lane | rules + flash | regex + `gemini-3.5-flash-lite` (`FLASH_MODEL`) | 1 ms / ~1.3 s | Instant signs and stock directions, then tailored directions in about a second. |
| Risk | risk | `gemini-4-hydrogen` (`RISK_MODEL`) | ~3 s | Provisional warning signs on the newest line. |
| Notes | notes | `gemini-4-hydrogen` (`NOTES_MODEL`) | ~4–5 s | Facts with corrections ("$230, was $280"), each citing its turn, plus the open decision. |
| Planner | planner | `gemini-4-argon` (`PLANNER_MODEL`) | ~7–15 s | The next 3 directions with the exact words. Dropped if a newer caller line arrived first. |
| Supervisor | supervisor | `gemini-4-neon` (`SUPERVISOR_MODEL`) | ~6–8 s | Reads the whole call: confirms or removes signs, vetoes unsafe or pointless directions. |
| Merge and guard | app code | `server/src/brain/orchestrator.ts`, `catalog.ts` | – | Drops stale results, withdraws answered directions, scores risk with fixed weights, locks "High risk: confirmed", blocks unsafe words. |
| Alex's panel | app | `/desk` today, phone app next | – | Notes, signs, 3 directions, take over / take back. |
| Pre-render speech | tts | `gemini-3.8-flash-tts` (`TTS_MODEL`) | cached | Every suggested line is rendered as it arrives, so a tap starts speaking in ~10 ms. |
| Call review | review | `gemini-4-carbon` (`REVIEW_MODEL`) | ~5 s after hang-up | Summary, verdict, follow-up drafts. Evals are computed in code. |
| Follow-up agent | – | Gemini Managed Agents | **not built** | Today Carbon drafts the follow-ups. Acting on them (with Alex's approval) is the next step. |

Lanes that are slower than one caller line run one at a time, and a newer line queues a single rerun, so they never pile up. A lane that fails or times out adds nothing that turn; the call keeps going.

### Rules the code enforces (models only propose)

- **Score:** fixed weights per sign (money +3, code +4, failed family check +3, refused callback +3, third-party payment +2, ...; passing the family check −5). Low 0–3, Medium 4–7, High 8+.
- **Lock:** "High risk: confirmed" needs a supervisor-confirmed High score, a failed family check or refused callback, and a money or code request. Once locked, it stays locked.
- **Guard on everything the agent says:** no codes or 4–8 digit numbers, no approvals or payment promises, no notes, scores or "scam" talk, no speaking as Alex or family, never ends the call.
- **Floor:** every tap carries an action ID and a revision. Duplicates and stale taps are rejected. Take back and End always work. One question at a time.

## Run the server and test desk

```bash
cp .env.example .env   # add GEMINI_API_KEY (the server reads ../.env)
cd server && npm install && cd ..
cd web && npm install && cd ..
npm run dev:agent      # server on :8787, desk on :5173
```

- **Brain test desk:** `https://localhost:5173/desk`. Scripted calls stand in for the phone. Each scripted line goes through every lane. You can type live lines, take over, tap a direction (the agent speaks), press Esc to cut it off, then end the call to see the Carbon review.
- **Server:** `http://localhost:8787`

### Headless runs and evals

```bash
cd server
npx tsx --env-file=../.env scripts/replay.ts maya        # one call, full event log + review
npx tsx --env-file=../.env scripts/replay.ts all         # all 8 scenarios in parallel, eval table
npx tsx --env-file=../.env scripts/sim-twilio.ts maya    # fake Twilio call against the running server
```

Latest `replay.ts all` run: **56/56 evals pass**.
- Correct risk level and verdict on all 8 calls.
- Every scam that failed a check locked as "High risk: confirmed".
- No legitimate call was flagged.
- Each caller line got tailored directions before the next line.
- The agent spoke no codes and no private analysis.

`sim-twilio.ts` streams the scenario as real 8 kHz µ-law phone audio into `/twilio`. It joins as Alex's app, takes over, picks a direction, takes back mid-sentence and hangs up, so it exercises the whole phone path without a Twilio account.

## Phone (Twilio)

1. Expose the server, e.g. `ngrok http 8787`, and set `PUBLIC_HOST` to the ngrok host.
2. Point the Twilio number's voice webhook to `POST https://<PUBLIC_HOST>/twilio/voice`. It returns TwiML that `<Connect><Stream>`s the call to `wss://<PUBLIC_HOST>/twilio`.
3. What the server does on that stream:
   - **Inbound track:** transcribed as the caller.
   - **Outbound track, if streamed:** transcribed as Alex.
   - **Agent lines:** sent back into the call as µ-law audio, followed by a `mark`.
   - **Take back:** sends `clear`, which stops playback at once.
4. Alex's app joins the live call over WebSocket.

## API for the phone app

Connect to `ws(s)://<host>/ws` and send `{ "type": "join", "role": "app", "callId": "<CallSid>" | "latest" }`. Every event since the call started is replayed, then events stream live. The message types are in `shared/brain.ts`.

**Server → app**
- `turn.final`, `caption.interim`
- `risk.signal`, `risk.level`
- `notes.update`, `decision.open`
- `directions`, `directions.withdrawn`
- `agent.say`, `agent.cut`
- `state`, `lane.result`
- `call.ended`, `call.review`

**App → server.** Every tap carries `actionId` and `revision`.
- `control.delegate`, `control.takeback`
- `direction.pick`, `call.end`
- `desk.say` with speaker `alex`, to type a line

**HTTP**
- `GET /api/health`
- `POST /api/tts` with `{text, voice}`, returns WAV
- `POST /twilio/voice` (TwiML)
- `GET /api/calls/<id>/review`

## Server layout

```
shared/brain.ts               event contract (desk, phone app, server)
server/src/call.ts            LiveCall: brain + floor, revision, one-shot taps, agent voice, review on hang-up
server/src/brain/orchestrator.ts  fan-out, merge, stale/answered handling, risk scoring
server/src/brain/lanes.ts     risk, notes, planner/flash, supervisor prompts + output validation
server/src/brain/review.ts    Carbon summary/verdict/follow-ups + code evals
server/src/brain/catalog.ts   sign weights, lock rule, stock directions, guard
server/src/brain/rules.ts     regex fast lane
server/src/transcribe.ts      Gemini 3.5 Transcribe (Live) per track
server/src/twilio.ts          Twilio Media Streams bridge + TwiML
server/src/audio.ts           WAV, resampling, µ-law
server/src/scenarios.ts       8 scripted calls (4 scam, 4 legitimate/everyday)
server/src/desk.ts            desk/app socket sessions
web/src/pages/DeskPage.tsx    test desk UI
```

The earlier two-laptop WebRTC prototype is still in place: `/alex`, `/caller`, `server/src/room.ts`, `web/src/lib/{rtc,mixer}.ts`.

---

# Phone app

## Screens

| Screen | What it shows |
| --- | --- |
| **Live call** | Caller number, a large verdict card (Scam / Real / Unsure), warning signs, the transcript as chat bubbles, and Join · End · Block buttons. With no call in progress, it offers two demo calls. |
| **History** | Past screened calls with their verdict and reasons, plus blocked numbers. |
| **Setup** | Your phone number, the forwarding code for your carrier, the call check (Android) or Silence Unknown Callers steps (iPhone), and the server address. |

Family safe words are **turned off for now** (`FEATURES.safeWords` in [`src/constants/features.ts`](src/constants/features.ts)). Instead, the agent offers a callback on the caller's usual number. See [Later](#later).

## Run the phone app

You need Node LTS and Xcode (for iPhone) or the Android SDK with a USB-debugging phone (for Android). The app uses a **development build**, not Expo Go, because of the native Android call-screening module.

```bash
npm install
npx expo run:android      # Android phone over USB
npx expo run:ios          # iPhone simulator or a connected iPhone
```

To try the Live call screen without a server, open the app and tap **Play scam demo call** or **Play real demo call**.

### Configuration

Optional build-time defaults go in a `.env.local` file. Both values can also be set on the Setup screen.

```bash
EXPO_PUBLIC_SERVER_URL=https://your-server.example.com
EXPO_PUBLIC_AGENT_NUMBER=+15550000000   # the Twilio number; not a secret
```

The Twilio Account SID and Auth Token stay on the server. Never put them in the app, a committed env file, or the repository.

Push notifications need an EAS project. Run `npx eas-cli@latest init` once, then rebuild.

## Switch: phone calls or web simulation

Setup → **Agent server** has a switch:

| Setting | App listens to | Calls come from | Join · End · Block |
| --- | --- | --- | --- |
| **Phone calls** (default) | `twilio-server/` at the server address, over `/app` | Real calls forwarded to the Twilio number | Join rings your phone; End and Block go to the server |
| **Web simulation** | Abhi's `server/` (default `http://localhost:8787`), over `/ws` | Calls started on the web test desk (`https://localhost:5173/desk`) | Join takes the call back from the agent; End hangs up; Block is saved on the phone only |

To test with the simulation: run `npm run dev:agent`, set the switch to **Web simulation**, and start a scenario on the desk. The call shows up on the Live call tab within about 2 seconds. On a real phone, use your computer's network address instead of `localhost`. The adapter is [`src/lib/simulation.ts`](src/lib/simulation.ts); it turns the server's `shared/brain.ts` events into the app's events, so both modes use the same screens.

To change the default without tapping, set `EXPO_PUBLIC_BACKEND=web` (and optionally `EXPO_PUBLIC_SIM_SERVER_URL`) in `.env.local`. A choice saved in Setup wins.

## Phone app: server contract

This is what the app expects from `twilio-server/`. It is separate from the agent server's [`/ws` API](#api-for-the-phone-app), which is for the web desk.

### WebSocket: server → app

The app connects to `wss://<server>/app?phone=<your number>`. Each frame is one JSON object with a `type` field:

| `type` | Fields |
| --- | --- |
| `call.started` | `callId`, `from` (the caller's number) |
| `transcript` | `callId`, `turn`, `speaker` (`"caller"` / `"agent"`), `text` |
| `signal` | `callId`, `label` (e.g. `"asked for money"`), `turn` |
| `verdict` | `callId`, `verdict` (`"scam"` / `"real"` / `"unsure"`), `reasons` (list of strings) |
| `call.ended` | `callId` |

```json
{ "type": "verdict", "callId": "CA123", "verdict": "scam", "reasons": ["Asked for gift cards"] }
```

### HTTP: app → server

All requests are `POST` with a JSON body. Every route is defined in [`src/lib/server.ts`](src/lib/server.ts), so changing a path takes one edit.

| Route | Body | What the server does |
| --- | --- | --- |
| `/api/device` | `phone`, `pushToken`, `platform` | Saves where to send pushes for this phone |
| `/api/safe-words` | `phone`, `safeWords: [{name, word}]` | Saves the safe words the agent checks (HTTPS only). Not called while safe words are off. |
| `/api/calls/:callId/join` | `phone` | Twilio rings `phone` and bridges it into the call |
| `/api/calls/:callId/end` | – | Hangs up, then sends `call.ended` |
| `/api/block` | `phone`, `number`, `callId` | Adds `number` to the block list |

### Push notification

When a screened call starts, the server sends an Expo push to the device's `pushToken`:

```json
{ "to": "<pushToken>", "title": "Unknown caller", "body": "Agent is screening", "data": { "callId": "CA123" }, "channelId": "screened-calls" }
```

Tapping it opens the Live call screen.

## How calls reach the agent

### Forwarding (both platforms)

The Setup screen builds the conditional-forwarding code for the Twilio number. Android opens the dialer with the code filled in; iPhone can't dial `*` codes from a link, so it offers a Copy button.

| Carrier | Turn on | Turn off |
| --- | --- | --- |
| Verizon | `*71` + number | `*73` |
| AT&T / T-Mobile | `**004*1` + number + `#` | `##004#` |

**Turn forwarding off after the event.**

### Android: call check

[`modules/call-screener`](modules/call-screener) is a local Expo module that provides a `CallScreeningService`. Uno ReVoice must hold the call-screening role (Setup → *Make Uno ReVoice the call screener*) and have contacts access.

- A caller in your contacts: the phone rings normally.
- An unknown or withheld number: the service declines the call without a notification, and the carrier forwards it to the agent.
- Android 11+: a call whose caller-ID verification failed goes to the agent even if the number matches a contact.
- Without contacts access, every call rings normally, so no family call is ever lost.

The Setup screen shows the last decision, which lets you check on a real phone whether a declined call actually forwards. Some carriers send declined calls to voicemail as "busy", and conditional forwarding depends on that.

### iPhone: setting, no code

iOS doesn't let apps decide per call. Go to **Settings → Apps → Phone → Screen Unknown Callers → Silence**. Silenced calls go to "voicemail", which forwarding sends to the agent. Don't choose "Ask Reason for Calling": with that option, Apple's own screener answers first.

## Known limits

- **Faked contact numbers.** A scammer showing a contact's number (for example "Mom") rings normally unless the network marks the caller ID as failed (Android 11+ only). Calls marked "not verified" still ring. On iPhone, every contact rings.
- **No sign-in.** The app's WebSocket identifies the user only by `?phone=`. Fine for a demo; a real release needs a per-device token.
- **Only Android decides per call.** iPhone relies on Silence Unknown Callers, so the caller hears a few rings before forwarding.
- **Twilio free trial.** Only verified numbers can call in or be called, and each call starts with a trial message and a key press.

## Later

- [ ] **Finish `twilio-server/` for the phone app.** Serve every route in the [phone app contract](#phone-app-server-contract) and plug in Gemini.
- [ ] **Bring back family safe words.** Set `FEATURES.safeWords` to `true` in [`src/constants/features.ts`](src/constants/features.ts). The Setup section, secure storage, upload (`/api/safe-words`) and on-screen masking are already built. The server then needs to store them and give them to the agent, which asks callers who claim to be family. They are stored in the phone's secure storage, sent only over HTTPS, and replaced with `•••` if they appear in a transcript or verdict.

## Phone app layout

```
src/app/            index.tsx (Live call), history.tsx, setup.tsx, _layout.tsx (tabs)
src/lib/            protocol, call state, WebSocket, demo calls, server API, storage, notifications
src/components/     verdict card, transcript bubbles, brand, shared UI
src/constants/      theme colors, feature switches (features.ts)
modules/call-screener/  Android CallScreeningService + role request (Kotlin)
assets/brand/       logo SVGs (app icons in assets/images are rendered from these)
```
