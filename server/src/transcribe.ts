import { GoogleGenAI, Modality, type Session, EndSensitivity } from "@google/genai";

const MODEL = process.env.TRANSCRIBE_MODEL || "gemini-3.5-transcribe-live";
const ai = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const MAX_SESSION_MS = 9 * 60_000; // Live sessions cap at 10 minutes; roll over before that

export interface TranscriberEvents {
  interim(text: string): void;
  final(text: string): void;
  error?(message: string): void;
}

/**
 * Streams one speaker's 16 kHz PCM to Gemini 3.5 Transcribe (Live API).
 * The model's own voice-activity detection ends each line; `inputTranscription` is the final text,
 * `interimInputTranscription` the running words. One instance per phone track, so no diarization needed.
 */
export class Transcriber {
  private session: Session | null = null;
  private connecting: Promise<void> | null = null;
  private openedAt = 0;
  private closed = false;
  private queue: string[] = [];
  private failures = 0;
  private retryAt = 0; // after a failed connect, wait before trying again (1 s, 2 s, 4 s ... max 15 s)

  constructor(private on: TranscriberEvents, readonly label = "caller") {}

  private connect() {
    if (!ai) {
      // Report once and drop audio; never throw into the socket handler.
      if (!this.closed) this.on.error?.(`${this.label} transcriber: GEMINI_API_KEY is not set`);
      this.closed = true;
      this.queue = [];
      return;
    }
    this.openedAt = Date.now();
    this.connecting = ai.live
      .connect({
        model: MODEL,
        config: {
          responseModalities: [Modality.TEXT],
          inputAudioTranscription: {},
          // Commit the caller's line after a short pause instead of the default, so the agent answers sooner.
          realtimeInputConfig: {
            automaticActivityDetection: {
              endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_HIGH,
              silenceDurationMs: Number(process.env.STT_SILENCE_MS ?? 500),
            },
          },
        },
        callbacks: {
          onmessage: (m) => {
            const sc = m.serverContent as
              | { inputTranscription?: { text?: string }; interimInputTranscription?: { text?: string } }
              | undefined;
            const fin = sc?.inputTranscription?.text?.trim();
            if (fin) return this.on.final(fin);
            const mid = sc?.interimInputTranscription?.text?.trim();
            if (mid) this.on.interim(mid);
          },
          onerror: (e) => this.on.error?.(`${this.label} transcriber: ${e.message}`),
          onclose: () => {
            this.session = null;
            this.connecting = null;
          },
        },
      })
      .then((s) => {
        if (this.closed) return s.close(); // the call ended while connecting
        this.failures = 0;
        this.session = s;
        for (const chunk of this.queue.splice(0)) this.sendNow(chunk);
      })
      .catch((e) => {
        this.connecting = null;
        this.failures++;
        this.retryAt = Date.now() + Math.min(15_000, 1000 * 2 ** (this.failures - 1));
        this.on.error?.(`${this.label} transcriber failed to connect: ${(e as Error).message}`);
      });
  }

  /** `pcm16k`: 16-bit little-endian mono PCM at 16 kHz. */
  push(pcm16k: Buffer) {
    if (this.closed) return;
    const b64 = pcm16k.toString("base64");
    if (this.session && Date.now() - this.openedAt > MAX_SESSION_MS) {
      this.session.close(); // roll over; the next push reconnects
      this.session = null;
      this.connecting = null;
    }
    if (this.session) return this.sendNow(b64);
    this.queue.push(b64);
    if (this.queue.length > 500) this.queue.shift();
    if (!this.connecting && Date.now() >= this.retryAt) this.connect(); // audio keeps queueing meanwhile
  }

  private sendNow(b64: string) {
    this.session?.sendRealtimeInput({ audio: { data: b64, mimeType: "audio/pcm;rate=16000" } });
  }

  close() {
    this.closed = true;
    this.queue = [];
    this.session?.close();
    this.session = null;
  }
}
