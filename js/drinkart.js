/* SIPS drink art: glasses, fallback bottles, pour animation and glass loader.
 * Pure SVG + Web Animations, no libraries. All generated markup escapes text.
 */
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let uid = 0;
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// ---------------------------------------------------------------------------
// Glasses (viewBox 0 0 120 160). inner: clip path of the liquid space.
// bottom/top: y of an empty and a full pour. bubbles: sparkling drinks.
const GLASSES = {
  tumbler: {
    inner: 'M29 66 L91 66 L88 142 L32 142 Z',
    outline: '<path d="M26 60 L94 60 L90 150 L30 150 Z" class="g-body"/><path d="M31 142 L89 142 L90 150 L30 150 Z" class="g-base"/>',
    bottom: 142, top: 92,
  },
  wine: {
    inner: 'M33 28 C31 70 44 92 60 92 C76 92 89 70 87 28 Z',
    outline: '<path d="M30 22 C27 70 42 96 60 96 C78 96 93 70 90 22 Z" class="g-body"/><path d="M58 96 L62 96 L62 141 L58 141 Z" class="g-stem"/><ellipse cx="60" cy="145" rx="24" ry="5" class="g-base"/>',
    bottom: 92, top: 56,
  },
  flute: {
    inner: 'M49 18 L71 18 L68 92 C67 101 53 101 52 92 Z',
    outline: '<path d="M46 12 L74 12 L71 93 C69 106 51 106 49 93 Z" class="g-body"/><path d="M58 105 L62 105 L62 141 L58 141 Z" class="g-stem"/><ellipse cx="60" cy="145" rx="20" ry="4.5" class="g-base"/>',
    bottom: 101, top: 30, bubbles: true,
  },
  snifter: {
    inner: 'M43 50 C21 66 25 110 60 110 C95 110 99 66 77 50 Z',
    outline: '<path d="M41 42 C14 62 20 116 60 116 C100 116 106 62 79 42 Z" class="g-body"/><path d="M58 116 L62 116 L62 140 L58 140 Z" class="g-stem"/><ellipse cx="60" cy="144" rx="22" ry="5" class="g-base"/>',
    bottom: 110, top: 86,
  },
  copa: {
    inner: 'M25 30 C23 86 40 106 60 106 C80 106 97 86 95 30 Z',
    outline: '<path d="M21 24 C18 88 38 112 60 112 C82 112 102 88 99 24 Z" class="g-body"/><path d="M58 112 L62 112 L62 141 L58 141 Z" class="g-stem"/><ellipse cx="60" cy="145" rx="24" ry="5" class="g-base"/>',
    bottom: 106, top: 44, bubbles: true,
  },
  highball: {
    inner: 'M37 28 L83 28 L81 144 L39 144 Z',
    outline: '<path d="M34 20 L86 20 L84 152 L36 152 Z" class="g-body"/><path d="M39 144 L81 144 L84 152 L36 152 Z" class="g-base"/>',
    bottom: 144, top: 40, bubbles: true,
  },
};

export function glassInfo(glass) { return GLASSES[glass] || GLASSES.tumbler; }

function iceCubes(g) {
  // Three cubes floating near the top of a full pour.
  const y = g.top - 4, cx = 60;
  return `<g class="ice">${[[-17, 2, -12], [3, -4, 8], [14, 8, 20]].map(([dx, dy, r]) =>
    `<rect x="${cx + dx - 9}" y="${y + dy}" width="18" height="18" rx="4" transform="rotate(${r} ${cx + dx} ${y + dy + 9})"/>`).join('')}</g>`;
}

function bubbles(g) {
  return `<g class="bubbles">${[0, 1, 2, 3, 4, 5].map(i => {
    const x = 50 + (i * 7) % 22, d = 1.6 + (i % 3) * 0.5;
    return `<circle cx="${x}" cy="${g.bottom - 4}" r="${1 + (i % 2) * 0.6}" style="animation-duration:${d}s;animation-delay:${i * 0.35}s"/>`;
  }).join('')}</g>`;
}

