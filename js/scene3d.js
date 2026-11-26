/* SIPS 3D: realistic bottles, glasses, pour animation and glass loader (three.js r170, MIT).
 * Loaded lazily by app.js. If WebGL2 is unavailable the 2D drawings (drinkart.js) stay.
 * Units are centimetres; y = 0 is the top of the wooden shelf.
 */
import * as THREE from './vendor/three.module.min.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export function supported() {
  try { return !!document.createElement('canvas').getContext('webgl2'); } catch { return false; }
}

// ---------------------------------------------------------------- specs
const GLASSES = {
  tumbler:  { inner: [[0,1.4],[3.6,1.4],[3.75,3],[3.95,9]], wall: .18, fill: 5.6, ice: 3 },
  highball: { inner: [[0,1.2],[2.85,1.2],[3.05,14.5]], wall: .15, fill: 12.5, ice: 4 },
  wine:     { inner: [[0,9.3],[1.6,9.6],[2.6,10.3],[3.3,11.3],[3.75,12.6],[3.95,14],[3.85,15.6],[3.5,17],[3.15,18.2]], wall: .1, stem: [8.8,.32], foot: 3.4, fill: 12.9 },
  flute:    { inner: [[0,9.6],[.8,10],[1.3,10.8],[1.65,12.5],[1.85,15],[1.95,18],[2,21.5]], wall: .09, stem: [9.1,.28], foot: 2.9, fill: 19, bubbles: true },
  snifter:  { inner: [[0,6.2],[2,6.5],[3.3,7.4],[4.2,8.8],[4.5,10.3],[4.3,11.8],[3.7,13.1],[3,14]], wall: .1, stem: [5.7,.42], foot: 3.6, fill: 8.6, ice: 1 },
  copa:     { inner: [[0,9.1],[2.4,9.5],[3.8,10.6],[4.7,12.2],[5.2,14.2],[5.35,16.2],[5.35,17.8]], wall: .1, stem: [8.6,.34], foot: 3.8, fill: 15.6, ice: 5, bubbles: true },
};
const BOTTLES = {
  whisky:     { sq: true,  r: 3.8, h: 16,  sh: 2.4, nr: 1.25, nh: 5,   cap: ['#1b1b1b', 2.4, 1.6, .3], tint: '#f4e7cf', dist: 30, rough: .04 },
  bourbon:    { sq: true,  r: 3.6, h: 15,  sh: 3,   nr: 1.2,  nh: 5,   cap: ['#7a1a12', 3.2, 1.6, .2], tint: '#f0dcc0', dist: 25, rough: .04 },
  rum:        { sq: false, r: 4.2, h: 13,  sh: 4,   nr: 1.3,  nh: 5,   cap: ['#b28a3e', 2.6, 1.7, .9], tint: '#6b4526', dist: 6,  rough: .05 },
  gin:        { sq: false, r: 3.6, h: 15,  sh: 4,   nr: 1.2,  nh: 4,   cap: ['#2c4a52', 2.4, 1.5, .4], tint: '#d7eef0', dist: 40, rough: .03 },
  vodka:      { sq: false, r: 3.3, h: 19,  sh: 5,   nr: 1.1,  nh: 4,   cap: ['#cfd3d6', 2.2, 1.35, 1],  tint: '#eef4f8', dist: 60, rough: .28 },
  tequila:    { sq: true,  r: 3.7, h: 11,  sh: 1.6, nr: 1.5,  nh: 3,   cap: ['#7a5a34', 3.6, 2.1, 0], tint: '#f6efe2', dist: 40, rough: .04 },
  cognac:     { sq: false, r: 4.7, h: 9.5, sh: 5.5, nr: 1.2,  nh: 5.5, cap: ['#c9a45c', 2.8, 1.5, 1], tint: '#7a4a22', dist: 8,  rough: .04 },
  wine_red:   { sq: false, r: 3.7, h: 19,  sh: 4,   nr: 1.3,  nh: 8,   cap: ['#5c0f1b', 4.5, 1.45, .5], tint: '#1f3d1c', dist: 1.2, rough: .05 },
  wine_white: { sq: false, r: 3.7, h: 19,  sh: 4,   nr: 1.3,  nh: 8,   cap: ['#c9b37a', 4.5, 1.45, .9], tint: '#a9bf6a', dist: 5, rough: .05 },
  champagne:  { sq: false, r: 4.1, h: 17,  sh: 7,   nr: 1.5,  nh: 6,   cap: ['#d4b25e', 8,   1.7, 1], tint: '#1c3519', dist: 1,  rough: .05, slope: true },
};

