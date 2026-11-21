// Builds demo/uno-revoice-demo.mp4 (1920×1080, under 60 s) from:
//   demo/work/raw.mov          simulator recording of the demo tour (src/lib/demo-tour.ts)
//   demo/work/vo-*.mp3, sfx-*  from make-audio.mjs (ElevenLabs)
// Run from the repo root: node demo/make-video.mjs
// Times below are seconds in the finished video; START is where the tour begins in raw.mov.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const W = 'demo/work';
const START = 5.9;
const LENGTH = 58.4;
const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
const NAVY = '0x141A33';
const RED = '0xC8372D';
const CREAM = '0xFFF4E8';

const voice = [
  ['intro', 0.3], ['screen', 4.9], ['live', 9.6], ['scam', 19.2], ['block', 23.2],
  ['real', 27.6], ['verdict', 42.3], ['history', 48.4], ['outro', 54.4],
];
const sfx = [
  ['notify', 4.1, 0.35], ['ping', 10.1, 0.3], ['ping', 17.1, 0.3], ['alarm', 19.1, 0.35],
  ['click', 23.1, 0.45], ['notify', 27.1, 0.35], ['ping', 33.1, 0.3], ['success', 42.1, 0.4],
  ['click', 46.1, 0.45], ['whoosh', 48.1, 0.3], ['whoosh', 54.1, 0.3],
];
const captions = [
  [0, 4.1, 'Scam calls, answered by AI'],
  [4.1, 19.1, 'Gemini screens the caller, live'],
  [19.1, 26.1, 'Scam spotted. Blocked in one tap.'],
  [26.1, 42.1, 'Real callers get through'],
  [42.1, 48.1, 'Verdict: real. Join anytime.'],
  [48.1, 54.1, 'Every call saved, with reasons'],
  [54.1, LENGTH, 'Demo, simulation or live calls'],
];

mkdirSync(`${W}/captions`, { recursive: true });
captions.forEach(([, , text], i) => writeFileSync(`${W}/captions/${i}.txt`, text));
writeFileSync(`${W}/captions/tag.txt`, 'Your AI call screener');
writeFileSync(`${W}/captions/foot.txt`, 'Built with Gemini 4  |  Demo mode in the iOS app');

// ---- video: cream canvas, wordmark + captions left, phone recording right
const phoneH = 1000;
const phoneW = Math.round((1206 / 2622) * phoneH / 2) * 2;
const draw = (file, size, color, y, extra = '') =>
  `drawtext=fontfile='${FONT}':textfile='${file}':fontsize=${size}:fontcolor=${color}:x=140:y=${y}${extra}`;
const vf = [
  `[0:v]trim=start=${START}:duration=${LENGTH},setpts=PTS-STARTPTS,fps=30,scale=${phoneW}:${phoneH},pad=${phoneW + 12}:${phoneH + 12}:6:6:color=${NAVY}[phone]`,
  `color=c=${CREAM}:s=1920x1080:d=${LENGTH}:r=30[bg]`,
  `[1:v]scale=760:-1[logo]`,
  `[bg][logo]overlay=140:300[b1]`,
  `[b1][phone]overlay=1240:(H-h)/2[b2]`,
  `[b2]${[
    draw(`${W}/captions/tag.txt`, 40, RED, 530),
    ...captions.map(([a, b], i) => draw(`${W}/captions/${i}.txt`, 58, NAVY, 610, `:enable='between(t,${a},${b})'`)),
    draw(`${W}/captions/foot.txt`, 28, '0x585D73', 960),
  ].join(',')},fade=t=in:st=0:d=0.5:color=${CREAM},fade=t=out:st=${LENGTH - 0.7}:d=0.7:color=${CREAM}[v]`,
];

// ---- audio: voice lines and sound effects at their times
const inputs = ['-i', `${W}/raw.mov`, '-i', 'assets/brand/uno-revoice-wordmark.png'];
const af = [];
const labels = [];
let n = 2;
for (const [name, at] of voice) {
  inputs.push('-i', `${W}/vo-${name}.mp3`);
  af.push(`[${n}:a]adelay=${Math.round(at * 1000)}:all=1,volume=1.0[a${n}]`);
  labels.push(`[a${n}]`);
  n++;
}
for (const [name, at, vol] of sfx) {
  inputs.push('-i', `${W}/sfx-${name}.mp3`);
  af.push(`[${n}:a]adelay=${Math.round(at * 1000)}:all=1,volume=${vol}[a${n}]`);
  labels.push(`[a${n}]`);
  n++;
}
af.push(
  `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,atrim=0:${LENGTH},afade=t=out:st=${LENGTH - 0.7}:d=0.7,alimiter=limit=0.9[a]`,
);

execFileSync(
  'ffmpeg',
  [
    '-v', 'error', '-y', ...inputs,
    '-filter_complex', [...vf, ...af].join(';'),
    '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
    '-t', String(LENGTH),
    'demo/uno-revoice-demo.mp4',
  ],
  { stdio: 'inherit' },
);
console.log('wrote demo/uno-revoice-demo.mp4');
