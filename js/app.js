/* SIPS guest app: menu, pour animation, cart, cash/online checkout, live receipt.
 * Ordering/payment logic lives in guest-api.js; live status in guest-status.js.
 */
import {getTableTokenFromUrl,getGuestMenu,createCashOrder,hasPendingCashOrder,retryPendingCashOrder,
  createOnlineOrder,hasPendingOnlineOrder,retryPendingOnlineOrder,discardPendingOnlineOrder,resumeOnlinePayment} from './guest-api.js';
import {loadReceipt,loadRecord,startTracking,stopTracking} from './guest-status.js';
import {glassSVG,bottleHTML,pour,glassLoader,servesIce} from './drinkart.js';

const $ = sel => document.querySelector(sel);
const app = $('#app'), sheet = $('#sheet'), cartbar = $('#cartbar'), toastEl = $('#toast');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = cents => new Intl.NumberFormat('nl-NL',{style:'currency',currency:'EUR'}).format(cents/100);

let token, restaurant, tableNumber, products = [], category = 'Alles';
let cart = [];          // [{productId, optionId, qty, note}]
let view = 'menu';      // menu | checkout | receipt | recovery
let method = 'online', sending = false, failure = '';
let pendingCash = false, pendingOnline = false, receipt = null, loader = null, toastTimer;

// ---- 3D (three.js), loaded lazily; the 2D drawings stay as fallback ----
let three = null;            // the scene3d module once loaded
const shots = new Map();     // product key -> rendered 3D image URL
const shotKey = p => p.id + '|' + (p.image_url || '');
let threeLoading = null;
function load3D(){
  if (threeLoading) return threeLoading;
  threeLoading = import('./scene3d.js').then(m => m.supported() ? (three = m) : null).catch(() => null);
  return threeLoading;
}
let shooting = false;
async function renderShots(){
  if (shooting || !(await load3D())) return;
  shooting = true;
  try {
    for (const p of products) {
      if (shots.has(shotKey(p))) continue;
      try { shots.set(shotKey(p), await three.snapshot(p)); } catch { shots.set(shotKey(p), null); }
      const url = shots.get(shotKey(p));
      if (url) document.querySelectorAll(`.drink[data-id="${CSS.escape(p.id)}"] .drink-art`).forEach(el => { el.innerHTML = `<img class="art3d" src="${url}" alt="">`; el.classList.add('is3d'); });
      await new Promise(r => setTimeout(r, 0));
    }
  } finally { shooting = false; }
}

const STATUS = {
  awaiting_payment:   {label:'Wacht op je betaling', step:0, progress:.12},
  awaiting_acceptance:{label:'Wacht op bevestiging van de bar', step:0, progress:.22},
  received:           {label:'Ontvangen aan de bar', step:1, progress:.4},
  preparing:          {label:'Wordt ingeschonken', step:2, progress:.6},
  ready:              {label:'Klaar, komt eraan', step:3, mode:'full'},
  served:             {label:'Geserveerd. Proost!', step:4, mode:'full'},
  rejected:           {label:'Geweigerd door de bar', step:-1, mode:'empty'},
  cancelled:          {label:'Geannuleerd', step:-1, mode:'empty'},
};
const STEPS = ['Besteld','Ontvangen','Inschenken','Klaar','Geserveerd'];

// ---------------------------------------------------------------- helpers
function toast(text){toastEl.textContent=text;toastEl.hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>toastEl.hidden=true,2600);}
const product = id => products.find(p => p.id === id);
const option = (p, id) => p?.options.find(o => o.id === id) || null;
const unit = line => { const p = product(line.productId); return p ? p.price_cents + (option(p, line.optionId)?.price_cents || 0) : 0; };
const total = () => cart.reduce((a, l) => a + unit(l) * l.qty, 0);
const count = () => cart.reduce((a, l) => a + l.qty, 0);
const cartKey = () => 'sips:cart:' + token;
function saveCart(){try{sessionStorage.setItem(cartKey(),JSON.stringify(cart));}catch{}}
function loadCart(){try{const c=JSON.parse(sessionStorage.getItem(cartKey()))||[];return c.filter(l=>product(l.productId)&&(!l.optionId||option(product(l.productId),l.optionId))&&Number.isInteger(l.qty)&&l.qty>0&&l.qty<100);}catch{return [];}}
const items = () => cart.map(l => ({product_id:l.productId, option_id:l.optionId||null, quantity:l.qty, note:l.note||''}));
const snapshot = () => cart.map(l => ({productId:l.productId, optionId:l.optionId||null, qty:l.qty, note:l.note||''}));
function saveDisplay(orderId, snap){try{localStorage.setItem('qr-payment:display:v1:'+orderId,JSON.stringify(snap));}catch{}}
function loadDisplay(orderId){try{return JSON.parse(localStorage.getItem('qr-payment:display:v1:'+orderId))||[];}catch{return [];}}
function restore(snap){cart=[];for(const s of snap||[]){const p=product(s.productId);if(!p)continue;if(s.optionId&&!option(p,s.optionId))continue;cart.push({productId:p.id,optionId:s.optionId||null,qty:s.qty,note:s.note||''});}saveCart();}

