/* Live guest module. Loaded AFTER the base page script in index.html:
 * <script type="module" src="./js/live-guest.js"></script>
 * Uses the global base functions (render, modal, notify, ...) and the lexical
 * variables menu/cart/page/view/method/category of the base script.
 * Cash orders: Supabase RPC. Online orders: Vercel /api/create-payment + Mollie.
 * Configure gateway/IP rate limiting before a public pilot.
 */
import {getTableTokenFromUrl,getGuestMenu,createCashOrder,hasPendingCashOrder,retryPendingCashOrder,
  createOnlineOrder,hasPendingOnlineOrder,retryPendingOnlineOrder,discardPendingOnlineOrder,resumeOnlinePayment} from './guest-api.js';
import {loadReceipt,loadRecord,startTracking,stopTracking} from './guest-status.js';

const baseRender = window.render;
let token, restaurant, tableNumber, sending=false, pending=false, pendingOnline=false, receipt=null, failure='';
const app=document.getElementById('app');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=cents=>new Intl.NumberFormat('nl-NL',{style:'currency',currency:restaurant?.currency||'EUR'}).format(cents/100);
const notice=document.querySelector('.demo');

const STATUS_LABELS={
  awaiting_payment:'Wacht op betaling',
  awaiting_acceptance:'Wacht op acceptatie door het personeel',
  received:'Ontvangen door de keuken',
  preparing:'In bereiding',
  ready:'Klaar, wordt zo gebracht',
  served:'Geserveerd',
  rejected:'Geweigerd door het personeel',
  cancelled:'Geannuleerd'
};

// Hide and disable all public staff/demo controls of the base prototype.
document.getElementById('staffTab').hidden=true;
notice.innerHTML='<span>Betaal online of cash aan de kassa</span>';
window.setView=()=>{view='guest';window.render();};
window.advance=window.markCash=window.cashModal=window.resetDemo=window.confirmReset=()=>{};
window.placeOrder=()=>{};
window.staffHTML=()=>'<p>Het personeel gebruikt een eigen pagina.</p>';

function recoveryHTML(){
  if(pendingOnline){
    return `<section class="checkout"><div class="box"><h1>Betaling afronden</h1><p>Je was bezig met online betalen, maar we kregen nog geen bevestiging. Er is nog niets afgeschreven zonder dat jij betaald hebt.</p>${failure?`<p role="alert">${escapeHtml(failure)}</p>`:''}<button class="primary full" onclick="recoverOnline()" ${sending?'disabled':''}>${sending?'Bezig…':'Verder met betalen'}</button><button class="secondary full" style="margin-top:10px" onclick="discardOnline()" ${sending?'disabled':''}>Annuleren en opnieuw kiezen</button><p class="hint">Een onbetaalde online bestelling wordt nooit klaargemaakt.</p></div></section>`;
  }
  return `<section class="checkout"><div class="box"><h1>Bestelling controleren</h1><p>Er staat een eerdere aanvraag klaar. Die kan al zijn opgeslagen. Maak nog geen nieuwe bestelling.</p><p class="small">We herhalen exact dezelfde aanvraag. De database voorkomt een dubbele bestelling voor deze aanvraag.</p>${failure?`<p role="alert">${escapeHtml(failure)}</p>`:''}<button class="primary full" onclick="recoverCash()" ${sending?'disabled':''}>${sending?'Bevestiging ophalen…':'Eerdere aanvraag herstellen'}</button><p class="hint">Lukt dit niet? Vraag het personeel om hulp. Wis je browseropslag niet om opnieuw te bestellen.</p></div></section>`;
}

function paymentLine(r){
  if(r.payment_status==='paid')return r.payment_method==='online'?'Betaald · online':'Betaald · cash';
  if(r.payment_status==='refunded')return 'Terugbetaald';
  if(r.payment_method==='online'){
    if(r.payment_status==='failed')return 'Betaling niet gelukt · er is niets afgeschreven';
    return 'Betaling wordt bevestigd…';
  }
  return 'Nog te betalen · cash aan de kassa';
}

