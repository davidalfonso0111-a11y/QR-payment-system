/* Load AFTER the prototype script using:
 * <script type="module" src="./js/live-guest.js"></script>
 * Development only. Configure gateway/IP rate limiting before public pilot.
 * Requires existing global prototype functions and lexical menu/cart variables.
 * No staff mutations or online payment are implemented.
 */
import {getTableTokenFromUrl,getGuestMenu,createCashOrder,hasPendingCashOrder,retryPendingCashOrder} from './guest-api.js';

import {loadReceipt,startTracking,stopTracking} from './guest-status.js';
const baseRender = window.render;
let token, restaurant, tableNumber, sending=false, pending=false, receipt=null, failure='';
const app=document.getElementById('app');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=cents=>new Intl.NumberFormat('nl-NL',{style:'currency',currency:restaurant?.currency||'EUR'}).format(cents/100);
const notice=document.querySelector('.demo');
// Hide and disable all public staff/demo mutation controls immediately.
document.getElementById('staffTab').hidden=true;
notice.innerHTML='<span>Ontwikkeltest · Cashbestellingen worden echt opgeslagen · Online betalen niet beschikbaar</span>';
window.setView=()=>{view='guest';window.render();};
window.advance=window.markCash=window.cashModal=window.resetDemo=window.confirmReset=()=>{};
window.placeOrder=()=>{};
window.staffHTML=()=>'<p>Personeelslogin is nog niet beschikbaar.</p>';

function recoveryHTML(){return `<section class="checkout"><div class="box"><h1>Bestelling controleren</h1><p>Er staat een eerdere aanvraag klaar. Die kan al zijn opgeslagen. Maak nog geen nieuwe bestelling.</p><p class="small">We herhalen exact dezelfde aanvraag. De database voorkomt een dubbele bestelling voor deze aanvraag.</p>${failure?`<p role="alert">${escapeHtml(failure)}</p>`:''}<button class="primary full" onclick="recoverCash()" ${sending?'disabled':''}>${sending?'Bevestiging ophalen…':'Eerdere aanvraag herstellen'}</button><p class="hint">Lukt dit niet? Vraag het personeel om hulp. Wis je browseropslag niet om opnieuw te bestellen.</p></div></section>`;}
function receiptHTML(){const labels={awaiting_acceptance:'Wacht op acceptatie',accepted:'Geaccepteerd',preparing:'In bereiding',ready:'Klaar',served:'Geserveerd',cancelled:'Geannuleerd'};return `<section class="checkout success"><div class="statusicon">✓</div><div class="eyebrow">${escapeHtml(restaurant.name)} · Tafel ${escapeHtml(tableNumber)}</div><h1>Bestelling #${escapeHtml(receipt.order_number)}</h1><div class="box"><h2>${money(receipt.total_cents)}</h2><p>${escapeHtml(labels[receipt.status]||receipt.status)}</p><p>${receipt.payment_status==='unpaid'?'Nog te betalen · cash aan de kassa':'Betaalstatus: '+escapeHtml(receipt.payment_status)}</p><p class="small"><span id="guest-status-message" role="status" aria-live="polite">Actuele status wordt opgehaald…</span> Geef je tafelnummer en bestelnummer door aan het personeel.</p></div><button class="primary full" onclick="newCashOrder()">Nog iets bestellen →</button></section>`;}
window.newCashOrder=()=>{if(sending||pending)return;stopTracking();receipt=null;page='menu';window.render();};
window.render=()=>{
  if(!restaurant)return;
  view='guest';
  if(pending){app.innerHTML=recoveryHTML();return;}
  if(receipt){app.innerHTML=receiptHTML();startTracking(receipt,token,updated=>{receipt=updated;window.render();});return;}
  baseRender();
  // Replace only static prototype labels, never database-supplied text.
  const tag=app.querySelector('.tabletag');
  if(tag)tag.textContent=`⌖ ${restaurant.name} · Tafel ${tableNumber}`;
  const cartLabel=app.querySelector('.cart > .small');
  if(cartLabel)cartLabel.textContent=`Tafel ${tableNumber} · ${restaurant.name}`;
  const heroText=app.querySelector('.hero p');
  if(heroText)heroText.textContent='Kies iets lekkers en betaal cash aan de kassa. Het personeel accepteert je bestelling eerst.';
  const footer=app.querySelector('footer');
  if(footer)footer.textContent='Menu en allergenen komen uit de database. Overleg bij een allergie altijd met het personeel. Dit is een ontwikkeltest.';
  if(sending)app.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);
};
window.checkoutHTML=()=>`<section class="checkout"><button class="back" onclick="page='menu';render()">← Terug naar menu</button><div class="eyebrow">${escapeHtml(restaurant.name)} · Tafel ${escapeHtml(tableNumber)}</div><h1>Cash aan de kassa</h1><div class="box"><div class="checkoutitems">${cart.map(i=>`<div><span>${i.qty} × ${escapeHtml(i.name)}${i.extra?'<br>'+escapeHtml(i.extra):''}${i.note?'<br>'+escapeHtml(i.note):''}</span><strong>${money(Math.round(i.unit*100)*i.qty)}</strong></div>`).join('')}</div><div class="total"><span>Verwacht totaal</span><span>${money(Math.round(total()*100))}</span></div><p class="small">De database bepaalt de actuele prijs. Het bevestigde bedrag kan afwijken als prijzen ondertussen veranderen.</p></div><div class="inlineinfo">Deze bestelling wordt echt opgeslagen. Het personeel moet deze nog accepteren. Er wordt geen geld afgeschreven. Online betalen is nog niet beschikbaar.</div>${failure?`<p role="alert">${escapeHtml(failure)}</p>`:''}<button class="primary full" style="margin-top:20px" onclick="submitOrder()" ${sending||!cart.length?'disabled':''}>${sending?'Versturen…':'Cashbestelling plaatsen'}</button></section>`;

