# Uno ReVoice

When a call comes in, Alex can hand it to a clearly identified AI assistant, steer its next line in private, and take the call back in one tap. Several Gemini models listen in parallel: they flag scam warning signs, keep notes, and suggest the next line. App code makes every decision that matters. Gemini 4 NYC Hackathon.

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
| Critic | critic | `gemini-4-neon`, high thinking (`CRITIC_MODEL`) | ~20–60 s after hang-up | Grades the call, finds missed or late signs and badly timed questions, writes lessons into the playbook the next call uses. |
| Follow-up agent | – | Gemini Managed Agents | **not built** | Today Carbon drafts the follow-ups. Acting on them (with Alex's approval) is the next step. |

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

## Run it

```bash
cp .env.example .env   # add GEMINI_API_KEY
npm install
npm run dev
```

- **Brain test desk:** `http://localhost:5173/desk`. Scripted calls stand in for the phone. Each scripted line goes through every lane. You can type live lines, take over, tap a direction (the agent speaks), press Esc to cut it off, then end the call to see the Carbon review.
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

## Review phase: the agent learns after every call

After hang-up the call goes through four steps. Code makes every decision that changes behaviour; the model only proposes.

| Step | What | Where |
|---|---|---|
| Record | The call's event log becomes a `CallRecord`: transcript, the meter after each caller line, every card shown, what the agent said and from which card. | `server/src/learn/record.ts` |
| Judge (code) | Right verdict? False alarm? Caller line where it reached High, where money came up, where the first identity check or callback was suggested and asked, repeated questions, leaks. | `judge()` in `record.ts` |
| Critic | **Gemini 4 Neon, high thinking** (`CRITIC_MODEL`). Grades classification, questioning, timing and safety 1–5, writes findings that cite turns, and proposes up to 3 general lessons. | `server/src/learn/critic.ts` |
| Playbook | Lessons are validated, merged (duplicates reinforce, minor ones wait for a second sighting), capped at 10 active and versioned. Weight changes must pass a replay gate on every stored labeled call. | `server/src/learn/playbook.ts`, `pipeline.ts` |

What a lesson can change, enforced in code:
- `prefer_direction`: when these signs are present, this card is the Suggested one (stock and model boards).
- `adjust_weight`: a sign's weight moves by ±1, at most ±2 in total, and a warning sign never becomes reassuring.
- `planner_hint` / `detection_hint`: text added to the planner, risk and supervisor prompts.

Lessons can never touch the safety rules: unsafe wording is refused, and the say-guard still checks every spoken line.

The next call starts from the current playbook (`LEARN=0` turns this off). The desk shows the critic's report, the label buttons ("Was this a scam?") and the playbook change under the call review.

```bash
cd server
npm run test:learn                          # offline checks, no Gemini calls
npm run learn -- --rounds 3 --fresh         # simulated calls → critic → playbook, rounds with a held-out set
npm run learn -- --show                     # print the playbook
npm run learn -- --rollback 2               # make v2 current again
```

`learn` runs simulated callers (`personas.ts`) that answer what the agent actually asks, with autopilot-Alex tapping the Suggested card, so a better question at a better time changes the call. Train personas feed the critic; held-out personas are only scored. A round's playbook is rolled back if held-out calls get a new false alarm, catch fewer scams, leak anything or get worse questioning grades.

Learning data uses local JSON files under `server/data/learning/` by default. Set `SUPABASE_DB_URL` to share call reviews, playbook versions and eval results through Supabase Postgres. Each new call reads the current version and uses it for the duration of that call.

### Supabase setup

1. In a Supabase project, open **Connect** and copy the **Session pooler** Postgres URI into `SUPABASE_DB_URL` in the server's root `.env`. Use the database password in the URI and keep it on the server.
2. From the repository root, create the learning tables and optionally seed an empty database from the existing local history:

   ```bash
   npm run learning-db -w server -- migrate
   npm run learning-db -w server -- import
   npm run learn -w server -- --show
   ```

3. Restart the server with the same environment. It will store new reviews in Supabase and load feedback from there at the start of each call.

The import copies reviewed calls, every saved playbook, the current version, and JSON eval reports. It runs as one transaction and requires an empty learning database, so it cannot replace existing shared history. The tables live in the private `revoice` schema and the browser talks to the app server.

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

## Layout

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