// ---------------------------------------------------------------- textures
function canvasTex(w, h, draw, srgb = true) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
let woodTex, backTex;
function wood() {
  return woodTex ||= canvasTex(1024, 256, (g, w, h) => {
    g.fillStyle = '#5a3420'; g.fillRect(0, 0, w, h);
    let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 220; i++) {
      const y = rnd() * h, a = .12 + rnd() * .3;
      g.strokeStyle = rnd() > .5 ? `rgba(30,15,8,${a})` : `rgba(120,78,44,${a})`;
      g.lineWidth = .6 + rnd() * 2.2; g.beginPath(); g.moveTo(0, y);
      for (let x = 0; x <= w; x += 32) g.lineTo(x, y + Math.sin(x / 90 + i) * 2.5 + (rnd() - .5) * 1.5);
      g.stroke();
    }
    const grd = g.createLinearGradient(0, 0, 0, h); grd.addColorStop(0, 'rgba(255,220,170,.10)'); grd.addColorStop(1, 'rgba(0,0,0,.35)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}
function backdrop() {
  return backTex ||= canvasTex(512, 512, (g, w, h) => {
    const lin = g.createLinearGradient(0, 0, 0, h); lin.addColorStop(0, '#1a3a55'); lin.addColorStop(.65, '#0f2234'); lin.addColorStop(1, '#0a1622');
    g.fillStyle = lin; g.fillRect(0, 0, w, h);
    const rad = g.createRadialGradient(w * .5, h * .12, 10, w * .5, h * .2, w * .55);
    rad.addColorStop(0, 'rgba(255,214,150,.42)'); rad.addColorStop(1, 'rgba(255,214,150,0)');
    g.fillStyle = rad; g.fillRect(0, 0, w, h);
    let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 2600; i++) { g.fillStyle = `rgba(${rnd() > .5 ? '255,255,255' : '0,0,0'},${rnd() * .045})`; g.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
  });
}
function labelTex(name, category, dark) {
  return canvasTex(640, 400, (g, w, h) => {
    g.fillStyle = dark ? '#151515' : '#efe4cb'; g.fillRect(0, 0, w, h);
    let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 1800; i++) { g.fillStyle = `rgba(${dark ? '255,255,255' : '90,60,20'},${rnd() * .05})`; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
    g.strokeStyle = '#c9a45c'; g.lineWidth = 6; g.strokeRect(14, 14, w - 28, h - 28);
    g.lineWidth = 2; g.strokeRect(28, 28, w - 56, h - 56);
    g.textAlign = 'center'; g.fillStyle = '#b08a43';
    g.font = '600 34px Georgia, serif'; g.letterSpacing = '14px'; g.fillText('S I P S', w / 2, 92);
    g.letterSpacing = '0px';
    g.fillStyle = dark ? '#f1e6cf' : '#1f2e3a';
    let size = 66; const text = String(name);
    do { g.font = `${size}px Georgia, serif`; size -= 2; } while (g.measureText(text).width > w - 90 && size > 26);
    g.fillText(text, w / 2, 215);
    g.fillStyle = '#c9a45c'; g.fillRect(w / 2 - 90, 250, 180, 2);
    g.fillStyle = dark ? '#c9a45c' : '#6d5a36'; g.font = 'italic 30px Georgia, serif'; g.fillText(String(category || ''), w / 2, 305);
  });
}

// ---------------------------------------------------------------- materials
const mGlass = () => new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: .025, transmission: 1, thickness: .4, ior: 1.5, clearcoat: 1, clearcoatRoughness: .03, specularIntensity: 1, envMapIntensity: 1.3 });
const mLiquid = color => {
  const c = new THREE.Color(color);
  const light = c.getHSL({}).l > .72;
  return new THREE.MeshPhysicalMaterial({ color: light ? c.clone().lerp(new THREE.Color('#ffffff'), .5) : c, roughness: .06, transmission: light ? 1 : .8,
    thickness: 3, ior: 1.34, attenuationColor: c, attenuationDistance: light ? 6 : 3.2, clearcoat: 1, clearcoatRoughness: .03, envMapIntensity: 1 });
};
// liquid seen through a (tinted) bottle: opaque so the bottle's glass can show it
const mBottleLiquid = color => new THREE.MeshStandardMaterial({ color: new THREE.Color(color).multiplyScalar(.55), roughness: .25, envMapIntensity: .5 });
const mIce = () => new THREE.MeshPhysicalMaterial({ color: '#f4fbff', roughness: .22, transparent: true, opacity: .72, clearcoat: 1, clearcoatRoughness: .08, envMapIntensity: 2, depthWrite: false, emissive: '#2a3a44' });

// ---------------------------------------------------------------- geometry helpers
const v2 = pts => pts.map(([x, y]) => new THREE.Vector2(Math.max(0, x), y));
function radiusAt(inner, y) {
  if (y <= inner[1][1]) return inner[1][0];
  for (let i = 1; i < inner.length - 1; i++) {
    const [r0, y0] = inner[i], [r1, y1] = inner[i + 1];
    if (y <= y1) return r0 + (r1 - r0) * (y - y0) / (y1 - y0 || 1);
  }
  return inner[inner.length - 1][0];
}
function smooth(pts, steps = 6) {
  // Catmull-Rom through the profile points for round curves
  const curve = new THREE.SplineCurve(pts.map(([x, y]) => new THREE.Vector2(x, y)));
  return curve.getPoints(Math.max(8, pts.length * steps)).map(p => [Math.max(0, p.x), p.y]);
}

function buildGlass(spec) {
  const g = new THREE.Group();
  const inner = spec.inner.slice(1); // without the centre point
  const bottom = spec.inner[0][1];
  const curve = smooth(inner);
  const outerBottom = spec.stem ? bottom - .45 : 0;
  const path = [[0, outerBottom], [curve[0][0] + spec.wall, outerBottom + (spec.stem ? .05 : 0)]];
  for (const [r, y] of curve) path.push([r + spec.wall, y]);
  const [rimR, rimY] = curve[curve.length - 1];
  path.push([rimR + spec.wall * .5, rimY + .06]);
  for (let i = curve.length - 1; i >= 0; i--) path.push(curve[i]);
  path.push([0, bottom]);
  const mat = mGlass(); mat.depthWrite = false;
  const shell = new THREE.Mesh(new THREE.LatheGeometry(v2(path), 72), mat);
  shell.renderOrder = 1;
  g.add(shell);
  if (spec.stem) {
    const [h, r] = spec.stem;
    const stem = new THREE.Mesh(new THREE.LatheGeometry(v2([[0, 0], [spec.foot, 0], [spec.foot, .18], [r * 1.6, .45], [r, 1.2], [r, h - .8], [r * 1.9, h], [0, h + .3]]), 64), mat);
    g.add(stem);
  }
  g.userData = { spec, curve, bottom, rimY };
  return g;
}

function liquidGeometry(curve, bottom, level) {
  const pts = [[0, bottom + .02]];
  for (const [r, y] of curve) { if (y >= level) break; pts.push([r - .04, y]); }
  pts.push([radiusAt([[0, bottom], ...curve], level) - .04, level]);
  pts.push([0, level]);
  return new THREE.LatheGeometry(v2(pts), 64);
}

function buildBottle(spec, product) {
  const g = new THREE.Group();
  const { r, h, sh, nr, nh } = spec;
  const top = h + sh + nh;
  const glass = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: spec.rough, transmission: 1, thickness: 1.2, ior: 1.5,
    attenuationColor: new THREE.Color(spec.tint), attenuationDistance: spec.dist, clearcoat: 1, clearcoatRoughness: .04, envMapIntensity: 1.2 });
  const shoulder = spec.slope
    ? [[r, h], [r * .93, h + sh * .35], [r * .55, h + sh * .78], [nr, h + sh]]
    : [[r, h], [r * .9, h + sh * .45], [r * .55, h + sh * .85], [nr, h + sh]];
  if (spec.sq) {
    const s = new THREE.Shape(); const w = r * 2, d = r * 1.5, c = 1.1;
    s.moveTo(-w / 2 + c, -d / 2); s.lineTo(w / 2 - c, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + c);
    s.lineTo(w / 2, d / 2 - c); s.quadraticCurveTo(w / 2, d / 2, w / 2 - c, d / 2); s.lineTo(-w / 2 + c, d / 2);
    s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - c); s.lineTo(-w / 2, -d / 2 + c); s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + c, -d / 2);
    const body = new THREE.ExtrudeGeometry(s, { depth: h - .6, bevelEnabled: true, bevelThickness: .3, bevelSize: .25, bevelSegments: 4, curveSegments: 10 });
    body.rotateX(-Math.PI / 2); body.translate(0, .3, 0);
    g.add(new THREE.Mesh(body, glass));
    const top2 = smooth([[r * .72, h - .1], [r * .6, h + sh * .5], [nr, h + sh]], 4);
    g.add(new THREE.Mesh(new THREE.LatheGeometry(v2([[0, h - .1], ...top2, [nr, top], [nr + .12, top - .05], [0, top]]), 48), glass));
    // liquid inside the square body
    const ls = new THREE.Shape(); const lw = w - .7, ld = d - .7;
    ls.moveTo(-lw / 2, -ld / 2); ls.lineTo(lw / 2, -ld / 2); ls.lineTo(lw / 2, ld / 2); ls.lineTo(-lw / 2, ld / 2);
    const liq = new THREE.ExtrudeGeometry(ls, { depth: h * .82, bevelEnabled: false }); liq.rotateX(-Math.PI / 2); liq.translate(0, .45, 0);
    if (new THREE.Color(product.liquid_color).getHSL({}).l <= .72) g.add(new THREE.Mesh(liq, mBottleLiquid(product.liquid_color)));
    const label = new THREE.Mesh(new THREE.PlaneGeometry(w * .78, h * .42), new THREE.MeshStandardMaterial({ map: labelTex(product.name, product.category, false), roughness: .7 }));
    label.position.set(0, h * .48, d / 2 + .32); g.add(label);
  } else {
    const prof = smooth([[r, .35], [r, h * .5], ...shoulder], 5);
    const path = [[0, 0], [r - .45, 0], [r - .1, .12], ...prof, [nr, top - .25], [nr + .14, top - .15], [nr + .14, top], [0, top]];
    g.add(new THREE.Mesh(new THREE.LatheGeometry(v2(path), 64), glass));
    const fillH = h * .9;
    if (new THREE.Color(product.liquid_color).getHSL({}).l <= .72)
      g.add(new THREE.Mesh(new THREE.LatheGeometry(v2([[0, .25], [r - .35, .25], [r - .3, fillH], [0, fillH]]), 48), mBottleLiquid(product.liquid_color)));
    const dark = ['champagne', 'cognac'].includes(product.bottle);
    const lh = Math.min(h * .45, 8.5);
    const label = new THREE.Mesh(new THREE.CylinderGeometry(r + .04, r + .04, lh, 64, 1, true, -1.05, 2.1),
      new THREE.MeshStandardMaterial({ map: labelTex(product.name, product.category, dark), roughness: .65 }));
    label.position.y = h * .42; g.add(label);
  }
  const [capColor, capH, capR, metal] = spec.cap;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(capR * .92, capR, capH, 40),
    new THREE.MeshStandardMaterial({ color: capColor, metalness: metal, roughness: metal > .5 ? .28 : .55 }));
  cap.position.y = top - capH / 2 + .35; g.add(cap);
  g.userData = { top: top + .3, mouthY: top };
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  return g;
}