function receiptHTML(){
  const r=receipt;
  const online=r.payment_method==='online';
  const paymentFailed=online&&r.status==='cancelled'&&r.cancel_reason==='payment_failed';
  const stoppedByStaff=['rejected','cancelled'].includes(r.status)&&!paymentFailed;
  const waiting=r.status==='awaiting_payment';
  const icon=paymentFailed||stoppedByStaff?'✕':waiting?'⌛':'✓';
  let extra='';
  if(waiting)extra=`<p class="small">Heb je de betaling afgebroken of het venster gesloten?</p><button class="primary full" onclick="resumePayment()" ${sending?'disabled':''}>${sending?'Bezig…':'Verder met betalen'}</button>`;
  else if(paymentFailed)extra=`<p>De betaling is niet gelukt of geannuleerd. Je bestelling is niet doorgegeven aan de keuken.</p><button class="primary full" onclick="retryAfterFailure()">Opnieuw proberen</button>`;
  else if(stoppedByStaff)extra=`<p>Het personeel heeft deze bestelling ${r.status==='rejected'?'geweigerd':'geannuleerd'}. Vraag het personeel gerust waarom.${r.payment_status==='paid'?' Je krijgt het betaalde bedrag terug.':''}</p>`;
  return `<section class="checkout success"><div class="statusicon">${icon}</div><div class="eyebrow">${escapeHtml(restaurant.name)} · Tafel ${escapeHtml(tableNumber)}</div><h1>Bestelling #${escapeHtml(r.order_number)}</h1><div class="box"><h2>${money(r.total_cents)}</h2><p><strong>${escapeHtml(paymentFailed?'Niet betaald':STATUS_LABELS[r.status]||r.status)}</strong></p><p>${escapeHtml(paymentLine(r))}</p>${failure?`<p role="alert">${escapeHtml(failure)}</p>`:''}${extra}<p class="small"><span id="guest-status-message" role="status" aria-live="polite">Actuele status wordt opgehaald…</span> Geef je tafelnummer en bestelnummer door aan het personeel als je vragen hebt.</p></div>${waiting?'':`<button class="${paymentFailed?'secondary':'primary'} full" onclick="newOrder()">Nog iets bestellen →</button>`}</section>`;
}

window.newOrder=window.newCashOrder=()=>{if(sending||pending||pendingOnline)return;stopTracking();receipt=null;failure='';page='menu';window.render();};

window.render=()=>{
  if(!restaurant)return;
  view='guest';
  if(pending||pendingOnline){app.innerHTML=recoveryHTML();return;}
  if(receipt){app.innerHTML=receiptHTML();startTracking(receipt,token,updated=>{receipt=updated;window.render();});return;}
  baseRender();
  // Replace only static prototype labels, never database-supplied text.
  const tag=app.querySelector('.tabletag');
  if(tag)tag.textContent=`⌖ ${restaurant.name} · Tafel ${tableNumber}`;
  const cartLabel=app.querySelector('.cart > .small');
  if(cartLabel)cartLabel.textContent=`Tafel ${tableNumber} · ${restaurant.name}`;
  const heroText=app.querySelector('.hero p');
  if(heroText)heroText.textContent='Kies iets lekkers. Betaal meteen online of cash aan de kassa.';
  const footer=app.querySelector('footer');
  if(footer)footer.textContent='Menu en allergenen komen uit de database. Overleg bij een allergie altijd met het personeel.';
  if(sending)app.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);
};

