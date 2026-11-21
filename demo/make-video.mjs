// Builds demo/uno-revoice-demo.mp4 (1920×1080, under 60 s).
//   demo/work/raw.mov       simulator recording of the demo tour (src/lib/demo-tour.ts)
//   demo/work/vo-*, sfx-*   ElevenLabs voice and sound effects (make-audio.mjs)
// Run from the repo root after `cd demo && npm install`:  node demo/make-video.mjs
//
// Story: home → how it works (Gemini models) → scam call → SCAM + block → real call → REAL
//        → history → modes → "powered by Gemini" end card.
// Waiting parts of the calls play faster (SPEED) so there are no dead pauses.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { Resvg } from '@resvg/resvg-js';

const W = 'demo/work';
const OUT = 'demo/uno-revoice-demo.mp4';
const NAVY = '#141A33';
const RED = '#C8372D';
const CREAM = '#FFF4E8';
const MUTED = '#585D73';
const SPEED = 1.75;

mkdirSync(`${W}/frames`, { recursive: true });

// The simulator records frames only when the screen changes; make a steady 30 fps copy so cuts are exact.
const RAW = `${W}/raw30.mp4`;
if (!existsSync(RAW) || statSync(RAW).mtimeMs < statSync(`${W}/raw.mov`).mtimeMs) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', `${W}/raw.mov`, '-vf', 'fps=30', '-c:v', 'libx264', '-crf', '14', '-preset', 'fast', RAW], { stdio: 'inherit' });
}
const wordmark = `data:image/png;base64,${readFileSync('assets/brand/uno-revoice-wordmark.png').toString('base64')}`;
const icon = `data:image/png;base64,${readFileSync('assets/images/logo.png').toString('base64')}`;
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const png = (name, body, bg = CREAM) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1080" viewBox="0 0 1920 1080">${
    bg ? `<rect width="1920" height="1080" fill="${bg}"/>` : ''
  }${body}</svg>`;
  const file = `${W}/frames/${name}.png`;
  writeFileSync(file, new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'Arial' } }).render().asPng());
  return file;
};
const text = (x, y, s, size, fill, weight = 700, anchor = 'start') =>
  `<text x="${x}" y="${y}" font-family="Arial" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${esc(s)}</text>`;

// ---------------------------------------------------------------- side panels (phone on the right)

const MODELS = [
  ['live', 'Gemini 3.8 Live', 'talks to the caller'],
  ['hydrogen', 'Gemini 4 Hydrogen', 'flags warning signs'],
  ['neon', 'Gemini 4 Neon', 'decides scam or real'],
];

function panel(name, caption, active = []) {
  let body = `<image href="${wordmark}" x="140" y="150" width="700" height="${Math.round((700 * 196) / 820)}"/>`;
  body += text(140, 420, 'Your AI call screener', 38, RED);
  body += text(140, 500, caption, 54, NAVY);
  if (active.length) {
    body += text(140, 590, 'GEMINI IN THE BACKGROUND', 24, MUTED, 700);
    MODELS.forEach(([id, model, job], i) => {
      const y = 615 + i * 96;
      const on = active.includes(id);
      body += `<rect x="140" y="${y}" width="760" height="78" rx="39" fill="${on ? NAVY : 'none'}" stroke="${on ? NAVY : '#D9C9B6'}" stroke-width="2"/>`;
      body += `<circle cx="182" cy="${y + 39}" r="9" fill="${on ? RED : '#D9C9B6'}"/>`;
      body += text(210, y + 50, model, 30, on ? '#FFFFFF' : '#A79C90');
      body += text(560, y + 50, job, 26, on ? '#E7E9F2' : '#B9AFA4', 400);
    });
  }
  body += text(140, 1010, 'App screens: Demo mode on iPhone  ·  Live calls run the same Gemini pipeline', 22, MUTED, 400);
  return png(name, body);
}

// ---------------------------------------------------------------- "how it works" diagram

function box(x, y, w, h, title, sub, { fill = '#FFFFFF', stroke = '#E2D2BF', color = NAVY, subColor = MUTED } = {}) {
  return (
    `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="22" fill="${fill}" stroke="${stroke}" stroke-width="3"/>` +
    text(x + w / 2, y + (sub ? h / 2 - 4 : h / 2 + 12), title, 32, color, 700, 'middle') +
    (sub ? text(x + w / 2, y + h / 2 + 36, sub, 24, subColor, 400, 'middle') : '')
  );
}
const arrow = (x1, y1, x2, y2) => {
  const a = Math.atan2(y2 - y1, x2 - x1);
  const hx = (d, s) => x2 - 18 * Math.cos(a + s * 0.45);
  const hy = (d, s) => y2 - 18 * Math.sin(a + s * 0.45);
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${NAVY}" stroke-width="4" stroke-linecap="round"/><polygon points="${x2},${y2} ${hx(0, 1)},${hy(0, 1)} ${hx(0, -1)},${hy(0, -1)}" fill="${NAVY}"/>`;
};

