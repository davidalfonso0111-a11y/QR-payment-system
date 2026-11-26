/* Sound alerts for the staff page. All sounds are synthesised with the Web Audio
 * API (no sound files). Browsers only allow audio after a tap/click on the page,
 * so unlock() must be called from a user action (e.g. the login button).
 */
let ctx = null;

export function unlock() {
  try {
    ctx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
  return ready();
}

export function ready() { return !!ctx && ctx.state === 'running'; }

// ---------------------------------------------------------------- building blocks
// Envelope-shaped output node: fast attack, exponential decay.
function env(ac, at, volume, decay, attack = .01) {
  const g = ac.createGain();
  g.gain.setValueAtTime(.0001, at);
  g.gain.exponentialRampToValueAtTime(Math.max(.0002, volume), at + attack);
  g.gain.exponentialRampToValueAtTime(.0001, at + attack + decay);
  g.connect(ac.destination);
  return g;
}
// Sum of partials [ratio, amplitude] of a base frequency.
function partials(ac, at, freq, list, volume, decay, type = 'sine', attack = .01) {
  const out = env(ac, at, volume, decay, attack);
  for (const [ratio, amp] of list) {
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq * ratio, at); g.gain.value = amp;
    o.connect(g).connect(out); o.start(at); o.stop(at + attack + decay + .05);
  }
}
function noise(ac, at, volume, decay, highpass = 2000) {
  const len = Math.ceil(ac.sampleRate * (decay + .05));
  const buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource(), f = ac.createBiquadFilter();
  src.buffer = buf; f.type = 'highpass'; f.frequency.value = highpass;
  src.connect(f).connect(env(ac, at, volume, decay, .003)); src.start(at);
}

// ---------------------------------------------------------------- presets
// play(ac, t, v, kind): kind 'new' = new order, 'reminder' = softer repeat.
export const PRESETS = {
  bell: {
    name: 'Bar-bel', desc: 'Klassieke toonbankbel, twee tikken',
    play(ac, t, v, kind) {
      const bell = [[1, 1], [2.01, .45], [3.02, .22], [4.17, .12]];
      if (kind === 'reminder') return partials(ac, t, 784, bell, v * .7, 1.5);
      partials(ac, t, 880, bell, v, 1.5); partials(ac, t + .22, 1175, bell, v, 1.5);
    },
  },
  glasses: {
    name: 'Glazen klinken', desc: 'Proost: twee glazen die tegen elkaar tikken',
    play(ac, t, v, kind) {
      const glass = [[1, 1], [2.76, .5], [5.4, .25], [8.9, .1]];
      const clink = (at, f, vol) => { partials(ac, at, f, glass, vol, .9, 'sine', .002); noise(ac, at, vol * .25, .04, 5000); };
      clink(t, 2093, v * .8);
      if (kind !== 'reminder') { clink(t + .16, 2349, v * .7); clink(t + .5, 2093, v * .45); }
    },
  },
  doorbell: {
    name: 'Ding-dong', desc: 'Zachte deurbel, rustig en duidelijk',
    play(ac, t, v, kind) {
      const tone = [[1, 1], [2, .15], [3, .05]];
      partials(ac, t, 659.25, tone, v, 1.4, 'sine', .02);
      if (kind !== 'reminder') partials(ac, t + .55, 523.25, tone, v, 1.8, 'sine', .02);
    },
  },
  lounge: {
    name: 'Lounge', desc: 'Warm vibrafoon-akkoordje, past bij de sfeer',
    play(ac, t, v) {
      // same chord for new orders and reminders (no separate single tone)
      const vib = [[1, 1], [4, .18], [10, .04]];
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => partials(ac, t + i * .11, f, vib, v * .75, 1.9, 'sine', .006));
    },
  },
  register: {
    name: 'Kassa', desc: 'Cha-ching! Kassa met belletje',
    play(ac, t, v, kind) {
      noise(ac, t, v * .5, .07, 1500);
      if (kind !== 'reminder') noise(ac, t + .09, v * .4, .05, 2500);
      partials(ac, t + .12, 2637, [[1, 1], [1.5, .4], [2.4, .2]], v * .7, kind === 'reminder' ? .6 : 1.1);
      if (kind !== 'reminder') partials(ac, t + .2, 3136, [[1, 1], [2.1, .3]], v * .55, 1);
    },
  },
  alert: {
    name: 'Luid signaal', desc: 'Drie korte piepjes, hoorbaar boven muziek uit',
    play(ac, t, v, kind) {
      const n = kind === 'reminder' ? 1 : 3;
      for (let i = 0; i < n; i++) partials(ac, t + i * .2, 1568, [[1, 1], [2, .25]], v * 1.25, .14, 'square', .004);
    },
  },
};

/** Play preset `id`. kind: 'new' | 'reminder'. */
export function chime(kind = 'new', volume = .7, id = 'bell') {
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume();
  const preset = PRESETS[id] || PRESETS.bell;
  preset.play(ctx, ctx.currentTime + .03, Math.max(.02, Math.min(1, volume)) * .35, kind);
  return ctx.state === 'running';
}

// Keep a tablet behind the bar awake while the page is open (where supported).
let lock = null;
export async function keepAwake(on) {
  try {
    if (on && !lock && 'wakeLock' in navigator && !document.hidden) {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
    } else if (!on && lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}