window.checkoutHTML=()=>{
  const online=method==='online';
  return `<section class="checkout"><button class="back" onclick="page='menu';render()">← Terug naar menu</button><div class="eyebrow">${escapeHtml(restaurant.name)} · Tafel ${escapeHtml(tableNumber)}</div><h1>Hoe wil je betalen?</h1><div class="box"><div class="checkoutitems">${cart.map(i=>`<div><span>${i.qty} × ${escapeHtml(i.name)}${i.extra?'<br>'+escapeHtml(i.extra):''}${i.note?'<br>'+escapeHtml(i.note):''}</span><strong>${money(Math.round(i.unit*100)*i.qty)}</strong></div>`).join('')}</div><div class="total"><span>Verwacht totaal</span><span>${money(Math.round(total()*100))}</span></div><p class="small">De database bepaalt de actuele prijs. Het bevestigde bedrag kan afwijken als prijzen ondertussen veranderen.</p></div>
<button class="payoption ${online?'selected':''}" aria-pressed="${online}" onclick="method='online';render()" ${sending?'disabled':''}><span class="symbol">💳</span><span><strong>Meteen online betalen</strong><span class="small">iDEAL, kaart en meer via Mollie. Je bestelling gaat direct naar de keuken zodra de betaling binnen is.</span></span><span class="radio"></span></button>
<button class="payoption ${!online?'selected':''}" aria-pressed="${!online}" onclick="method='cash';render()" ${sending?'disabled':''}><span class="symbol">💶</span><span><strong>Cash aan de kassa</strong><span class="small">Bestel nu, betaal bij het personeel. Het personeel accepteert je bestelling eerst.</span></span><span class="radio"></span></button>
${failure?`<p role="alert">${escapeHtml(failure)}</p>`:''}<button class="primary full" style="margin-top:14px" onclick="submitOrder()" ${sending||!cart.length?'disabled':''}>${sending?'Versturen…':online?'Naar betalen · '+money(Math.round(total()*100)):'Cashbestelling plaatsen'}</button></section>`;
};

function orderItems(){
  return cart.map(i=>({product_id:menu.find(p=>p.id===i.id).productId,option_id:i.optionId??null,quantity:i.qty,note:i.note}));
}
// Display snapshot keyed by database product id (menu indexes can change).
function cartSnapshot(){
  return cart.map(i=>({productId:menu.find(p=>p.id===i.id).productId,optionId:i.optionId??null,qty:i.qty,note:i.note}));
}
function restoreCart(snapshot){
  cart=[];
  for(const s of snapshot||[]){
    const p=menu.find(x=>x.productId===s.productId);if(!p)continue;
    const option=p.options.find(o=>o.id===s.optionId);if(s.optionId&&!option)continue;
    cart.push({id:p.id,name:p.name,unit:(p.price_cents+(option?.price_cents||0))/100,extra:option?.name||'',optionId:option?.id??null,note:s.note||'',qty:s.qty});
  }
}

function confirmed(result){receipt=result;cart=[];pending=hasPendingCashOrder(token);failure='';sending=false;closeModal();window.render();window.scrollTo(0,0);}
async function send(retry){
  if(sending)return;
  sending=true;failure='';closeModal();window.render();
  try{
    const result=retry?await retryPendingCashOrder(token):await createCashOrder(token,orderItems());
    confirmed(result);
  }catch(error){
    sending=false;failure=error.message||'Bestellen mislukt. Vraag het personeel om hulp.';
    try{pending=hasPendingCashOrder(token);}catch(storageError){failure=storageError.message;pending=true;}
    window.render();
  }
}

// Online: the server returns a Mollie checkout URL; the guest comes back to
// ?table=...&order=... and the receipt screen follows the payment status.
async function goOnline(action){
  if(sending)return;
  sending=true;failure='';closeModal();window.render();
  try{
    const result=await action();
    cart=[];pendingOnline=false;receipt=result.receipt;
    if(result.checkout_url){
      window.location.assign(result.checkout_url);
      return; // keep "sending" so nothing can be clicked while leaving the page
    }
    sending=false;window.render();window.scrollTo(0,0);
  }catch(error){
    sending=false;failure=error.message||'Betaling kon niet worden gestart.';
    pendingOnline=hasPendingOnlineOrder(token);
    window.render();
  }
}

