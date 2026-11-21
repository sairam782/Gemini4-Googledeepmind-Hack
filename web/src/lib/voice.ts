/** Plays Gemini TTS clips through Web Audio so takeback can stop them instantly. */
export class VoicePlayer {
  readonly ctx = new AudioContext({ latencyHint: "interactive" });
  private cache = new Map<string, Promise<AudioBuffer>>();
  private current: AudioBufferSourceNode | null = null;

  clip(text: string, voice: string): Promise<AudioBuffer> {
    const key = `${voice}|${text}`;
    let p = this.cache.get(key);
    if (!p) {
      p = (async () => {
        const r = await fetch("/api/tts", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text, voice }),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `TTS ${r.status}`);
        return this.ctx.decodeAudioData(await r.arrayBuffer());
      })();
      this.cache.set(key, p);
      p.catch(() => this.cache.delete(key));
    }
    return p;
  }

  /** Plays a buffer; resolves when it ends or is stopped. */
  play(buf: AudioBuffer): Promise<"ended" | "stopped"> {
    this.stop();
    void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    this.current = src;
    return new Promise((resolve) => {
      src.onended = () => {
        const wasCurrent = this.current === src;
        if (wasCurrent) this.current = null;
        resolve(wasCurrent ? "ended" : "stopped");
      };
      src.start();
    });
  }

  get playing() {
    return this.current !== null;
  }

  /** Returns ms spent silencing (local). */
  stop(): number {
    const t0 = performance.now();
    const s = this.current;
    this.current = null;
    if (s) {
      try {
        s.stop();
      } catch {}
      s.disconnect();
    }
    return Math.round(performance.now() - t0);
  }
}
