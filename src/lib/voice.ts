/**
 * Plays call audio on the phone: each line is rendered by the agent server's Gemini TTS
 * (POST /api/tts → WAV), saved to the cache folder and played with expo-audio.
 * Lines play one at a time, in the order they arrive, like a phone call.
 */
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer } from 'expo-audio';
import { File, Paths } from 'expo-file-system';

/** Same voices as the web test desk. */
export const AGENT_VOICE = 'Kore';
export const CALLER_VOICE = 'Puck';

const clips = new Map<string, Promise<string>>();

function hash(s: string) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Renders a line to a local WAV file (cached per voice + text) and returns its URI. */
export function renderClip(baseUrl: string, text: string, voice: string): Promise<string> {
  const key = `${voice}|${text}`;
  let p = clips.get(key);
  if (!p) {
    p = (async () => {
      const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice }),
      });
      if (!res.ok) throw new Error(`TTS ${res.status}`);
      const file = new File(Paths.cache, `tts-${hash(key)}.wav`);
      if (file.exists) file.delete();
      file.create();
      await file.write(new Uint8Array(await res.arrayBuffer()));
      return file.uri;
    })();
    clips.set(key, p);
    p.catch(() => clips.delete(key));
  }
  return p;
}

let modeReady: Promise<void> | null = null;
const ensureMode = () =>
  (modeReady ??= setAudioModeAsync({ playsInSilentMode: true }).catch((e) => console.warn('Audio mode', e)));

let current: { id: string; player: AudioPlayer; stop: () => void } | null = null;

/** Plays one clip. Resolves "ended" when it finishes, "stopped" if stopSpeech() cut it. */
function play(id: string, uri: string): Promise<'ended' | 'stopped'> {
  return new Promise((resolve) => {
    const player = createAudioPlayer(uri);
    let settled = false;
    const settle = (r: 'ended' | 'stopped') => {
      if (settled) return;
      settled = true;
      sub.remove();
      try {
        player.pause();
        player.remove();
      } catch {
        // already released
      }
      if (current?.player === player) current = null;
      resolve(r);
    };
    const sub = player.addListener('playbackStatusUpdate', (s) => {
      if (s.didJustFinish) settle('ended');
    });
    current = { id, player, stop: () => settle('stopped') };
    player.play();
  });
}

/** A rough speaking time, used when audio can't be rendered so the call still moves on. */
const readingTime = (text: string) => new Promise<void>((r) => setTimeout(r, Math.min(5000, 400 + text.length * 55)));

type Line = { id: string; text: string; voice: string; onDone: (r: 'ended' | 'stopped') => void };
let queue: Promise<void> = Promise.resolve();
const skipped = new Set<string>();
let generation = 0;

/** Queues a line. `onDone` runs after it played (or was skipped/stopped). */
export function speak(baseUrl: string, line: Line) {
  const gen = generation;
  const clip = renderClip(baseUrl, line.text, line.voice); // start rendering now, play in order
  queue = queue.then(async () => {
    if (gen !== generation || skipped.has(line.id)) return line.onDone('stopped');
    await ensureMode();
    let result: 'ended' | 'stopped' = 'ended';
    try {
      const uri = await clip;
      if (gen !== generation || skipped.has(line.id)) return line.onDone('stopped');
      result = await play(line.id, uri);
    } catch (e) {
      console.warn('Could not play line', e);
      await readingTime(line.text);
    }
    line.onDone(result);
  });
}

/** Stops one line (e.g. the agent was cut off), whether it's playing or still waiting. */
export function cutLine(id: string) {
  skipped.add(id);
  if (current?.id === id) current.stop();
}

/** Stops everything: the call ended or the user left the call. */
export function stopSpeech() {
  generation++;
  current?.stop();
}