function setView(v){view=v;render();window.scrollTo({top:0});}

// ---------------------------------------------------------------- render
function render(){
  loader?.stop(); loader = null;
  if (!restaurant) return;
  $('#table').textContent = 'Tafel ' + tableNumber;
  if (pendingCash || pendingOnline) { app.innerHTML = recoveryHTML(); renderCartbar(); return; }
  if (receipt) { renderReceipt(); renderCartbar(); return; }
  stopTracking();
  app.innerHTML = view === 'checkout' && cart.length ? checkoutHTML() : menuHTML();
  if (view === 'checkout' && !cart.length) view = 'menu';
  renderCartbar();
  if (view === 'menu') void renderShots();
}

function renderCartbar(){
  const show = view === 'menu' && !receipt && !pendingCash && !pendingOnline && count() > 0;
  cartbar.hidden = !show;
  if (show) cartbar.innerHTML = `<span><strong>${count()}</strong> ${count()===1?'drankje':'drankjes'}</span><span>Bekijk bestelling · <strong>${money(total())}</strong> →</span>`;
}

function categories(){ return ['Alles', ...new Set(products.map(p => p.category))]; }

function cardHTML(p){
  const shot = shots.get(shotKey(p));
  return `<button class="drink" data-id="${esc(p.id)}" aria-label="${esc(p.name)}, ${esc(money(p.price_cents))}. Bekijken en bestellen">
    ${shot ? `<span class="drink-art is3d"><img class="art3d" src="${shot}" alt=""></span>` : `<span class="drink-art"><span class="spot"></span><span class="bottle">${bottleHTML(p)}</span><span class="glass-wrap">${glassSVG({glass:p.glass,color:p.liquid_color,level:.62,ice:p.ice,label:p.name})}</span><span class="shelf"></span></span>`}
    <span class="drink-info"><span class="drink-name">${esc(p.name)}</span><span class="drink-desc">${esc(p.description)}</span><span class="drink-price">${money(p.price_cents)}</span></span>
  </button>`;
}

function menuHTML(){
  const list = products.filter(p => category === 'Alles' || p.category === category);
  const groups = category === 'Alles' ? categories().slice(1) : [category];
  return `<section class="hero"><p class="eyebrow">${esc(restaurant.name)} · Tafel ${esc(tableNumber)}</p><h1>Neem plaats.<br>Wij schenken in.</h1><p class="lede">Kies je drank, kijk hoe we inschenken en betaal meteen online of cash aan de bar.</p></section>
  <nav class="cats" aria-label="Categorieën">${categories().map(c => `<button class="cat ${c===category?'on':''}" data-cat="${esc(c)}" aria-pressed="${c===category}">${esc(c)}</button>`).join('')}</nav>
  ${groups.map(g => { const ps = list.filter(p => p.category === g); return ps.length ? `<section class="group"><h2>${esc(g)}</h2><div class="grid">${ps.map(cardHTML).join('')}</div></section>` : ''; }).join('')}
  ${list.length ? '' : '<p class="empty">Hier staat even niets op de kaart.</p>'}
  <footer class="foot">Alcohol wordt alleen geschonken aan personen van 18 jaar en ouder. Allergie of vraag? Spreek de bar gerust aan.<br>Geniet, maar drink met mate.</footer>`;
}