async function photoBottle(product, height = 28) {
  const tex = await new THREE.TextureLoader().setCrossOrigin('anonymous').loadAsync(product.image_url);
  tex.colorSpace = THREE.SRGBColorSpace;
  const a = tex.image.width / tex.image.height;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(height * a, height), new THREE.MeshBasicMaterial({ map: tex, alphaTest: .35, side: THREE.DoubleSide }));
  plane.position.y = height / 2;
  const g = new THREE.Group(); g.add(plane); g.userData = { top: height, mouthY: height, photo: true };
  return g;
}

async function makeBottle(product) {
  if (product.image_url && /^https:\/\//.test(product.image_url)) {
    try { return await photoBottle(product); } catch { /* CORS or load error: draw instead */ }
  }
  return buildBottle(BOTTLES[product.bottle] || BOTTLES.whisky, product);
}

function makeIce(n, spec, level) {
  const g = new THREE.Group();
  const geo = new THREE.BoxGeometry(1.9, 1.9, 1.9, 2, 2, 2);
  const pos = geo.attributes.position; // soften edges a little
  for (let i = 0; i < pos.count; i++) { const v = new THREE.Vector3().fromBufferAttribute(pos, i); v.multiplyScalar(1 - .08 * (Math.abs(v.x) + Math.abs(v.y) + Math.abs(v.z)) / 3); pos.setXYZ(i, v.x, v.y, v.z); }
  geo.computeVertexNormals();
  const mat = mIce();
  const rr = radiusAt(spec.inner, level) - 1.3;
  for (let i = 0; i < n; i++) {
    const cube = new THREE.Mesh(geo, mat); cube.renderOrder = 3;
    const a = i / n * Math.PI * 2 + .6;
    cube.position.set(Math.cos(a) * rr * (n > 1 ? .55 : 0), level - .55 + (i % 2) * .35, Math.sin(a) * rr * (n > 1 ? .55 : 0));
    cube.rotation.set(i * .7, i * 1.3, i * .4);
    cube.castShadow = true;
    g.add(cube);
  }
  return g;
}