/** Glass SVG. level 0..1 of a full pour. */
export function glassSVG({ glass = 'tumbler', color = '#c8862a', level = 0.7, ice = false, label = '' } = {}) {
  const g = glassInfo(glass);
  const id = 'gl' + (++uid);
  const y = g.bottom - (g.bottom - g.top) * Math.max(0, Math.min(1, level));
  return `<svg class="glass" viewBox="0 0 120 160" role="img" aria-label="${esc(label || 'Glas')}" data-bottom="${g.bottom}" data-top="${g.top}">
<defs><clipPath id="${id}"><path d="${g.inner}"/></clipPath>
<linearGradient id="${id}l" x1="0" x2="1"><stop offset="0" stop-color="${esc(color)}" stop-opacity=".95"/><stop offset=".55" stop-color="${esc(color)}"/><stop offset="1" stop-color="${esc(color)}" stop-opacity=".8"/></linearGradient></defs>
<g clip-path="url(#${id})"><rect class="liquid" x="0" y="${y}" width="120" height="170" fill="url(#${id}l)"/><rect class="liquid-shine" x="0" y="${y}" width="120" height="2.5"/>${ice ? iceCubes(g) : ''}${g.bubbles ? bubbles(g) : ''}</g>
${g.outline}<path d="M${glass === 'wine' || glass === 'copa' ? 36 : glass === 'flute' ? 52 : 34} ${g.top - 18} q-3 30 0 52" class="g-shine"/>
</svg>`;
}

/** Set the liquid level of a glass SVG (0..1). */
export function setLevel(svg, level) {
  const b = Number(svg.dataset.bottom), t = Number(svg.dataset.top);
  const y = b - (b - t) * Math.max(0, Math.min(1, level));
  svg.querySelectorAll('.liquid,.liquid-shine').forEach(r => r.setAttribute('y', y));
  const ice = svg.querySelector('.ice');
  if (ice) ice.setAttribute('transform', `translate(0 ${(1 - level) * (b - t)})`);
  svg.classList.toggle('empty', level < 0.08);
}