function openDrink(id){
  const p = product(id); if (!p || sending) return;
  let chosen = null, qty = 1;
  const price = () => (p.price_cents + (option(p, chosen)?.price_cents || 0)) * qty;
  sheet.innerHTML = `<div class="sheet-card" role="dialog" aria-modal="true" aria-labelledby="sheet-title">
    <div class="sheet-top"><span class="grab" aria-hidden="true"></span><span class="sheet-top-name">${esc(p.name)}</span><button class="close" aria-label="Sluiten">×</button></div>
    <div class="drink-art big"><span class="spot"></span><span class="bottle">${bottleHTML(p)}</span><span class="glass-wrap" id="sheet-glass">${glassSVG({glass:p.glass,color:p.liquid_color,level:.62,ice:p.ice,label:p.name})}</span><span class="shelf"></span></div>
    <p class="eyebrow">${esc(p.category)}</p><h2 id="sheet-title">${esc(p.name)}</h2><p class="desc">${esc(p.description)}</p>
    ${p.options.length ? `<fieldset class="serve"><legend>Hoe wil je het?</legend>
      <label><input type="radio" name="serve" value="" checked> <span>${p.ice ? 'Zoals de bar het serveert' : 'Puur'}</span></label>
      ${p.options.map(o => `<label><input type="radio" name="serve" value="${esc(o.id)}"> <span>${esc(o.name)}${o.price_cents?` <em>+${money(o.price_cents)}</em>`:''}</span></label>`).join('')}</fieldset>` : ''}
    <label class="note-label" for="note">Opmerking voor de bar <span>(optioneel)</span></label>
    <input id="note" maxlength="180" placeholder="Bijv. extra ijs, schijfje sinaasappel">
    <p class="allergens">${esc(p.allergens)}</p>
    <div class="sheet-actions"><div class="qty" role="group" aria-label="Aantal"><button data-q="-1" aria-label="Eén minder">−</button><output id="qty">1</output><button data-q="1" aria-label="Eén meer">+</button></div>
    <button class="btn gold" id="pour-btn">Schenk in · <span id="sheet-price">${money(price())}</span></button></div>
  </div>`;
  sheet.hidden = false; document.body.classList.add('locked');
  let show3d = null;
  if (three) {
    const art = sheet.querySelector('.drink-art.big');
    art.classList.add('is3d', 'live3d');
    art.setAttribute('aria-label', 'Draai de fles door te vegen'); art.setAttribute('role', 'img');
    show3d = three.mountShowcase(art, p, {ice: !!p.ice});
  }
  const close = () => { show3d?.dispose(); show3d = null; sheet.hidden = true; sheet.innerHTML = ''; document.body.classList.remove('locked'); };
  sheet.querySelector('.close').onclick = close;
  sheet.onclick = e => { if (e.target === sheet) close(); };
  sheet.querySelectorAll('input[name=serve]').forEach(r => r.onchange = () => {
    chosen = r.value || null;
    $('#sheet-price').textContent = money(price());
    const withIce = servesIce(p, option(p, chosen)?.name);
    if (show3d) show3d.setIce(withIce);
    else $('#sheet-glass').innerHTML = glassSVG({glass:p.glass,color:p.liquid_color,level:.62,ice:withIce,label:p.name});
  });
  sheet.querySelectorAll('[data-q]').forEach(b => b.onclick = () => {
    qty = Math.max(1, Math.min(99, qty + Number(b.dataset.q)));
    $('#qty').textContent = qty; $('#sheet-price').textContent = money(price());
  });
  $('#pour-btn').onclick = async () => {
    const note = $('#note').value.trim().slice(0, 180);
    const optName = option(p, chosen)?.name || '';
    close();
    if (three) { try { await three.pour3D(p, {ice: servesIce(p, optName), caption: p.name + ' wordt ingeschonken…'}); } catch { await pour(p, {optionName: optName}); } }
    else await pour(p, {optionName: optName});
    const existing = cart.find(l => l.productId === p.id && (l.optionId||null) === chosen && l.note === note);
    if (existing) existing.qty = Math.min(99, existing.qty + qty);
    else cart.push({productId:p.id, optionId:chosen, qty, note});
    saveCart(); render();
  };
  setTimeout(() => sheet.querySelector('.close').focus(), 30);
}