const cards = [
  ['live', 160, 'Gemini 3.8 Live', 'Talks to the caller in real time'],
  ['hydrogen', 720, 'Gemini 4 Hydrogen', 'Flags warning signs each turn'],
  ['neon', 1280, 'Gemini 4 Neon', 'Decides scam or real, with reasons'],
];
const cardY = 500;
const cardW = 480;
const cardH = 170;

let diagram = text(960, 120, 'How Uno ReVoice works', 64, NAVY, 700, 'middle');
diagram += text(960, 180, 'Gemini models analyze every screened call in the background', 34, RED, 700, 'middle');
const row = [
  [160, 'Unknown caller', 'rings your phone'],
  [600, 'Carrier forwards it', 'calls you don’t pick up'],
  [1040, 'SignalWire line', 'streams the call audio'],
  [1480, 'Uno ReVoice server', 'runs the agent'],
];
row.forEach(([x, t, s], i) => {
  diagram += box(x, 250, 300, 140, t, s);
  if (i < row.length - 1) diagram += arrow(x + 308, 320, x + 432, 320);
});
diagram += arrow(1630, 398, 1630, 440) + `<line x1="400" y1="450" x2="1630" y2="450" stroke="${NAVY}" stroke-width="4"/>`;
cards.forEach(([, x]) => (diagram += arrow(x + cardW / 2, 450, x + cardW / 2, cardY - 8)));
cards.forEach(([, x, t, s]) => (diagram += box(x, cardY, cardW, cardH, t, s, { fill: 'none', stroke: '#D9C9B6', color: '#B3A897', subColor: '#C2B8AC' })));
diagram += `<line x1="400" y1="${cardY + cardH + 40}" x2="1520" y2="${cardY + cardH + 40}" stroke="${NAVY}" stroke-width="4"/>`;
cards.forEach(([, x]) => (diagram += `<line x1="${x + cardW / 2}" y1="${cardY + cardH + 8}" x2="${x + cardW / 2}" y2="${cardY + cardH + 40}" stroke="${NAVY}" stroke-width="4"/>`));
diagram += arrow(960, cardY + cardH + 40, 960, 790);
diagram += box(560, 800, 800, 150, 'Your phone: Uno ReVoice app', 'Live transcript · warning signs · verdict · Join · End · Block', {
  stroke: RED,
});
const diagramBase = png('diagram', diagram);
const diagramCards = cards.map(([id, x, t, s]) =>
  png(`diagram-${id}`, box(x, cardY, cardW, cardH, t, s, { fill: NAVY, stroke: NAVY, color: '#FFFFFF', subColor: '#E7E9F2' }), null),
);

// ---------------------------------------------------------------- end card

let end = `<image href="${icon}" x="840" y="170" width="240" height="240"/>`;
end += `<image href="${wordmark}" x="${960 - 450}" y="440" width="900" height="${Math.round((900 * 196) / 820)}"/>`;
end += text(960, 730, 'Your AI call screener, powered by Gemini', 44, RED, 700, 'middle');
end += text(960, 800, 'Gemini 3.8 Live  ·  Gemini 4 Hydrogen  ·  Gemini 4 Neon', 34, NAVY, 700, 'middle');
const endCard = png('end', end);

// ---------------------------------------------------------------- timeline

// Phone segments: [raw start, raw end, speed, panel]
const segs = [];
const add = (kind, dur, extra) => segs.push({ kind, dur, ...extra });
const phone = (from, to, speed, panelFile) => add('phone', (to - from) / speed, { from, to, speed, panelFile });

phone(5.9, 10.0, 1, panel('p-home', 'Scam calls, answered by AI'));
add('diagram', 13.5);
phone(10.0, 25.0, SPEED, panel('p-scam-call', 'Gemini screens the call, live', ['live', 'hydrogen']));
phone(25.0, 31.0, 1, panel('p-scam-verdict', 'Scam spotted. Blocked in one tap.', ['neon']));
phone(33.0, 48.0, SPEED, panel('p-real-call', 'Real callers get through', ['live', 'hydrogen']));
phone(48.0, 52.0, 1, panel('p-real-verdict', 'Verdict: real. Join anytime.', ['neon']));
phone(54.0, 58.0, 1, panel('p-history', 'Every call saved, with reasons'));
phone(60.0, 62.5, 1, panel('p-modes', 'Demo, simulation or live calls'));
add('end', 4.2, { file: endCard });

let t = 0;
for (const s of segs) {
  s.at = t;
  t += s.dur;
}
const LENGTH = Math.round(t * 100) / 100;
const at = (i, offset = 0) => segs[i].at + offset;
const rawAt = (i, raw) => segs[i].at + (raw - segs[i].from) / segs[i].speed; // a raw-recording moment in video time