/** Animate level from..to over ms. Returns a promise. */
export function animateLevel(svg, from, to, ms) {
  if (reducedMotion() || ms <= 0) { setLevel(svg, to); return Promise.resolve(); }
  return new Promise(resolve => {
    const start = performance.now();
    const step = now => {
      const p = Math.min(1, (now - start) / ms);
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      setLevel(svg, from + (to - from) * e);
      if (p < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

// ---------------------------------------------------------------------------
// Fallback bottles (viewBox 0 0 80 200), shown when a product has no photo.
const BOTTLES = {
  whisky:     { bw: 58, top: 78, neck: 14, neckTop: 22, sh: 'square', glass: '#3a2412', cap: '#1d1d1d', capH: 16, label: '#efe3c8' },
  bourbon:    { bw: 54, top: 74, neck: 13, neckTop: 20, sh: 'square', glass: '#4a2510', cap: '#6b1f12', capH: 18, label: '#e9dcc0' },
  rum:        { bw: 62, top: 92, neck: 15, neckTop: 30, sh: 'round', glass: '#2a170c', cap: '#b28a3e', capH: 16, label: '#d9c49a' },
  gin:        { bw: 50, top: 70, neck: 12, neckTop: 16, sh: 'round', glass: '#bcd6d8', cap: '#2c4a52', capH: 14, label: '#f4f1ea', clear: true },
  vodka:      { bw: 46, top: 66, neck: 11, neckTop: 12, sh: 'slope', glass: '#dfe9ef', cap: '#d9d9d9', capH: 14, label: '#ffffff', clear: true },
  tequila:    { bw: 60, top: 96, neck: 18, neckTop: 40, sh: 'square', glass: '#e7cf96', cap: '#7a5a34', capH: 20, label: '#2a2a2a', clear: true },
  cognac:     { bw: 64, top: 100, neck: 13, neckTop: 30, sh: 'round', glass: '#4b200b', cap: '#c9a45c', capH: 18, label: '#1b1b1b' },
  wine_red:   { bw: 42, top: 88, neck: 12, neckTop: 10, sh: 'round', glass: '#1d2a17', cap: '#5c0f1b', capH: 26, label: '#f3ead7' },
  wine_white: { bw: 42, top: 88, neck: 12, neckTop: 10, sh: 'round', glass: '#8c9b5b', cap: '#c9b37a', capH: 26, label: '#f6f0de', clear: true },
  champagne:  { bw: 46, top: 96, neck: 15, neckTop: 10, sh: 'slope', glass: '#1c2b1c', cap: '#d4b25e', capH: 40, label: '#151515' },
};

function bottlePath(b) {
  const L = 40 - b.bw / 2, R = 40 + b.bw / 2, nl = 40 - b.neck / 2, nr = 40 + b.neck / 2, r = 7;
  const nb = b.sh === 'square' ? b.top - 8 : b.sh === 'slope' ? b.top - 30 : b.top - 20;
  const shoulder = b.sh === 'square'
    ? `L${nl} ${nb} L${L + 6} ${b.top - 4} Q${L} ${b.top} ${L} ${b.top + 6}`
    : b.sh === 'slope'
      ? `L${nl} ${nb} C${nl} ${nb + 18} ${L} ${b.top - 10} ${L} ${b.top + 6}`
      : `L${nl} ${nb} C${nl} ${b.top - 4} ${L} ${b.top - 6} ${L} ${b.top + 10}`;
  const shoulderR = b.sh === 'square'
    ? `L${R} ${b.top + 6} Q${R} ${b.top} ${R - 6} ${b.top - 4} L${nr} ${nb}`
    : b.sh === 'slope'
      ? `L${R} ${b.top + 6} C${R} ${b.top - 10} ${nr} ${nb + 18} ${nr} ${nb}`
      : `L${R} ${b.top + 10} C${R} ${b.top - 6} ${nr} ${b.top - 4} ${nr} ${nb}`;
  return `M${nl} ${b.neckTop} ${shoulder} L${L} ${196 - r} Q${L} 196 ${L + r} 196 L${R - r} 196 Q${R} 196 ${R} ${196 - r} ${shoulderR} L${nr} ${b.neckTop} Z`;
}

/** Fallback bottle SVG with a SIPS label (no brand artwork). */
export function bottleSVG({ bottle = 'whisky', color = '#c8862a', name = '' } = {}) {
  const b = BOTTLES[bottle] || BOTTLES.whisky;
  const id = 'bt' + (++uid);
  const L = 40 - b.bw / 2, lw = b.bw - 10, ly = Math.max(b.top + 22, 112);
  const short = String(name).split(/\s+/).slice(0, 2).join(' ');
  const fs = short.length > 12 ? 6 : 7.5;
  const dark = ['#1b1b1b', '#151515', '#2a2a2a'].includes(b.label);
  return `<svg class="bottle-svg" viewBox="0 0 80 200" role="img" aria-label="${esc('Fles ' + name)}">
<defs><clipPath id="${id}"><path d="${bottlePath(b)}"/></clipPath>
<linearGradient id="${id}s" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity=".0"/><stop offset=".18" stop-color="#fff" stop-opacity=".28"/><stop offset=".3" stop-color="#fff" stop-opacity="0"/><stop offset=".85" stop-color="#000" stop-opacity=".25"/></linearGradient></defs>
<path d="${bottlePath(b)}" fill="${b.glass}"/>
<g clip-path="url(#${id})">${b.clear ? `<rect x="0" y="${b.top + 4}" width="80" height="200" fill="${esc(color)}" opacity=".55"/>` : ''}<rect width="80" height="200" fill="url(#${id}s)"/></g>
<rect x="${40 - b.neck / 2 - 1.5}" y="${b.neckTop - b.capH + 6}" width="${b.neck + 3}" height="${b.capH}" rx="2.5" fill="${b.cap}"/>
<rect x="${L + 5}" y="${ly}" width="${lw}" height="${bottle === 'cognac' || bottle === 'rum' ? 40 : 48}" rx="3" fill="${dark ? b.label : b.label}" stroke="#c9a45c" stroke-width=".8"/>
<text x="40" y="${ly + 13}" text-anchor="middle" font-family="Georgia,serif" font-size="5.2" letter-spacing="2" fill="${dark ? '#c9a45c' : '#8a6a2c'}">SIPS</text>
<text x="40" y="${ly + 26}" text-anchor="middle" font-family="Georgia,serif" font-size="${fs}" fill="${dark ? '#f1e6cf' : '#22313d'}">${esc(short)}</text>
<line x1="${L + 12}" x2="${L + lw - 2}" y1="${ly + 33}" y2="${ly + 33}" stroke="#c9a45c" stroke-width=".6"/>
</svg>`;
}

/** Bottle element markup: photo if available, else the drawn bottle. */
export function bottleHTML(p) {
  if (p.image_url && /^https:\/\//.test(p.image_url)) {
    return `<img class="bottle-img" src="${esc(p.image_url)}" alt="${esc('Fles ' + p.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`;
  }
  return bottleSVG({ bottle: p.bottle, color: p.liquid_color, name: p.name });
}

/** Does the chosen serving add ice? */
export function servesIce(product, optionName) {
  if (optionName && /rocks|ijs/i.test(optionName) && !/zonder ijs/i.test(optionName)) return true;
  if (optionName && /zonder ijs|puur/i.test(optionName)) return false;
  return !!product.ice;
}

// ---------------------------------------------------------------------------
/** Pour animation in an overlay. Resolves when done (≈2.6 s). */
export async function pour(product, { optionName = '', host = document.body } = {}) {
  const ice = servesIce(product, optionName);
  const overlay = document.createElement('div');
  overlay.className = 'pour-overlay';
  overlay.setAttribute('role', 'status');
  overlay.innerHTML = `<div class="pour-stage" aria-hidden="true">
    <div class="pour-light"></div>
    <div class="pour-bottle">${bottleHTML(product)}</div>
    <div class="pour-stream" style="background:${esc(product.liquid_color || '#c8862a')}"></div>
    <div class="pour-glass">${glassSVG({ glass: product.glass, color: product.liquid_color, level: 0, ice: false })}</div>
    ${ice ? '<div class="pour-ice"><span></span><span></span><span></span></div>' : ''}
    <div class="pour-shelf"></div>
  </div><p class="pour-caption">${esc(product.name)} wordt ingeschonken…</p>`;
  host.append(overlay);
  const bottle = overlay.querySelector('.pour-bottle');
  const stream = overlay.querySelector('.pour-stream');
  const svg = overlay.querySelector('.glass');
  const target = glassInfo(product.glass).bubbles ? 0.92 : product.glass === 'snifter' ? 0.9 : 0.85;

  if (reducedMotion()) {
    setLevel(svg, target);
    await new Promise(r => setTimeout(r, 700));
  } else {
    requestAnimationFrame(() => overlay.classList.add('show'));
    await bottle.animate([
      { transform: 'translate(0,0) rotate(0deg)' },
      { transform: 'translate(62px,-58px) rotate(112deg)' },
    ], { duration: 650, easing: 'cubic-bezier(.4,.1,.2,1)', fill: 'forwards' }).finished;
    stream.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)' }],
      { duration: 160, easing: 'ease-in', fill: 'forwards' });
    await animateLevel(svg, 0, target, 1250);
    stream.animate([{ transform: 'scaleY(1)', transformOrigin: 'bottom' }, { transform: 'scaleY(0)', transformOrigin: 'bottom' }],
      { duration: 180, fill: 'forwards' });
    const back = bottle.animate([
      { transform: 'translate(62px,-58px) rotate(112deg)' },
      { transform: 'translate(0,0) rotate(0deg)' },
    ], { duration: 500, easing: 'ease-in-out', fill: 'forwards' }).finished;
    if (ice) {
      overlay.querySelectorAll('.pour-ice span').forEach((cube, i) =>
        cube.animate([{ transform: 'translateY(-90px) rotate(0)', opacity: 0 }, { opacity: 1, offset: .3 }, { transform: `translateY(0) rotate(${(i - 1) * 25}deg)`, opacity: 1 }],
          { duration: 420, delay: i * 110, easing: 'cubic-bezier(.3,1.4,.6,1)', fill: 'forwards' }));
    }
    await back;
    overlay.querySelector('.pour-caption').textContent = 'Proost! Toegevoegd aan je bestelling.';
    await new Promise(r => setTimeout(r, ice ? 650 : 450));
    overlay.classList.remove('show');
    await new Promise(r => setTimeout(r, 220));
  }
  overlay.remove();
}

// ---------------------------------------------------------------------------
/** Glass loader: the glass keeps refilling; its base rises with progress (0..1).
 *  Returns { update(progress, mode), stop() }. mode: 'loop' | 'full' | 'empty'. */
export function glassLoader(svg) {
  let progress = 0.15, mode = 'loop', raf = 0, stopped = false, t0 = performance.now();
  const cycle = 2600;
  function frame(now) {
    if (stopped) return;
    if (mode === 'full') setLevel(svg, 1);
    else if (mode === 'empty') setLevel(svg, 0);
    else {
      const base = Math.min(0.85, progress);
      const p = ((now - t0) % cycle) / cycle;
      // fill smoothly to the brim, then quickly settle back to the base level
      const fill = p < 0.78 ? (1 - Math.cos((p / 0.78) * Math.PI)) / 2 : 1 - (p - 0.78) / 0.22;
      setLevel(svg, base + (1 - base) * fill);
    }
    raf = requestAnimationFrame(frame);
  }
  if (reducedMotion()) {
    return {
      update(p, m = 'loop') { progress = p; mode = m; setLevel(svg, m === 'full' ? 1 : m === 'empty' ? 0 : p); },
      stop() {},
    };
  }
  raf = requestAnimationFrame(frame);
  return {
    update(p, m = 'loop') { progress = p; mode = m; },
    stop() { stopped = true; cancelAnimationFrame(raf); },
  };
}