function lineHTML(l, i){
  const p = product(l.productId), o = option(p, l.optionId);
  return `<li class="line"><span class="line-art">${glassSVG({glass:p.glass,color:p.liquid_color,level:.7,ice:servesIce(p,o?.name),label:p.name})}</span>
    <span class="line-main"><strong>${esc(p.name)}</strong>${o?`<small>${esc(o.name)}</small>`:''}${l.note?`<small>“${esc(l.note)}”</small>`:''}
    <span class="qty small" role="group" aria-label="Aantal ${esc(p.name)}"><button data-line="${i}" data-d="-1" aria-label="Eén ${esc(p.name)} minder" ${sending?'disabled':''}>−</button><output>${l.qty}</output><button data-line="${i}" data-d="1" aria-label="Eén ${esc(p.name)} meer" ${sending?'disabled':''}>+</button></span></span>
    <strong class="line-price">${money(unit(l) * l.qty)}</strong></li>`;
}

function checkoutHTML(){
  const online = method === 'online';
  return `<section class="panel"><button class="back" data-go="menu">← Terug naar de kaart</button>
  <p class="eyebrow">${esc(restaurant.name)} · Tafel ${esc(tableNumber)}</p><h1>Je bestelling</h1>
  <ul class="lines">${cart.map(lineHTML).join('')}</ul>
  <div class="total"><span>Totaal</span><strong>${money(total())}</strong></div>
  <p class="fine">De bar rekent met de actuele prijs. Prijzen incl. btw.</p>
  <h2 class="pay-title">Hoe wil je betalen?</h2>
  <div class="pay">
    <button class="payopt ${online?'on':''}" data-method="online" aria-pressed="${online}" ${sending?'disabled':''}><span class="ico">◈</span><span><strong>Meteen online betalen</strong><small>Bancontact, iDEAL, kaart… via Mollie. Je bestelling gaat direct naar de bar.</small></span></button>
    <button class="payopt ${!online?'on':''}" data-method="cash" aria-pressed="${!online}" ${sending?'disabled':''}><span class="ico">€</span><span><strong>Cash aan de bar</strong><small>Bestel nu, betaal bij het personeel. De bar bevestigt eerst.</small></span></button>
  </div>
  ${failure ? `<p class="alert" role="alert">${esc(failure)}</p>` : ''}
  <button class="btn gold wide" id="place" ${sending?'disabled':''}>${sending ? 'Even geduld…' : online ? 'Naar betalen · ' + money(total()) : 'Bestelling plaatsen · ' + money(total())}</button>
  <p class="fine center">18+ · Drink met mate</p></section>`;
}

function recoveryHTML(){
  if (pendingOnline) return `<section class="panel center"><h1>Betaling afronden</h1><p>Je was bezig met online betalen, maar we kregen nog geen bevestiging. Er wordt niets afgeschreven zonder dat jij betaalt.</p>${failure?`<p class="alert" role="alert">${esc(failure)}</p>`:''}
    <button class="btn gold wide" data-act="recover-online" ${sending?'disabled':''}>${sending?'Bezig…':'Verder met betalen'}</button>
    <button class="btn ghost wide" data-act="discard-online" ${sending?'disabled':''}>Annuleren en opnieuw kiezen</button><p class="fine">Een onbetaalde online bestelling wordt nooit ingeschonken.</p></section>`;
  return `<section class="panel center"><h1>Bestelling controleren</h1><p>Er staat een eerdere bestelling klaar die misschien al is doorgekomen. Plaats nog geen nieuwe bestelling.</p><p class="fine">We sturen exact dezelfde aanvraag opnieuw; dubbel bestellen kan niet.</p>${failure?`<p class="alert" role="alert">${esc(failure)}</p>`:''}
    <button class="btn gold wide" data-act="recover-cash" ${sending?'disabled':''}>${sending?'Bevestiging ophalen…':'Eerdere bestelling herstellen'}</button><p class="fine">Lukt het niet? Vraag het aan de bar.</p></section>`;
}

function paymentLine(r){
  if (r.payment_status === 'paid') return r.payment_method === 'online' ? 'Betaald · online' : 'Betaald · cash';
  if (r.payment_status === 'refunded') return 'Terugbetaald';
  if (r.payment_method === 'online') return r.payment_status === 'failed' ? 'Betaling niet gelukt · niets afgeschreven' : 'Betaling wordt bevestigd…';
  return 'Nog te betalen · cash aan de bar';
}