const voice = [
  ['intro', 0.15], ['flow', at(1, 0.6)], ['call', at(2, 0.7)], ['scam2', at(3, 0.3)],
  ['real2', at(4, 0.8)], ['join', at(5, 0.8)], ['history', at(6, 0.3)], ['outro2', at(7, 0.3)],
];
const sfx = [
  ['notify', at(2), 0.35], ['ping', rawAt(2, 16), 0.3], ['ping', rawAt(2, 23), 0.3],
  ['alarm', at(3), 0.35], ['click', rawAt(3, 29), 0.45],
  ['notify', at(4), 0.35], ['ping', rawAt(4, 39), 0.3], ['ping', rawAt(4, 46), 0.3],
  ['success', at(5), 0.4], ['whoosh', at(1), 0.3], ['whoosh', at(6), 0.3], ['whoosh', at(7), 0.3], ['whoosh', at(8), 0.3],
];
// Diagram: light up each Gemini card as the narration names it (offsets into the "flow" line).
const cardOn = [3.6, 6.4, 9.6].map((o) => at(1, o));

// ---------------------------------------------------------------- ffmpeg graph

const inputs = ['-i', RAW];
const still = (file, dur) => {
  inputs.push('-loop', '1', '-framerate', '30', '-t', String(dur), '-i', file);
  return inputs.filter((x) => x === '-i').length - 1;
};
const phoneSegs = segs.filter((s) => s.kind === 'phone');
const vf = [`[0:v]split=${phoneSegs.length}${phoneSegs.map((_, i) => `[r${i}]`).join('')}`];
const parts = [];
let k = 0;
segs.forEach((s, i) => {
  if (s.kind === 'phone') {
    const p = still(s.panelFile, s.dur);
    vf.push(
      `[r${k}]trim=start=${s.from}:end=${s.to},setpts=(PTS-STARTPTS)/${s.speed},fps=30,scale=460:1000,pad=472:1012:6:6:color=${NAVY.replace('#', '0x')}[ph${i}]`,
      `[${p}:v][ph${i}]overlay=1240:(H-h)/2:shortest=1,trim=duration=${s.dur},setsar=1[s${i}]`,
    );
    k++;
  } else if (s.kind === 'diagram') {
    const base = still(diagramBase, s.dur);
    let last = `[${base}:v]`;
    diagramCards.forEach((file, j) => {
      const c = still(file, s.dur);
      vf.push(`${last}[${c}:v]overlay=0:0:enable='gte(t,${(cardOn[j] - s.at).toFixed(2)})'[d${j}]`);
      last = `[d${j}]`;
    });
    vf.push(`${last}trim=duration=${s.dur},setsar=1[s${i}]`);
  } else {
    const e = still(s.file, s.dur);
    vf.push(`[${e}:v]trim=duration=${s.dur},setsar=1[s${i}]`);
  }
  parts.push(`[s${i}]`);
});
vf.push(
  `${parts.join('')}concat=n=${parts.length}:v=1:a=0,fade=t=in:st=0:d=0.4:color=0xFFF4E8,fade=t=out:st=${LENGTH - 0.8}:d=0.8:color=0xFFF4E8,format=yuv420p[v]`,
);

const af = [];
const labels = [];
let n = inputs.filter((x) => x === '-i').length;
for (const [name, start] of voice) {
  inputs.push('-i', `${W}/vo-${name}.mp3`);
  af.push(`[${n}:a]adelay=${Math.round(start * 1000)}:all=1[a${n}]`);
  labels.push(`[a${n}]`);
  n++;
}
for (const [name, start, vol] of sfx) {
  inputs.push('-i', `${W}/sfx-${name}.mp3`);
  af.push(`[${n}:a]adelay=${Math.round(start * 1000)}:all=1,volume=${vol}[a${n}]`);
  labels.push(`[a${n}]`);
  n++;
}
af.push(
  `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest,apad,atrim=0:${LENGTH},afade=t=out:st=${LENGTH - 0.8}:d=0.8,alimiter=limit=0.9[a]`,
);

execFileSync(
  'ffmpeg',
  ['-v', 'error', '-y', ...inputs, '-filter_complex', [...vf, ...af].join(';'), '-map', '[v]', '-map', '[a]',
    '-c:v', 'libx264', '-crf', '20', '-preset', 'medium', '-r', '30', '-c:a', 'aac', '-b:a', '160k',
    '-movflags', '+faststart', '-t', String(LENGTH), OUT],
  { stdio: 'inherit' },
);
console.log(`wrote ${OUT} (${LENGTH}s)`);
console.log(segs.map((s) => `${s.kind.padEnd(8)} ${s.at.toFixed(1)}–${(s.at + s.dur).toFixed(1)}`).join('\n'));
