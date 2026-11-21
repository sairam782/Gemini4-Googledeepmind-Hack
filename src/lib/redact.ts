import type { SafeWord } from '@/lib/store';

const MASK = '•••';

function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Family safe words must never appear in transcripts or history.
 * The agent may hear a caller say one, so mask every occurrence before showing or saving text.
 */
export function redactSafeWords(text: string, safeWords: SafeWord[]): string {
  let out = text;
  for (const { word } of safeWords) {
    const w = word.trim();
    if (w.length < 2) continue;
    out = out.replace(new RegExp(escapeRegExp(w), 'gi'), MASK);
  }
  return out;
}
