# Demo video

**[uno-revoice-demo.mp4](uno-revoice-demo.mp4)**: 58 s, 1920×1080. The phone app in Demo mode, with an ElevenLabs voiceover (voice "Sarah") and subtle sound effects.

It covers: home screen → a scam call screened live (transcript, warning signs) → **SCAM** verdict → Block → a real caller → **REAL** verdict → call history with reasons and blocked numbers → Setup with the Demo / Simulation / Live modes.

Stills for slides are in [`screenshots/`](screenshots) (full iPhone resolution).

## Rebuild it

1. Record the simulator. Start the dev server with the tour on, open the app, and record:
   ```bash
   EXPO_PUBLIC_DEMO_TOUR=1 npx expo start --localhost --dev-client
   xcrun simctl status_bar booted override --time 9:41 --batteryState charged --batteryLevel 100
   xcrun simctl io booted recordVideo --codec=h264 demo/work/raw.mov   # Ctrl+C after the tour ends
   ```
   Open the app with `exp+uno-revoice://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081&__expo_disable_fab=1` so Expo's dev button stays hidden. The tour ([`src/lib/demo-tour.ts`](../src/lib/demo-tour.ts)) plays itself and never shows your real phone number.
2. Voice and sound effects (needs `ELEVENLABS_API_KEY` in the root `.env`, never in a committed file):
   ```bash
   node --env-file=.env demo/make-audio.mjs
   ```
3. Edit: set `START` in `make-video.mjs` to the second where the tour's home screen appears in `raw.mov`, then:
   ```bash
   node demo/make-video.mjs
   ```

`demo/work/` holds the raw recording and audio clips and is git-ignored.