function renderReceipt(){
  const r = receipt;
  const failed = r.payment_method === 'online' && r.status === 'cancelled' && r.cancel_reason === 'payment_failed';
  const stopped = ['rejected','cancelled'].includes(r.status) && !failed;
  const waiting = r.status === 'awaiting_payment';
  const s = STATUS[r.status] || {label:r.status, step:0, progress:.2};
  const display = loadDisplay(r.id);
  const first = product(display[0]?.productId) || {glass:'tumbler', liquid_color:'#c8862a', ice:false, name:''};
  const firstOpt = option(first, display[0]?.optionId);
  let extra = '';
  if (waiting) extra = `<p class="fine">Betaling afgebroken of venster gesloten?</p><button class="btn gold wide" data-act="resume" ${sending?'disabled':''}>${sending?'Bezig…':'Verder met betalen'}</button>`;
  else if (failed) extra = `<p>De betaling is niet gelukt of geannuleerd. Er is niets doorgegeven aan de bar.</p><button class="btn gold wide" data-act="retry">Opnieuw proberen</button>`;
  else if (stopped) extra = `<p>De bar heeft deze bestelling ${r.status==='rejected'?'geweigerd':'geannuleerd'}. Vraag gerust waarom.${r.payment_status==='paid'?' Je krijgt het betaalde bedrag terug.':''}</p>`;
  const lines = display.map(d => { const p = product(d.productId); return p ? `<li>${d.qty} × ${esc(p.name)}${option(p,d.optionId)?` <small>${esc(option(p,d.optionId).name)}</small>`:''}</li>` : ''; }).join('');
  app.innerHTML = `<section class="panel center receipt">
    <p class="eyebrow">${esc(restaurant.name)} · Tafel ${esc(tableNumber)}</p><h1>Bestelling #${esc(r.order_number)}</h1>
    <div class="loader-glass ${stopped||failed?'off':''}" aria-hidden="true">${glassSVG({glass:first.glass,color:first.liquid_color,level:.2,ice:servesIce(first, firstOpt?.name),label:first.name})}<span class="shelf"></span></div>
    <p class="status" aria-live="polite"><strong>${esc(failed ? 'Niet betaald' : s.label)}</strong></p>
    ${s.step >= 0 && !failed ? `<ol class="steps">${STEPS.map((t,i) => `<li class="${i<s.step?'done':i===s.step?'now':''}">${t}</li>`).join('')}</ol>` : ''}
    <p class="pay-line">${esc(paymentLine(r))} · <strong>${money(r.total_cents)}</strong></p>
    ${lines ? `<ul class="receipt-lines">${lines}</ul>` : ''}
    ${failure ? `<p class="alert" role="alert">${esc(failure)}</p>` : ''}${extra}
    <p class="fine"><span id="guest-status-message" role="status">Status wordt opgehaald…</span></p>
    ${waiting ? '' : `<button class="btn ${failed?'ghost':'gold'} wide" data-act="new">Nog iets bestellen</button>`}
  </section>`;
  const lp = failed ? 0 : (s.progress ?? 1), lm = failed ? 'empty' : s.mode || 'loop';
  const box = app.querySelector('.loader-glass');
  if (three) {
    box.classList.add('is3d');
    const l3 = three.mountGlassLoader(box, first, {ice: servesIce(first, firstOpt?.name)});
    loader = {update: l3.update, stop: l3.dispose};
  } else loader = glassLoader(box.querySelector('.glass'));
  loader.update(lp, lm);
  startTracking(r, token, updated => { receipt = updated; render(); });
}

// ---------------------------------------------------------------- actions
async function placeCash(retry){
  if (sending) return;
  sending = true; failure = ''; render();
  const snap = snapshot();
  try {
    const result = retry ? await retryPendingCashOrder(token) : await createCashOrder(token, items());
    if (!retry) saveDisplay(result.id, snap);
    receipt = result; cart = []; saveCart(); pendingCash = hasPendingCashOrder(token); failure = '';
  } catch (e) {
    failure = e.message || 'Bestellen mislukt. Vraag het aan de bar.';
    try { pendingCash = hasPendingCashOrder(token); } catch (se) { failure = se.message; pendingCash = true; }
  }
  sending = false; render(); window.scrollTo({top:0});
}

async function goOnline(action, snap){
  if (sending) return;
  sending = true; failure = ''; render();
  try {
    const result = await action();
    const s = snap || loadRecord(token)?.online?.cart;
    if (s) saveDisplay(result.receipt.id, s);
    cart = []; saveCart(); pendingOnline = false; receipt = result.receipt;
    if (result.checkout_url) { window.location.assign(result.checkout_url); return; }
  } catch (e) {
    failure = e.message || 'Betaling kon niet worden gestart.';
    pendingOnline = hasPendingOnlineOrder(token);
  }
  sending = false; render(); window.scrollTo({top:0});
}