function confirmed(result){receipt=result;cart=[];pending=hasPendingCashOrder(token);failure='';sending=false;closeModal();window.render();window.scrollTo(0,0);}
async function send(retry){
  if(sending)return;
  sending=true;failure='';closeModal();window.render();
  try{
    const result=retry?await retryPendingCashOrder(token):await createCashOrder(token,cart.map(i=>({product_id:menu.find(p=>p.id===i.id).productId,option_id:i.optionId??null,quantity:i.qty,note:i.note})));
    confirmed(result);
  }catch(error){
    sending=false;failure=error.message||'Bestellen mislukt. Vraag het personeel om hulp.';
    try{pending=hasPendingCashOrder(token);}catch(storageError){failure=storageError.message;pending=true;}
    window.render();
  }
}
window.submitOrder=()=>{if(cart.length&&!pending)void send(false);};
window.recoverCash=()=>void send(true);
// The SQL API supports one option per line. Display all available choices.
window.openProduct=id=>{
  if(pending||sending)return;
  const p=menu.find(x=>x.id===id);if(!p)return;
  modal(`<h2>${escapeHtml(p.name)}</h2><p class="small">${escapeHtml(p.description)}</p><div class="allergens"><strong>Allergenen</strong><br>${escapeHtml(p.allergens)}<br>Bij een allergie: overleg met het personeel.</div>${p.options.length?`<label for="productOption">Extra of variant</label><select id="productOption" style="width:100%;padding:12px;margin:10px 0"><option value="">Geen extra</option>${p.options.map(o=>`<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)} (+${money(o.price_cents)}) · ${escapeHtml(o.allergens)}</option>`).join('')}</select>`:''}<label for="note">Opmerking voor de keuken</label><textarea id="note" maxlength="180"></textarea><button class="primary full" onclick="addItem(${p.id})">Toevoegen · vanaf ${money(p.price_cents)}</button>`);
};
window.addItem=id=>{
  if(pending||sending)return;
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
window.changeQty=(index,delta)=>{if(pending||sending)return;if(delta>0&&cart[index]?.qty>=99){notify('Maximaal 99 per bestelregel.');return;}oldQty(index,delta);};

async function init(){
  app.innerHTML='<section class="checkout"><div class="box" role="status">Menu ophalen…</div></section>';
  try{
    token=getTableTokenFromUrl();
    const data=await getGuestMenu(token);
    restaurant=data.restaurant;tableNumber=data.table_number;
    menu.splice(0,menu.length,...data.products.map((p,index)=>({...p,id:index+1,productId:p.id,price:p.price_cents/100,description:p.description||'',allergens:p.allergens||'Vraag het personeel.',options:p.options||[],emoji:p.category==='Drinken'?'🥤':p.category==='Dessert'?'🍫':'🍽️',color:'',tag:'',extra:null})));
    cart=[];orders=[];method='cash';page='menu';category='Alles';
    pending=hasPendingCashOrder(token);receipt=pending?null:loadReceipt(token);window.render();
  }catch(error){
    restaurant=null;
    app.innerHTML=`<section class="checkout"><div class="box"><h1>Menu niet beschikbaar</h1><p role="alert">${escapeHtml(error.message)}</p><p class="small">Scan de QR-code opnieuw of vraag het personeel om hulp. Open deze site via HTTPS met een geldig ?table= token.</p><button class="secondary full" onclick="location.reload()">Opnieuw proberen</button></div></section>`;
  }
}
void init();