function makeBubbles(spec, level) {
  const geo = new THREE.SphereGeometry(.07, 8, 6);
  const mesh = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: '#fff8e0', transparent: true, opacity: .8 }), 26);
  const seeds = Array.from({ length: 26 }, (_, i) => ({ a: i * 2.4, r: Math.random(), o: Math.random(), s: .5 + Math.random() }));
  const m = new THREE.Matrix4();
  mesh.userData.update = (t, lv) => {
    const b = spec.inner[0][1] + .3, top = lv;
    seeds.forEach((q, i) => {
      const p = (t * .25 * q.s + q.o) % 1, y = b + (top - b) * p;
      const rr = Math.max(.1, radiusAt(spec.inner, y) - .5) * q.r;
      m.makeTranslation(Math.cos(q.a) * rr, y, Math.sin(q.a) * rr); mesh.setMatrixAt(i, m);
    });
    mesh.visible = top > b + .5; mesh.instanceMatrix.needsUpdate = true;
  };
  mesh.userData.update(0, level);
  return mesh;
}

// ---------------------------------------------------------------- stage
const envCache = new WeakMap();
function makeStage(renderer, { width = 46, glow = true } = {}) {
  const scene = new THREE.Scene();
  if (!envCache.has(renderer)) {
    const pm = new THREE.PMREMGenerator(renderer);
    envCache.set(renderer, pm.fromScene(new RoomEnvironment(), .04).texture); pm.dispose();
  }
  scene.environment = envCache.get(renderer);
  scene.environmentIntensity = .55;
  const back = new THREE.Mesh(new THREE.PlaneGeometry(120, 90), new THREE.MeshBasicMaterial({ map: backdrop() }));
  back.position.set(0, 22, -22); scene.add(back);
  const shelfTex = wood().clone(); shelfTex.needsUpdate = true; shelfTex.wrapS = THREE.RepeatWrapping; shelfTex.repeat.set(width / 46, 1);
  const shelf = new THREE.Mesh(new THREE.BoxGeometry(width, 2, 16), new THREE.MeshPhysicalMaterial({ map: shelfTex, roughness: .42, metalness: 0, clearcoat: .4 }));
  shelf.position.set(0, -1, 0); shelf.receiveShadow = true; scene.add(shelf);
  const brass = new THREE.Mesh(new THREE.BoxGeometry(width, .25, .25), new THREE.MeshStandardMaterial({ color: '#c9a45c', metalness: 1, roughness: .3 }));
  brass.position.set(0, -.1, 8); scene.add(brass);
  const spot = new THREE.SpotLight('#ffd9a0', 2600, 120, .5, .65, 2);
  spot.position.set(-6, 42, 18); spot.target.position.set(0, 6, 0);
  spot.castShadow = true; spot.shadow.mapSize.set(1024, 1024); spot.shadow.bias = -.0004; spot.shadow.radius = 4;
  scene.add(spot, spot.target);
  const rim = new THREE.DirectionalLight('#9cc8ff', glow ? 1.4 : 1); rim.position.set(14, 18, -16); scene.add(rim);
  scene.add(new THREE.AmbientLight('#406080', .35));
  return scene;
}

