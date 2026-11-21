# Uno ReVoice

A three-party call where the recipient (Alex) can hand the conversation to a clearly identified AI assistant, steer its next question in private, and take the call back in one tap. Gemini 4 NYC Hackathon.

## Run it

```bash
cp .env.example .env   # add GEMINI_API_KEY
npm install
npm run dev
```

- Server: `http://localhost:8787` (WebSocket `/ws`, `POST /api/tts`, `GET /api/health`)
- Web: `https://<your-LAN-IP>:5173` (self-signed cert; click through the warning once on each laptop)

Laptop 1 opens `/alex`, laptop 2 opens `/caller`. Both use headphones. Add `?call=<name>` to run separate calls.

## Layout

```
shared/protocol.ts   wire protocol + which events may reach the caller
server/src/room.ts   call state: floor, revision, one-shot action IDs, private/public filter
server/src/tts.ts    Gemini 3.1 Flash TTS → WAV, cached by text
web/src/lib/mixer.ts Alex's Web Audio graph (mic gain + assistant gain → outgoing track)
web/src/lib/rtc.ts   audio-only WebRTC (Alex offers, caller answers)
web/src/pages/       AlexPage (call desk), CallerPage (caller's side)
```

## Rules the code enforces

- The assistant is mixed into **Alex's** outgoing line. Takeback is a local gain change, done before the server is told.
- Every control carries an action ID and revision. The server consumes each once and rejects duplicates and stale ones. Takeback and end are never refused.
- Any clip requested under an old revision is discarded, never played.
- `CallRoom.send` drops every non-public event addressed to the caller. The caller page counts private events received (must be 0).

## Kickoff voice checks

| Check | Pass |
|---|---|
| Two laptops, two-way audio | Both hear each other, no echo on headphones |
| Clip into Alex's line | Caller hears it, Alex hears it |
| Takeback mid-clip ×5 | "Takeback → caller silent" under 250 ms each time |
| Pre-render | Clip ready before Alex usually taps |
