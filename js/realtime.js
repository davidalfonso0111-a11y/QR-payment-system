/* Minimal Supabase Realtime (Phoenix protocol 1.0.0) broadcast listener.
 * No library needed. Listens on a public broadcast topic for "changed" signals
 * sent by the database (see database/008_live_updates.sql). Signals carry no
 * data: the caller re-fetches through its normal, access-checked API.
 *
 * listen(url, key, topic, {onSignal, onStatus}) -> stop()
 *  onSignal(): something changed (also called after every (re)connect, so
 *              nothing missed while offline is lost)
 *  onStatus(live:boolean): connection state, for a "live" indicator
 */
export function listen(supabaseUrl, apiKey, topic, { onSignal, onStatus = () => {} }) {
  const wsUrl = supabaseUrl.replace(/^http/, 'ws').replace(/\/+$/, '') +
    '/realtime/v1/websocket?apikey=' + encodeURIComponent(apiKey) + '&vsn=1.0.0';
  const channel = 'realtime:' + topic;
  let socket = null, heartbeat = null, retryTimer = null, retries = 0, stopped = false, ref = 0, joinRef = null, live = false;

  function setLive(value) { if (live !== value) { live = value; onStatus(value); } }
  function send(message) {
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }
  function cleanup() {
    clearInterval(heartbeat); heartbeat = null;
    if (socket) { socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null; try { socket.close(); } catch {} }
    socket = null;
  }
  function reconnect() {
    cleanup(); setLive(false);
    if (stopped) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(retries++, 5)) + Math.random() * 500;
    retryTimer = setTimeout(connect, delay);
  }
  function connect() {
    if (stopped) return;
    if (typeof WebSocket === 'undefined') return;
    try { socket = new WebSocket(wsUrl); } catch { reconnect(); return; }
    socket.onopen = () => {
      joinRef = String(++ref);
      send({ topic: channel, event: 'phx_join', ref: joinRef, join_ref: joinRef, payload: {
        config: { broadcast: { ack: false, self: false }, presence: { enabled: false }, postgres_changes: [], private: false },
      } });
      heartbeat = setInterval(() => send({ topic: 'phoenix', event: 'heartbeat', payload: {}, ref: String(++ref) }), 25000);
    };
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.topic !== channel) return;
      if (message.event === 'phx_reply' && message.ref === joinRef) {
        if (message.payload && message.payload.status === 'ok') {
          retries = 0; setLive(true);
          onSignal(); // catch up on anything missed before (re)joining
        } else {
          reconnect();
        }
      } else if (message.event === 'broadcast') {
        onSignal();
      } else if (message.event === 'phx_error' || message.event === 'phx_close') {
        reconnect();
      }
    };
    socket.onclose = () => reconnect();
    socket.onerror = () => { try { socket.close(); } catch {} };
  }

  connect();
  return function stop() {
    stopped = true; clearTimeout(retryTimer); cleanup(); setLive(false);
  };
}

// Guest topic: 'order-' + SHA-256(guest secret) in hex, matching the database.
export async function guestTopic(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return 'order-' + Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