function makeRenderer(canvas, w, h) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: !!canvas.dataset.snap, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.05;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  return renderer;
}

function disposeScene(scene) {
  scene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { if (m.map && m.map !== backTex && m.map !== woodTex) m.map.dispose(); m.dispose(); }
  });
}

// Glass with liquid, ice and bubbles; returns handles to change the level.
function drinkGlass(product, ice) {
  const spec = GLASSES[product.glass] || GLASSES.tumbler;
  const group = buildGlass(spec);
  const { curve, bottom } = group.userData;
  const liquidMat = mLiquid(product.liquid_color);
  const liquid = new THREE.Mesh(liquidGeometry(curve, bottom, bottom + .01), liquidMat);
  liquid.castShadow = true; liquid.renderOrder = 2;
  group.add(liquid);
  let iceGroup = null, bubbles = null, current = 0;
  const maxY = spec.fill;
  const setLevel = lv => {
    current = Math.max(0, Math.min(1, lv));
    const y = bottom + (maxY - bottom) * current;
    liquid.geometry.dispose();
    liquid.geometry = liquidGeometry(curve, bottom, Math.max(bottom + .02, y));
    liquid.visible = current > .01;
    // ice floats on the surface but rests on the bottom when the glass is nearly empty
    if (iceGroup) iceGroup.position.y = Math.max(y, bottom + 1.3) - maxY + (current < .05 ? -100 : 0);
  };
  const setIce = on => {
    if (iceGroup) { group.remove(iceGroup); iceGroup.traverse(o => o.geometry?.dispose()); iceGroup = null; }
    if (on && spec.ice) { iceGroup = makeIce(spec.ice, spec, maxY); group.add(iceGroup); setLevel(current); }
  };
  if (spec.bubbles) { bubbles = makeBubbles(spec, bottom); group.add(bubbles); }
  setIce(ice);
  return { group, spec, setLevel, setIce, tick: t => bubbles?.userData.update(t, bottom + (maxY - bottom) * current), level: () => current };
}

