/* Sound alerts for the staff page. The bell is synthesised with the Web Audio API
 * (no sound files). Browsers only allow audio after a tap/click on the page, so
 * unlock() must be called from a user action (e.g. the login button).
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

// One bell strike: a few harmonics with a soft attack and long decay.
function strike(at, freq, volume) {
  const out = ctx.createGain();
  out.gain.setValueAtTime(0.0001, at);
  out.gain.exponentialRampToValueAtTime(volume, at + 0.012);
  out.gain.exponentialRampToValueAtTime(0.0001, at + 1.6);
  out.connect(ctx.destination);
  for (const [mult, amp] of [[1, 1], [2.01, .45], [3.02, .22], [4.17, .12]]) {
    const osc = ctx.createOscillator(), g = ctx.createGain();
    osc.type = 'sine'; osc.frequency.setValueAtTime(freq * mult, at);
    g.gain.value = amp;
    osc.connect(g).connect(out);
    osc.start(at); osc.stop(at + 1.7);
  }
}

/** kind: 'new' (two rising strikes) or 'reminder' (one softer strike). */
export function chime(kind = 'new', volume = .7) {
  if (!ctx) return false;
  if (ctx.state === 'suspended') ctx.resume();
  const t = ctx.currentTime + .03;
  const v = Math.max(.02, Math.min(1, volume)) * .35;
  if (kind === 'reminder') strike(t, 784, v * .7);
  else { strike(t, 880, v); strike(t + .22, 1175, v); }
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