app.addEventListener('click', e => {
  const t = e.target.closest('button'); if (!t || t.disabled) return;
  if (t.dataset.cat) { category = t.dataset.cat; render(); return; }
  if (t.classList.contains('drink')) { openDrink(t.dataset.id); return; }
  if (t.dataset.go === 'menu') { failure = ''; setView('menu'); return; }
  if (t.dataset.method) { method = t.dataset.method; render(); return; }
  if (t.dataset.line) {
    const l = cart[Number(t.dataset.line)]; if (!l) return;
    l.qty += Number(t.dataset.d);
    if (l.qty <= 0) cart.splice(Number(t.dataset.line), 1);
    if (l.qty > 99) l.qty = 99;
    saveCart(); if (!cart.length) view = 'menu'; render(); return;
  }
  if (t.id === 'place') {
    if (!cart.length || pendingCash || pendingOnline) return;
    if (method === 'online') { const snap = snapshot(); void goOnline(() => createOnlineOrder(token, items(), snap), snap); }
    else void placeCash(false);
    return;
  }
  switch (t.dataset.act) {
    case 'recover-cash': void placeCash(true); break;
    case 'recover-online': void goOnline(() => retryPendingOnlineOrder(token)); break;
    case 'discard-online': discardPendingOnlineOrder(token); pendingOnline = false; failure = ''; setView('menu'); break;
    case 'resume': { const rec = loadRecord(token); void goOnline(() => resumeOnlinePayment(token, rec)); break; }
    case 'retry': { const rec = loadRecord(token); stopTracking(); receipt = null; failure = ''; restore(rec?.online?.cart || loadDisplay(rec?.receipt?.id)); method = 'online'; setView(cart.length ? 'checkout' : 'menu'); if (!cart.length) toast('Kies je drankjes opnieuw.'); break; }
    case 'new': if (sending) return; stopTracking(); receipt = null; failure = ''; setView('menu'); break;
  }
});
cartbar.addEventListener('click', () => { failure = ''; setView('checkout'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !sheet.hidden) sheet.querySelector('.close')?.click(); });

// ---------------------------------------------------------------- age gate + init
function ageGate(){
  return new Promise(resolve => {
    try { if (sessionStorage.getItem('sips:age-ok') === '1') return resolve(); } catch {}
    const gate = $('#age'); gate.hidden = false;
    gate.querySelector('[data-age=yes]').onclick = () => { try { sessionStorage.setItem('sips:age-ok','1'); } catch {} gate.hidden = true; resolve(); };
    gate.querySelector('[data-age=no]').onclick = () => { gate.querySelector('.age-q').innerHTML = '<h2>Tot later!</h2><p>SIPS schenkt alleen aan personen van 18 jaar en ouder.</p>'; };
  });
}

async function init(){
  app.innerHTML = '<section class="panel center"><p class="fine">Kaart ophalen…</p></section>';
  try {
    token = getTableTokenFromUrl();
    const url = new URL(location.href);
    if (url.searchParams.has('order')) { url.searchParams.delete('order'); history.replaceState(null, '', url); }
    const [data] = await Promise.all([getGuestMenu(token), ageGate()]);
    restaurant = data.restaurant; tableNumber = data.table_number;
    products = data.products.map(p => ({...p, options: p.options || [], glass: p.glass || 'tumbler', liquid_color: p.liquid_color || '#c8862a', bottle: p.bottle || 'whisky'}));
    document.title = restaurant.name + ' · Tafel ' + tableNumber;
    cart = loadCart();
    pendingCash = hasPendingCashOrder(token);
    pendingOnline = !pendingCash && hasPendingOnlineOrder(token);
    receipt = pendingCash || pendingOnline ? null : loadReceipt(token);
    if (receipt) await load3D();
    render();
    void load3D().then(() => { if (view === 'menu' && !receipt) renderShots(); });
  } catch (e) {
    restaurant = null;
    app.innerHTML = `<section class="panel center"><h1>Kaart niet beschikbaar</h1><p class="alert" role="alert">${esc(e.message)}</p><p class="fine">Scan de QR-code op je tafel opnieuw of vraag het aan de bar.</p><button class="btn ghost wide" onclick="location.reload()">Opnieuw proberen</button></section>`;
  }
}
void init();