function frameCamera(cam, h, targetY) {
  const dist = (h / 2) / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
  cam.position.set(0, targetY + h * .18, dist * 1.02);
  cam.lookAt(0, targetY, 0);
}

// ---------------------------------------------------------------- snapshots for menu cards
let snapRenderer = null, snapCanvas = null;
const SNAP_W = 520, SNAP_H = 470;
export async function snapshot(product) {
  if (!snapRenderer) {
    snapCanvas = document.createElement('canvas'); snapCanvas.dataset.snap = '1';
    snapRenderer = makeRenderer(snapCanvas, SNAP_W, SNAP_H); snapRenderer.setPixelRatio(1); snapRenderer.setSize(SNAP_W, SNAP_H, false);
  }
  const scene = makeStage(snapRenderer);
  const bottle = await makeBottle(product); bottle.position.x = -5.2; bottle.rotation.y = bottle.userData.photo ? 0 : -.18; scene.add(bottle);
  const glass = drinkGlass(product, !!product.ice); glass.group.position.set(5.6, 0, 2.5); glass.setLevel(.85); scene.add(glass.group);
  const cam = new THREE.PerspectiveCamera(24, SNAP_W / SNAP_H, 1, 400);
  const tall = Math.max(bottle.userData.top, glass.group.userData.rimY) + 4;
  frameCamera(cam, Math.max(30, tall * 1.08), Math.max(30, tall * 1.08) * .43);
  snapRenderer.render(scene, cam);
  const blob = await new Promise(res => snapCanvas.toBlob(res, 'image/webp', .9));
  disposeScene(scene);
  return URL.createObjectURL(blob);
}

