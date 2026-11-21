# Uno ReVoice

When a call comes in from an unknown number, Uno ReVoice hands it to a clearly identified AI assistant. The assistant asks the caller who they are and checks them for scam signs while Alex watches live, steers its next line in private, and can take the call back, end it or block the number in one tap. Several Gemini models listen in parallel: they flag scam warning signs, keep notes, and suggest the next line. App code makes every decision that matters. Gemini 4 NYC Hackathon.

```
Unknown caller ──► Alex's phone declines it (Android) / silences it (iPhone)
                   └─► carrier forwards it to the Twilio number
                        └─► the agent answers ──► server ──WebSocket──► phone app
```

**Demo video:** [`demo/uno-revoice-demo.mp4`](demo/uno-revoice-demo.mp4) (55 s), with stills in [`demo/screenshots/`](demo/screenshots).

## What's in this repo

| Folder | What it is | Run it |
| --- | --- | --- |
| `/` (root) | **Phone app** (Expo / React Native): Live call, History, Setup, Android call check | `npm install`, then `npx expo run:ios` or `npx expo run:android` |
| `server/` | **Agent server** (TypeScript): Twilio bridge, Gemini transcription, the multi-model brain, call review | `cd server && npm install && npm run dev` |
| `web/` | **Brain test desk** (Vite + React) for the server | `cd web && npm install && npm run dev` |
| `shared/` | Event contract shared by `server/` and `web/` (`shared/brain.ts`) | – |
| `twilio-server/` | **Phone server (Live mode)**: answers forwarded calls on the SignalWire number with a Gemini Live agent and talks to the phone app over `/app` | `cd twilio-server && npm install && npm start` |

Each folder installs on its own. The root `package.json` belongs to the phone app, so there is no npm workspace; `web/` uses React 18 and the app uses React 19, and they must not share `node_modules`. From the root, `npm run dev:agent` starts `server/` and `web/` together (install both first).

## Status

