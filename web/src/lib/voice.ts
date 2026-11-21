/** Plays Gemini TTS through Web Audio so takeback can stop it instantly. */
export class VoicePlayer {
  readonly ctx = new AudioContext({ latencyHint: "interactive" });
  private cache = new Map<string, Promise<AudioBuffer>>();
  private ready = new Map<string, AudioBuffer>(); // clips already rendered: play with no wait
  private sources: AudioBufferSourceNode[] = []; // what is playing or scheduled now
  private finish: ((r: "ended" | "stopped") => void) | null = null;
  private abort: AbortController | null = null;
  private gen = 0;
  private blipSource: AudioBufferSourceNode | null = null;
  private busyUntil = 0; // ctx time the current short clip (an "mm-hm") ends; a reply starts after it

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
      p.then((b) => this.ready.set(key, b)).catch(() => this.cache.delete(key));
    }
    return p;
  }

  /** Plays a buffer; resolves when it ends or is stopped. */
  play(buf: AudioBuffer): Promise<"ended" | "stopped"> {
    this.stopReply();
    void this.ctx.resume();
    const done = this.begin();
    this.schedule(buf, Math.max(this.ctx.currentTime, this.busyUntil));
    this.sealed();
    return done;
  }

  /** A short clip (backchannel) that the next reply waits for instead of cutting off. */
  async blip(text: string, voice: string) {
    const buf = this.ready.get(`${voice}|${text}`);
    if (!buf || this.playing) return; // not rendered yet, or already talking: skip it
    void this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    this.blipSource = src;
    src.onended = () => {
      if (this.blipSource === src) this.blipSource = null;
      src.disconnect();
    };
    src.start();
    this.busyUntil = this.ctx.currentTime + buf.duration;
  }

  /**
   * Speaks `text` as soon as the first audio arrives (~0.8 s) instead of after the whole clip renders
   * (3-5 s). Uses the rendered clip if it is already here. `onStart` fires when sound begins.
   */
  async speak(text: string, voice: string, onStart?: () => void): Promise<"ended" | "stopped"> {
    const cached = this.ready.get(`${voice}|${text}`);
    if (cached) {
      onStart?.();
      return this.play(cached);
    }
    this.stopReply();
    void this.ctx.resume();
    const done = this.begin();
    const my = this.gen;
    const ac = new AbortController();
    this.abort = ac;
    const r = await fetch("/api/tts/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice }),
      signal: ac.signal,
    }).catch(() => null);
    if (my !== this.gen) return "stopped";
    const fallback = async (): Promise<"ended" | "stopped"> => {
      try {
        const clip = await this.clip(text, voice);
        if (my !== this.gen) return "stopped";
        onStart?.();
        return this.play(clip);
      } catch (error) {
        if (my !== this.gen) return "stopped";
        this.end("stopped");
        throw error;
      }
    };
    if (!r?.ok || !r.body) return fallback();
    const rate = Number(r.headers.get("x-sample-rate")) || 24000;
    const reader = r.body.getReader();
    let carry: Uint8Array | null = null;
    let t = 0;
    try {
      for (;;) {
        const { value, done: end } = await reader.read();
        if (my !== this.gen) return "stopped";
        if (end) break;
        let bytes: Uint8Array = value;
        if (carry) {
          const joined = new Uint8Array(carry.length + value.length);
          joined.set(carry);
          joined.set(value, carry.length);
          bytes = joined;
        }
        const even = bytes.length & ~1;
        carry = even < bytes.length ? bytes.slice(even) : null;
        if (!even) continue;
        const view = new DataView(bytes.buffer, bytes.byteOffset, even);
        const f = new Float32Array(even / 2);
        for (let i = 0; i < f.length; i++) f[i] = view.getInt16(i * 2, true) / 32768;
        const buf = this.ctx.createBuffer(1, f.length, rate);
        buf.copyToChannel(f, 0);
        if (!t) {
          // a small cushion so network jitter doesn't leave gaps; wait for an "mm-hm" that is still playing
          t = Math.max(this.ctx.currentTime + 0.12, this.busyUntil);
          onStart?.();
        } else t = Math.max(t, this.ctx.currentTime + 0.02);
        t += this.schedule(buf, t);
      }
    } catch {
      if (my !== this.gen) return "stopped";
    }
    if (!t) return fallback();
    this.sealed();
    return done;
  }

  private begin() {
    const my = ++this.gen;
    return new Promise<"ended" | "stopped">((resolve) => {
      this.finish = (r) => resolve(my === this.gen ? r : "stopped");
    });
  }

  private schedule(buf: AudioBuffer, at: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      if (this.sealedGen === this.gen && !this.sources.length) this.end("ended");
    };
    src.start(at);
    this.sources.push(src);
    return buf.duration;
  }

  private sealedGen = -1;
  /** No more audio is coming for this reply: resolve once what's scheduled has played. */
  private sealed() {
    this.sealedGen = this.gen;
    if (!this.sources.length) this.end("ended");
  }

  private end(r: "ended" | "stopped") {
    const f = this.finish;
    this.finish = null;
    f?.(r);
  }

  get playing() {
    return this.blipSource !== null || this.sources.length > 0 || this.finish !== null;
  }

  /** Returns ms spent silencing (local). */
  stop(): number {
    const t0 = performance.now();
    this.stopReply();
    const blip = this.blipSource;
    this.blipSource = null;
    this.busyUntil = 0;
    if (blip) {
      blip.onended = null;
      try {
        blip.stop();
      } catch {}
      blip.disconnect();
    }
    return Math.round(performance.now() - t0);
  }

  private stopReply() {
    this.gen++;
    this.abort?.abort();
    this.abort = null;
    const playing = this.sources;
    this.sources = [];
    for (const s of playing) {
      try {
        s.stop();
      } catch {}
      s.disconnect();
    }
    this.end("stopped");
  }
}