// ---------------------------------------------------------------- live views
function live(container, build) {
  const canvas = document.createElement('canvas'); canvas.className = 'canvas3d';
  container.replaceChildren(canvas);
  const rect = () => container.getBoundingClientRect();
  let { width, height } = rect(); width ||= 320; height ||= 300;
  const renderer = makeRenderer(canvas, width, height);
  const scene = makeStage(renderer);
  const cam = new THREE.PerspectiveCamera(24, width / height, 1, 400);
  let raf = 0, stopped = false, t0 = performance.now();
  const ctx = { scene, cam, renderer, onFrame: null };
  const ro = new ResizeObserver(() => { const r = rect(); if (r.width && r.height) { renderer.setSize(r.width, r.height, false); cam.aspect = r.width / r.height; cam.updateProjectionMatrix(); } });
  ro.observe(container);
  const loop = () => {
    if (stopped) return;
    // window.__sipsTimeScale only exists in tests (slow motion); normal speed otherwise
    ctx.onFrame?.((performance.now() - t0) / 1000 * (window.__sipsTimeScale || 1));
    renderer.render(scene, cam);
    raf = requestAnimationFrame(loop);
  };
  // the animation clock starts at the first frame, not while models are still being built
  const ready = Promise.resolve(build(ctx)).then(() => { renderer.compile(scene, cam); t0 = performance.now(); raf = requestAnimationFrame(loop); });
  return {
    ready, ctx,
    dispose() { stopped = true; cancelAnimationFrame(raf); ro.disconnect(); disposeScene(scene); envCache.get(renderer)?.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); canvas.remove(); },
  };
}

/** Detail view: bottle + glass, slowly turning, drag to spin. */
export function mountShowcase(container, product, { ice }) {
  let glass, bottle, spin = 0, drag = null;
  const view = live(container, async ({ scene, cam }) => {
    bottle = await makeBottle(product); bottle.position.x = -5.2; scene.add(bottle);
    glass = drinkGlass(product, ice); glass.group.position.set(5.6, 0, 2.5); glass.setLevel(.85); scene.add(glass.group);
    const tall = Math.max(bottle.userData.top, glass.group.userData.rimY) + 4;
    frameCamera(cam, Math.max(30, tall * 1.08), Math.max(30, tall * 1.08) * .43);
  });
  view.ctx.onFrame = t => {
    if (!glass) return;
    if (!drag) spin *= .96;
    const sway = reduced() ? 0 : Math.sin(t * .5) * .22;
    if (!bottle.userData.photo) bottle.rotation.y = sway + spin;
    glass.group.rotation.y = -sway * .6 + spin * .5;
    glass.tick(t);
  };
  const canvas = () => container.querySelector('canvas');
  container.addEventListener('pointerdown', e => { drag = e.clientX; canvas()?.setPointerCapture?.(e.pointerId); });
  container.addEventListener('pointermove', e => { if (drag !== null) { spin += (e.clientX - drag) * .012; drag = e.clientX; } });
  container.addEventListener('pointerup', () => { drag = null; });
  container.addEventListener('pointercancel', () => { drag = null; });
  return { ready: view.ready, setIce: on => glass?.setIce(on), dispose: view.dispose };
}