| Part | State |
| --- | --- |
| Phone app | Built: Live call, History and Setup screens, demo calls, Android call check, forwarding codes, push handling. |
| Agent server + brain | Built in `server/`: 56/56 evals pass on the 8 scripted calls (see below). |
| **Two servers, on purpose** | **Live** mode talks to `twilio-server/` (SignalWire + Gemini Live) using the [phone app contract](#phone-app-server-contract). **Simulation** mode and the web test desk talk to `server/` over `/ws` with `shared/brain.ts` events. See [Modes](#modes). |

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
| Follow-up agent | followup | `gemini-4-neon` (`FOLLOWUP_MODEL`) | ~3–6 s after review | `@google/genai` function calling turns review suggestions into up to 4 guarded action proposals Alex approves one by one. |

How the directions board fills in on each caller line:

1. **~1 ms:** stock cards from the rules. Their speech is pre-rendered when the call starts.
2. **~1.3 s:** tailored cards from Flash-Lite.
3. **~7–15 s:** Argon's cards, if no newer caller line arrived first.

Even when Argon is late, it writes a one-sentence **strategy** that the next Flash-Lite pass follows. For example: "caller dodged the family check; push the callback, then decline". The slow model always contributes something.

While the agent has the floor, tailored cards for the same caller line are not swapped under Alex's finger. The upgrade is held until Alex takes back.

We benchmarked Hydrogen as the fast lane, to keep the live path all Gemini 4. With thinking low it took 4.1–5.0 s against Flash-Lite's ~1.3 s, and with thinking off most calls timed out. So Flash-Lite stays; `FLASH_MODEL` flips it.

Lanes that are slower than one caller line run one at a time, and a newer line queues a single rerun, so they never pile up. A lane that fails or times out adds nothing that turn; the call keeps going.

### Rules the code enforces (models only propose)

- **Score:** fixed weights per sign (money +3, code +4, failed family check +3, refused callback +3, third-party payment +2, ...; passing the family check −5). Low 0–3, Medium 4–7, High 8+.
- **Lock:** "High risk: confirmed" needs a supervisor-confirmed High score, a failed family check or refused callback, and a money or code request. Once locked, it stays locked.
- **Guard on everything the agent says:** no codes or 4–8 digit numbers, no approvals or payment promises, no notes, scores or "scam" talk, no speaking as Alex or family, never ends the call.
- **Floor:** every tap carries an action ID and a revision. Duplicates and stale taps are rejected. Take back and End always work. One question at a time.

### Follow-up agent

After hang-up and Carbon's review, `server/src/brain/followup.ts` (`proposeFollowUps`, `FOLLOWUP_MODEL`, default `gemini-4-neon`) turns the review's suggested next steps into up to 4 concrete proposals using **`@google/genai` function calling** (`generateContent` with `functionDeclarations`). We chose `@google/genai` function calling rather than Gemini Managed Agents (the Interactions API / `antigravity-preview-09-2026` remote Linux sandbox), which requires `@google/genai` v2.3+ and is designed for autonomous remote sandbox execution rather than low-latency, locally guarded human-in-the-loop proposals.

- **Proposal-only tools:** `draft_text_message` (to a saved contact), `draft_report` (`bank` | `ftc` | `police` | `other`), `block_number`, and `set_reminder`. There are no tools to send money, share codes, or call a scammer back.
- **Guard:** every draft body and reminder text is checked for 4–8 digit codes, payment promises, and callbacks to a scammer's number; failures are dropped before reaching Alex.
- **Approval required:** `followup.proposed` lists the actions; nothing executes until Alex sends `followup.approve` (or `followup.dismiss`) over the socket, even after the call has ended. Each `followupId` runs at most once: `block_number` adds the number to the in-memory blocklist (`server/src/blocklist.ts`), `set_reminder` saves it in memory, and `draft_*` returns the final text as ready to send.

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
npm test                                                  # unit tests: guard, rules, scoring/lock, audio, retry
cd server
npx tsx --env-file=../.env scripts/replay.ts maya        # one call, full event log + review
npx tsx --env-file=../.env scripts/replay.ts all         # all 8 scenarios in parallel, eval table
npx tsx --env-file=../.env scripts/replay.ts live all    # fully automatic: Gemini plays the caller, the agent auto-speaks
npx tsx --env-file=../.env scripts/sim-twilio.ts maya    # fake Twilio call against the running server
```

Latest runs (8 evals per call, incl. tone): `replay.ts all` **64/64**, `replay.ts live` **64/64** across all 8 scenarios (the live caller improvises, so live runs can vary).

**Live demo with your voice (desk → "Caller: me, on the mic").** Pick a scenario (it sets the caller ID: unknown number, contact, etc.), choose *Caller: me, on the mic*, press **Start call** and allow the mic. Talk as the scammer, the family member or anyone. Gemini Live transcribes you with captions as you speak, and every line runs through the full brain. Tap **Agent take over** whenever you like: the agent answers you out loud, either the card you tap or its most confident card about 2.5 s after you stop talking. It never starts while you are mid-sentence: the server watches your mic level and the live captions, joins a sentence you paused in, and waits until you have been quiet for 1 s (`MIC_AUTO_SPEAK_MS`, `STT_SILENCE_MS`, `MIC_MERGE_MS`, `MIC_VOICE_RMS`). Voices stream (first sound ~0.7 s instead of 3-5 s for a full render), and ~1 s after you stop the agent gives a short "Mm-hm." / "Okay." while its reply loads (`AGENT_ACKS=0` turns that off). Talk over it to cut it off; **Take back** (Esc) returns the floor. Headphones are best; with speakers, browser echo cancellation plus a server echo filter keep the agent's own voice out of your transcript. `npx tsx --env-file=../.env scripts/sim-mic.ts maya` runs the same path headless with synthetic speech; `maya-pause` adds hesitations mid-sentence and counts any overlap.

**Live caller and auto-speak.** The desk defaults to *Live caller*: Gemini 3.5 Flash-Lite (`CALLER_MODEL`, ~0.5 s a reply) plays the scenario's persona from `server/src/scenarios.ts` and answers whatever the agent or Alex says. It sees only the spoken transcript. Once Alex hands over, the agent says its highest-confidence direction on its own if Alex doesn't tap within `AUTO_SPEAK_MS` (default 4000). Flash-Lite cards land at ~1.3 s (p90 ~2.4 s) and their speech is pre-rendered by ~3-4 s, which still leaves Alex 2-3 s to override. If only stock cards are up, it waits up to 4 s more for a tailored one. Near-repeats of earlier agent lines are dropped (a genuine repeat becomes "Like I said, ..."), and the post-call review scores the agent's tone (Carbon 1-5 plus code checks for accusing, shouting and repeated lines). The agent voice is Sulafat, the calmest and warmest in `server/scripts/check-tone.ts`, which has Gemini listen to each candidate voice and score it (TTS style prompts get read aloud, so tone comes from the voice). Every direction carries a `confidence` (0-1). The app gets `agent.autoPick {directionId, inMs}` for a countdown, and `agent.say` carries `auto: true` when nobody tapped.
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

### Twilio security

Set `TWILIO_AUTH_TOKEN` to enforce request verification:
- `POST /twilio/voice` verifies `X-Twilio-Signature` (`HMAC-SHA1` over `https://<PUBLIC_HOST|Host><req.url>` + sorted POST params) and returns `403` on mismatch.
- The returned TwiML embeds `<Parameter name="sig"/>` (`HMAC-SHA256` of `CallSid`), which `/twilio` verifies on the stream `start` event before creating a `LiveCall`.
- If `TWILIO_AUTH_TOKEN` is unset, requests are allowed for local testing and the server logs `Twilio signature check OFF` at startup. Run `cd server && npx tsx scripts/check-twilio-auth.ts` to self-test against Twilio's worked example.

### Call history

Completed call reviews are saved as JSON to `server/data/calls/<callId>.json` (override the base dir with `DATA_DIR`; set `SAVE_CALLS=0` to disable, as `scripts/replay.ts` does). `GET /api/calls` returns live and saved calls newest-first, and `GET /api/calls/<id>/review` falls back to disk after a call leaves memory.

## API for the phone app

Connect to `ws(s)://<host>/ws` and send `{ "type": "join", "role": "app", "callId": "<CallSid>" | "latest", "token": "<APP_TOKEN>" }`. A missing or wrong token closes the socket with code 4401. With no `APP_TOKEN` set, only the server's own machine may join. HTTP calls under `/api/calls` need `Authorization: Bearer <APP_TOKEN>`. Every event since the call started is replayed, then events stream live. The message types are in `shared/brain.ts`.

**Server → app**
- `turn.final`, `caption.interim`
- `risk.signal`, `risk.level`
- `notes.update`, `decision.open`
- `directions`, `directions.withdrawn`
- `agent.say`, `agent.cut`
- `state`, `lane.result`
- `call.ended`, `call.review`
- `followup.proposed`, `followup.result`

**App → server.** Live-call taps carry `actionId` and `revision`; follow-up approvals work after hang-up.
- `control.delegate`, `control.takeback`
- `direction.pick`, `call.end`
- `desk.say` with speaker `alex`, to type a line
- `followup.approve`, `followup.dismiss`

**HTTP**
- `GET /api/health`
- `POST /api/tts` with `{text, voice}`, returns WAV
- `POST /twilio/voice` (TwiML)
- `GET /api/calls` (live + saved calls, newest first)
- `GET /api/calls/<id>/review` (live or saved)

## Server layout

```
shared/brain.ts               event contract (desk, phone app, server)
server/src/call.ts            LiveCall: brain + floor, revision, one-shot taps, agent voice, review + follow-ups on hang-up
server/src/brain/orchestrator.ts  fan-out, merge, stale/answered handling, risk scoring
server/src/brain/lanes.ts     risk, notes, planner/flash, supervisor prompts + output validation
server/src/brain/review.ts    Carbon summary/verdict/follow-ups + code evals
server/src/brain/followup.ts  Neon function-calling follow-up agent + approval executors
server/src/brain/catalog.ts   sign weights, lock rule, stock directions, guard
server/src/brain/rules.ts     regex fast lane
server/src/blocklist.ts       in-memory blocklist populated after Alex approves block_number
server/src/transcribe.ts      Gemini 3.5 Transcribe (Live) per track
server/src/twilio.ts          Twilio Media Streams bridge + TwiML
server/src/twilioAuth.ts      Twilio webhook HMAC-SHA1 and stream HMAC-SHA256 verification
server/src/store.ts           JSON call history persistence and listing
server/src/audio.ts           WAV, resampling, µ-law
server/src/scenarios.ts       8 scripted calls (4 scam, 4 legitimate/everyday)
server/src/desk.ts            desk/app socket sessions
web/src/pages/DeskPage.tsx    test desk UI
```

The earlier two-laptop WebRTC prototype is still in place: `/alex`, `/caller`, `server/src/room.ts`, `web/src/lib/{rtc,mixer}.ts`.

---

# Phone app

## Brand

Navy ink `#141A33`, red `#C8372D` (the "Re" and the phone) and warm cream `#FFF4E8` with white cards. Source files are in [`assets/brand/`](assets/brand) (rounded icon, square icon, wordmark); the app icons, Android adaptive icons and splash in `assets/images/` are rendered from them. Colours live in [`src/constants/theme.ts`](src/constants/theme.ts). Green is used only to mean safe / real / connected.

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

## Modes

Setup → **Mode** (top of the screen). A small badge on the Live call screen shows the current mode.

| Mode | Calls come from | Server | Buttons on the Live call screen |
| --- | --- | --- | --- |
| **Demo** | Scripted scam and real calls ([`src/lib/demo.ts`](src/lib/demo.ts)) | None, works offline: the backup during judging | Start scam / real demo call |
| **Simulation** | A Gemini-played caller on the team's agent server (`server/`), started from the phone or the web desk | `http://localhost:8787` (Setup → Simulation server address) | Incoming scam / real call |
| **Live** (default) | Real calls forwarded to the SignalWire number +1 208 485 0663 | `twilio-server/` via ngrok (Setup → Phone server address) | – (calls arrive on their own) |

All three feed the same events (`call.started`, `transcript`, `signal`, `verdict`, `call.ended`) into the same Live call screen. **Join · End · Block** work in every mode; **Steer** (a private instruction for the agent's next line, `POST /api/calls/:callId/say`) appears on Live calls. The team server has no free-text steering, so Simulation calls don't show it.

### Simulation

1. Put `GEMINI_API_KEY` in the root `.env` and run `npm run server`.
2. Setup → **Simulation**. On the Live call tab, tap **Incoming scam call** or **Incoming real call** (or open `unorevoice:///?simulate=scam`).

Gemini plays the caller and reacts to what it hears, the agent answers right away, and the phone plays both voices. Calls started on the web desk show up too. On a real phone, use your computer's network address (or an ngrok address) and fill in **App token** with the server's `APP_TOKEN`. Code: [`src/lib/phone-sim.ts`](src/lib/phone-sim.ts), [`src/lib/voice.ts`](src/lib/voice.ts), [`src/lib/simulation.ts`](src/lib/simulation.ts).

### Live

See [`twilio-server/README.md`](twilio-server/README.md): run the server, `ngrok http 3000`, point the SignalWire number at `https://<ngrok-host>/voice`, then Setup → **Live** with `https://<ngrok-host>` and **Save and connect**.

To change the default mode without tapping, set `EXPO_PUBLIC_MODE=demo|simulation|live` in `.env.local`. A choice saved in Setup wins.

## Phone app: server contract

This is what the app expects from `twilio-server/` (Live mode). It is separate from the agent server's [`/ws` API](#api-for-the-phone-app), which is for the web desk.

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
| `/api/calls/:callId/say` | `text` | Steering: a private instruction the agent follows in its next line |
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

- [ ] **Test Live mode end to end** with a real forwarded call (see `twilio-server/README.md`).
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