window.submitOrder=()=>{
  if(!cart.length||pending||pendingOnline)return;
  if(method==='online')void goOnline(()=>createOnlineOrder(token,orderItems(),cartSnapshot()));
  else void send(false);
};
window.recoverCash=()=>void send(true);
window.recoverOnline=()=>void goOnline(()=>retryPendingOnlineOrder(token));
window.discardOnline=()=>{if(sending)return;discardPendingOnlineOrder(token);pendingOnline=false;failure='';page='menu';window.render();};
window.resumePayment=()=>{const record=loadRecord(token);void goOnline(()=>resumeOnlinePayment(token,record));};
window.retryAfterFailure=()=>{
  const record=loadRecord(token);
  stopTracking();receipt=null;failure='';
  restoreCart(record?.online?.cart);
  method='online';page=cart.length?'checkout':'menu';
  window.render();window.scrollTo(0,0);
  if(!cart.length)notify('Kies je gerechten opnieuw.');
};

// The SQL API supports one option per line. Display all available choices.
window.openProduct=id=>{
  if(pending||pendingOnline||sending)return;
  const p=menu.find(x=>x.id===id);if(!p)return;
  modal(`<h2>${escapeHtml(p.name)}</h2><p class="small">${escapeHtml(p.description)}</p><div class="allergens"><strong>Allergenen</strong><br>${escapeHtml(p.allergens)}<br>Bij een allergie: overleg met het personeel.</div>${p.options.length?`<label for="productOption">Extra of variant</label><select id="productOption" style="width:100%;padding:12px;margin:10px 0"><option value="">Geen extra</option>${p.options.map(o=>`<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)} (+${money(o.price_cents)}) · ${escapeHtml(o.allergens)}</option>`).join('')}</select>`:''}<label for="note">Opmerking voor de keuken</label><textarea id="note" maxlength="180"></textarea><button class="primary full" onclick="addItem(${p.id})">Toevoegen · vanaf ${money(p.price_cents)}</button>`);
};
window.addItem=id=>{
  if(pending||pendingOnline||sending)return;
  const p=menu.find(x=>x.id===id);if(!p)return;
  const optionId=document.getElementById('productOption')?.value||null;
  const option=p.options.find(o=>o.id===optionId);
  const note=document.getElementById('note').value.trim();
  const existing=cart.find(i=>i.id===id&&i.optionId===optionId&&i.note===note);
  if(existing){if(existing.qty>=99){notify('Maximaal 99 per bestelregel.');return;}existing.qty++;}
  else cart.push({id,name:p.name,unit:(p.price_cents+(option?.price_cents||0))/100,extra:option?.name||'',optionId,note,qty:1});
  closeModal();window.render();notify('Toegevoegd');
};
const oldQty=window.changeQty;
window.changeQty=(index,delta)=>{if(pending||pendingOnline||sending)return;if(delta>0&&cart[index]?.qty>=99){notify('Maximaal 99 per bestelregel.');return;}oldQty(index,delta);};

async function init(){
  app.innerHTML='<section class="checkout"><div class="box" role="status">Menu ophalen…</div></section>';
  try{
    token=getTableTokenFromUrl();
    // Coming back from Mollie: the order id in the URL is not needed (the
    // private receipt is on this device); remove it from the address bar.
    const url=new URL(window.location.href);
    if(url.searchParams.has('order')){url.searchParams.delete('order');history.replaceState(null,'',url);}
    const data=await getGuestMenu(token);
    restaurant=data.restaurant;tableNumber=data.table_number;
    menu.splice(0,menu.length,...data.products.map((p,index)=>({...p,id:index+1,productId:p.id,price:p.price_cents/100,description:p.description||'',allergens:p.allergens||'Vraag het personeel.',options:p.options||[],emoji:p.category==='Drinken'?'🥤':p.category==='Dessert'?'🍫':'🍽️',color:'',tag:'',extra:null})));
    cart=[];orders=[];method='online';page='menu';category='Alles';
    pending=hasPendingCashOrder(token);
    pendingOnline=!pending&&hasPendingOnlineOrder(token);
    receipt=pending||pendingOnline?null:loadReceipt(token);
    window.render();
  }catch(error){
    restaurant=null;
    app.innerHTML=`<section class="checkout"><div class="box"><h1>Menu niet beschikbaar</h1><p role="alert">${escapeHtml(error.message)}</p><p class="small">Scan de QR-code opnieuw of vraag het personeel om hulp.</p><button class="secondary full" onclick="location.reload()">Opnieuw proberen</button></div></section>`;
  }
}
void init();
