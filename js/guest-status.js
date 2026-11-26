/* Private guest receipt tracking. Never put the secret in URLs or logs.
Development use: gateway/IP rate limiting required before public pilot. */
import {listen,guestTopic} from './realtime.js';
const URL='https://irzbdxffwcykwdynqvhg.supabase.co';
const KEY='sb_publishable_pkzvobApP2voeO82K3TRKQ_f5gzdg14';
const PREFIX='qr-payment:receipt:v1:';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let session=null,timer=null,controller=null,message='Actuele status wordt opgehaald…';
function stored(token){
  try{
    const value=JSON.parse(localStorage.getItem(PREFIX+token));
    if(!UUID.test(value?.receipt?.id||'') || !/^[0-9a-f]{64}$/.test(value?.secret||''))return null;
    return value;
  }catch{return null;}
}
export function loadReceipt(token){return stored(token)?.receipt||null;}
// Full private record: receipt, secret and (for online orders) the retry data.
export function loadRecord(token){return stored(token);}
function show(){const el=document.getElementById('guest-status-message');if(el)el.textContent=message;}
export function stopTracking(){
  session?.stopLive?.();
  session=null;clearTimeout(timer);timer=null;controller?.abort();controller=null;
}
function schedule(s,delay){
  clearTimeout(timer);
  if(session===s&&!document.hidden&&!s.denied)timer=setTimeout(()=>poll(s),delay);
}
export function startTracking(receipt,token,onUpdate){
  if(session?.id===receipt.id&&session.token===token){session.onUpdate=onUpdate;show();return;}
  stopTracking();
  const value=stored(token);
  if(!value||value.receipt.id!==receipt.id){message='Automatische opvolging niet beschikbaar op dit apparaat. Vraag het personeel om de status.';show();return;}
  session={id:receipt.id,token,secret:value.secret,receipt,onUpdate,failures:0,busy:false,denied:false};
  message='Actuele status wordt opgehaald…';show();
  if(!document.hidden)void poll(session);
  // Live: the database signals every change; we then fetch the status at once.
  const s=session;
  guestTopic(s.secret).then(topic=>{
    if(session!==s)return;
    s.stopLive=listen(URL,KEY,topic,{
      onSignal:()=>{if(session!==s)return;if(s.busy)s.again=true;else schedule(s,50);},
      onStatus:live=>{s.live=live;}
    });
  }).catch(()=>{});
}
async function poll(s){
  if(session!==s||s.busy||s.denied||document.hidden)return;
  s.busy=true;
  const c=new AbortController();controller=c;
  const timeout=setTimeout(()=>c.abort(),15000);
  // Polling is the fallback; with a live connection it can be much slower.
  const pace=r=>r?.status==='awaiting_payment'?(s.live?10000:3000):(s.live?30000:10000);
  let delay=pace(s.receipt);
  try{
    const response=await fetch(URL+'/rest/v1/rpc/qr_guest_order_status',{
      method:'POST',headers:{apikey:KEY,'Content-Type':'application/json'},
      body:JSON.stringify({p_order_id:s.id,p_guest_secret:s.secret}),
      cache:'no-store',signal:c.signal
    });
    if(session!==s)return;
    if(!response.ok){
      if([400,401,403,404].includes(response.status)){
        s.denied=true;message='Status niet beschikbaar. Vraag het personeel om hulp; bestel niet opnieuw.';show();return;
      }
      throw new Error('Temporary status failure');
    }
    const result=await response.json();
    if(result?.id!==s.id||typeof result.status!=='string'||typeof result.payment_status!=='string'||!Number.isInteger(result.total_cents))throw new Error('Invalid receipt');
    s.failures=0;
    message=(s.live?'Live · ':'')+'Laatst bijgewerkt om '+new Date().toLocaleTimeString('nl-NL',{hour:'2-digit',minute:'2-digit',second:'2-digit'})+'.';
    const updated={...s.receipt,...result};
    const changed=JSON.stringify(updated)!==JSON.stringify(s.receipt);
    s.receipt=updated;
    delay=pace(updated);
    // Do not overwrite a newer order placed in another browser tab.
    try{const current=stored(s.token);if(current?.receipt.id===s.id)localStorage.setItem(PREFIX+s.token,JSON.stringify({...current,receipt:updated}));}catch{}
    if(changed)s.onUpdate(updated);
    show();
  }catch{
    if(session!==s)return;
    s.failures++;
    delay=Math.min(60000,10000*2**Math.min(s.failures,3));
    message='Status tijdelijk niet bereikbaar. Laatst bekende status blijft staan; we proberen opnieuw. Plaats geen nieuwe bestelling als herhaling.';show();
  }finally{
    clearTimeout(timeout);if(controller===c)controller=null;s.busy=false;
    if(session===s){if(s.again){s.again=false;delay=50;}schedule(s,delay);}
  }
}
document.addEventListener('visibilitychange',()=>{
  clearTimeout(timer);
  if(document.hidden){controller?.abort();return;}
  if(session&&!session.denied)schedule(session,250);
});
window.addEventListener('online',()=>{if(session&&!document.hidden)schedule(session,250);});
