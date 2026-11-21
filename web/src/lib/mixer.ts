import type { Floor } from "../../../shared/protocol.ts";

/**
 * Alex's Web Audio graph. The assistant lives on Alex's line:
 *
 *   mic ──► micGain ───┐
 *                      ├──► outDest  ──► WebRTC (what the caller hears)
 *   clip ─► agentGain ─┤
 *                      └──► monitor  ──► Alex's headphones (Alex hears the assistant)
 *
 * Takeback is a local gain change, so it never waits on the network or a model.
 */
export class Mixer {
  readonly ctx: AudioContext;
  readonly rawMic: MediaStream; // pre-mixer: send THIS to captions, so assistant audio is never captioned as Alex
  readonly outgoing: MediaStreamTrack;
  private micGain: GainNode;
  private agentGain: GainNode;
  private current: AudioBufferSourceNode | null = null;
  private clipRevision = -1;
  onClipEnd: () => void = () => {};

  private constructor(ctx: AudioContext, mic: MediaStream) {
    this.ctx = ctx;
    this.rawMic = mic;
    const out = ctx.createMediaStreamDestination();
    this.micGain = ctx.createGain();
    this.agentGain = ctx.createGain();
    ctx.createMediaStreamSource(mic).connect(this.micGain).connect(out);
    this.agentGain.connect(out);
    this.agentGain.connect(ctx.destination); // local monitor
    this.outgoing = out.stream.getAudioTracks()[0];
    this.setFloor("alex");
  }

  static async create(): Promise<Mixer> {
    const ctx = new AudioContext({ latencyHint: "interactive" });
    await ctx.resume();
    return new Mixer(ctx, await getMic(ctx));
  }

  /** Floor table from the build guide. */
  setFloor(floor: Floor) {
    const t = this.ctx.currentTime;
    const [mic, agent] = floor === "alex" ? [1, 0] : floor === "revoice" ? [0, 1] : [0, 0];
    // 8 ms ramps: fast enough to be inaudible as a delay, slow enough not to click.
    for (const [node, v] of [
      [this.micGain, mic],
      [this.agentGain, agent],
    ] as const) {
      node.gain.cancelScheduledValues(t);
      node.gain.setValueAtTime(node.gain.value, t);
      node.gain.linearRampToValueAtTime(v, t + 0.008);
    }
  }

  /** Hard stop: silence the assistant, stop the clip. Returns ms spent (local). */
  silenceAgent(): number {
    const t0 = performance.now();
    this.setFloor("alex");
    this.stopClip();
    return Math.round(performance.now() - t0);
  }

  stopClip() {
    if (this.current) {
      this.current.onended = null;
      try {
        this.current.stop();
      } catch {}
      this.current.disconnect();
      this.current = null;
    }
  }

  get playing() {
    return this.current !== null;
  }

  /**
   * Play a decoded clip into the assistant channel. `revision` is the control revision
   * the clip was requested under; the caller must check it is still current before calling.
   */
  play(buffer: AudioBuffer, revision: number) {
    this.stopClip();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.agentGain);
    src.onended = () => {
      if (this.current === src) {
        this.current = null;
        this.onClipEnd();
      }
    };
    this.current = src;
    this.clipRevision = revision;
    src.start();
  }

  get playingRevision() {
    return this.current ? this.clipRevision : null;
  }

  decode(bytes: ArrayBuffer) {
    return this.ctx.decodeAudioData(bytes);
  }

  /** A 3 s synthetic "speech-like" clip for wiring tests when TTS isn't configured. */
  testTone(): AudioBuffer {
    const sr = this.ctx.sampleRate;
    const buf = this.ctx.createBuffer(1, sr * 3, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) {
      const t = i / sr;
      // Never fully silent mid-clip, so the caller's silence detector only fires on a real stop.
      const syllable = 0.5 + 0.5 * Math.sin(Math.PI * 4 * t) ** 2;
      const f = 180 + 40 * Math.sin(2 * Math.PI * 0.7 * t);
      d[i] = 0.25 * syllable * (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(4 * Math.PI * f * t));
    }
    return buf;
  }

  close() {
    this.stopClip();
    this.rawMic.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}

/**
 * The real microphone, or with `?fakeMic=1` a silent synthetic one (for testing the
 * wiring where mic access is unavailable, e.g. headless or embedded browsers).
 */
export async function getMic(ctx: AudioContext): Promise<MediaStream> {
  if (new URLSearchParams(location.search).has("fakeMic")) {
    const dest = ctx.createMediaStreamDestination();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0;
    osc.connect(g).connect(dest);
    osc.start();
    return dest.stream;
  }
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
}

/** Watches a stream's level and calls back on loud→quiet edges. Used on the caller laptop. */
export function watchLevel(
  ctx: AudioContext,
  stream: MediaStream,
  onLevel: (rms: number) => void,
  onSilentEdge: () => void,
) {
  const src = ctx.createMediaStreamSource(stream);
  const an = ctx.createAnalyser();
  an.fftSize = 512;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  let loud = false;
  let quietReads = 0;
  const id = window.setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    const rms = Math.sqrt(s / buf.length);
    onLevel(rms);
    if (rms > 0.01) {
      loud = true;
      quietReads = 0;
    } else if (loud && ++quietReads >= 2) {
      loud = false;
      onSilentEdge();
    }
  }, 10);
  return () => {
    clearInterval(id);
    src.disconnect();
  };
}
