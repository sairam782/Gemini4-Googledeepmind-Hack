/**
 * Streams the microphone to the server as 16 kHz 16-bit mono PCM (binary WebSocket frames), for desk
 * mic mode: the person at the desk plays the caller and Gemini Live transcribes them, like a phone line.
 * Echo cancellation is on so the agent's voice from the speakers mostly stays out; headphones are best.
 */
export async function startMic(send: (pcm: ArrayBuffer) => void, onLevel?: (rms: number) => void): Promise<() => void> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
  });
  const ctx = new AudioContext();
  await ctx.resume(); // a context created after an await can start suspended
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  const ratio = ctx.sampleRate / 16000;
  proc.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const n = Math.floor(input.length / ratio);
    const out = new Int16Array(n);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      // average the source samples that fall in this output sample (cheap anti-aliasing)
      const a = Math.floor(i * ratio), b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let v = 0;
      for (let j = a; j < b; j++) v += input[j];
      v /= Math.max(1, b - a);
      sum += v * v;
      out[i] = Math.max(-1, Math.min(1, v)) * 0x7fff;
    }
    onLevel?.(Math.sqrt(sum / Math.max(1, n)));
    send(out.buffer);
  };
  src.connect(proc);
  proc.connect(ctx.destination); // ScriptProcessor only runs when connected; it outputs silence
  return () => {
    proc.disconnect();
    src.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };
}