/** Full-screen pour animation. Resolves when finished. */
export async function pour3D(product, { ice, caption = '' }) {
  const overlay = document.createElement('div');
  overlay.className = 'pour-overlay p3d';
  overlay.innerHTML = '<div class="pour3d-stage"></div><p class="pour-caption"></p>';
  overlay.querySelector('.pour-caption').textContent = caption;
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add('show'));
  let bottle, pivot, glass, stream, cubes, target, done;
  const finished = new Promise(r => { done = r; });
  const view = live(overlay.querySelector('.pour3d-stage'), async ({ scene, cam }) => {
    glass = drinkGlass(product, false); glass.group.position.set(2.5, 0, 0); scene.add(glass.group);
    const spec = glass.spec;
    bottle = await makeBottle(product);
    pivot = new THREE.Group(); bottle.position.y = -bottle.userData.mouthY; pivot.add(bottle); scene.add(pivot);
    const rimY = glass.group.userData.rimY;
    target = new THREE.Vector3(2.5 - radiusAt(spec.inner, rimY) * .25, rimY + 2.8, 0);
    stream = new THREE.Mesh(new THREE.CylinderGeometry(.13, .1, 1, 12, 1, true), mLiquid(product.liquid_color));
    stream.visible = false; scene.add(stream);
    if (ice && spec.ice) { cubes = makeIce(spec.ice, spec, spec.fill); cubes.position.y = 40; glass.group.add(cubes); }
    const H = Math.max(27, rimY + 10); frameCamera(cam, H, H * .45);
  });
  const T = reduced() ? { in: .01, pour: .4, out: .01 } : { in: .75, pour: 1.45, out: .6 };
  const ease = p => p < .5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
  const start = new THREE.Vector3(-14, 34, 0), tilt = -2.15;
  view.ctx.onFrame = t => {
    if (!pivot) return;
    glass.tick(t);
    const t1 = T.in, t2 = t1 + T.pour, t3 = t2 + T.out;
    const spec = glass.spec, bottom = spec.inner[0][1];
    if (t < t1) { const p = ease(t / t1); pivot.position.lerpVectors(start, target, p); pivot.rotation.z = -.9 + (tilt + .9) * p; }
    else if (t < t2) {
      const p = (t - t1) / T.pour;
      pivot.position.copy(target); pivot.rotation.z = tilt - Math.sin(p * Math.PI) * .12;
      glass.setLevel(ease(Math.min(1, p * 1.08)) * .92);
      const surface = bottom + (spec.fill - bottom) * glass.level() + glass.group.position.y;
      const top = target.y - .3, len = Math.max(.1, top - surface);
      stream.visible = p < .97; stream.scale.y = len; stream.position.set(target.x + .25, surface + len / 2, 0);
    } else if (t < t3) {
      stream.visible = false; const p = ease((t - t2) / T.out);
      pivot.position.lerpVectors(target, start, p); pivot.rotation.z = tilt + (-.9 - tilt) * p;
      if (cubes) cubes.position.y = Math.max(0, 14 * (1 - Math.min(1, (t - t2) / (T.out * .8))) ** 2);
    } else if (t < t3 + .7) { if (cubes) cubes.position.y = 0; overlay.querySelector('.pour-caption').textContent = 'Proost! Toegevoegd aan je bestelling.'; }
    else done();
  };
  await view.ready; await finished;
  overlay.classList.remove('show'); await new Promise(r => setTimeout(r, 220));
  view.dispose(); overlay.remove();
}

/** Waiting screen: the ordered glass keeps refilling; base level follows progress. */
export function mountGlassLoader(container, product, { ice }) {
  let glass, progress = .15, mode = 'loop';
  const view = live(container, ({ scene, cam }) => {
    glass = drinkGlass(product, ice); scene.add(glass.group);
    frameCamera(cam, Math.max(13, glass.group.userData.rimY * 1.25), glass.group.userData.rimY * .52);
  });
  const cycle = 2.6;
  view.ctx.onFrame = t => {
    if (!glass) return;
    glass.group.rotation.y = reduced() ? 0 : Math.sin(t * .35) * .5;
    glass.tick(t);
    if (mode === 'full') glass.setLevel(1);
    else if (mode === 'empty') glass.setLevel(0);
    else if (reduced()) glass.setLevel(progress);
    else {
      const base = Math.min(.85, progress), p = (t % cycle) / cycle;
      const f = p < .78 ? (1 - Math.cos(p / .78 * Math.PI)) / 2 : 1 - (p - .78) / .22;
      glass.setLevel(base + (1 - base) * f);
    }
  };
  return { ready: view.ready, update(p, m = 'loop') { progress = p; mode = m; }, dispose: view.dispose };
}
