# Uno ReVoice

Uno ReVoice is a phone app that lets an AI agent answer calls from unknown numbers for you. The agent asks the caller who they are and checks them for scam signs. You watch the call live and can join, end or block it.

```
Unknown caller ──► your phone declines it (Android) / silences it (iPhone)
                   └─► carrier forwards it to the Twilio number
                        └─► the agent answers ──► server ──WebSocket──► this app
```

## Status

| Part | State |
| --- | --- |
| Phone app (this repo) | Built: Live call, History and Setup screens, demo calls, Android call check, forwarding codes, push handling. |
| Agent server | **Not connected yet.** The team's server is on the `main` branch (`server/`). The app expects the contract below; the two still need to be matched up. |
| Gemini agent (voice + scam check) | Not connected yet. It runs on the server. |

Until the app is connected to the server, only the demo calls work.

## Screens

| Screen | What it shows |
| --- | --- |
| **Live call** | Caller number, a large verdict card (Scam / Real / Unsure), warning signs, the transcript as chat bubbles, and Join · End · Block buttons. With no call in progress, it offers two demo calls. |
| **History** | Past screened calls with their verdict and reasons, plus blocked numbers. |
| **Setup** | Your phone number, the forwarding code for your carrier, the call check (Android) or Silence Unknown Callers steps (iPhone), and the server address. |

Family safe words are **turned off for now** (`FEATURES.safeWords` in [`src/constants/features.ts`](src/constants/features.ts)). Instead, the agent offers a callback on the caller's usual number. See [Later](#later).

## Run it

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

The Twilio Account SID and Auth Token stay on the server. Never put them in this app, an env file, or the repository.

Push notifications need an EAS project. Run `npx eas-cli@latest init` once, then rebuild.

## Server contract

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
- **No sign-in.** The WebSocket identifies the user only by `?phone=`. Fine for a demo; a real release needs a per-device token.
- **Only Android decides per call.** iPhone relies on Silence Unknown Callers, so the caller hears a few rings before forwarding.
- **Twilio free trial.** Only verified numbers can call in or be called, and each call starts with a trial message and a key press.

## Later

- [ ] **Bring back family safe words.** Set `FEATURES.safeWords` to `true` in [`src/constants/features.ts`](src/constants/features.ts). The Setup section, secure storage, upload (`/api/safe-words`) and on-screen masking are already built. The server then needs to store them and give them to the agent, which asks callers who claim to be family. They are stored in the phone's secure storage, sent only over HTTPS, and replaced with `•••` if they appear in a transcript or verdict.

## Project layout

```
src/app/            index.tsx (Live call), history.tsx, setup.tsx, _layout.tsx (tabs)
src/lib/            protocol, call state, WebSocket, demo calls, server API, storage, notifications
src/components/     verdict card, transcript bubbles, brand, shared UI
src/constants/      theme colors, feature switches (features.ts)
modules/call-screener/  Android CallScreeningService + role request (Kotlin)
assets/brand/       logo SVGs (app icons in assets/images are rendered from these)```
