/* Development guest API. No service-role key belongs in this file.
 * Uses database/002_guest_cash_api.sql. Do not run the conflicting migration.
 * Public pilot requires gateway/IP rate limiting and staff acceptance.
 * This file alone does not connect index.html or implement online payment.
 */
const SUPABASE_URL = 'https://irzbdxffwcykwdynqvhg.supabase.co';
const PUBLISHABLE_KEY = 'sb_publishable_pkzvobApP2voeO82K3TRKQ_f5gzdg14';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STORAGE_PREFIX = 'qr-payment:pending-cash:v1:';
const activeRequests = new Map();

export class GuestApiError extends Error {
  constructor(message, { code = null, status = null, uncertain = false } = {}) {
    super(message);
    this.name = 'GuestApiError';
    this.code = code;
    this.status = status;
    this.uncertain = uncertain;
  }
}

function validateToken(token) {
  if (typeof token !== 'string' || !UUID.test(token)) {
    throw new GuestApiError('Ongeldige tafelcode. Scan de QR-code opnieuw.');
  }
  return token.toLowerCase();
}

async function rpc(name, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: { apikey: PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
      cache: 'no-store'
    });
    const text = await response.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new GuestApiError('Onleesbaar antwoord. Probeer dezelfde aanvraag opnieuw.', {
        status: response.status, uncertain: true
      });
    }
    if (!response.ok) {
      const message = typeof data?.message === 'string' ? data.message : 'Aanvraag niet gelukt.';
      throw new GuestApiError(message, {
        code: data?.code ?? null, status: response.status,
        uncertain: response.status >= 500 || response.status === 408
      });
    }
    return data;
  } catch (error) {
    if (error instanceof GuestApiError) throw error;
    throw new GuestApiError('Geen bevestiging ontvangen. Je bestelling kan al opgeslagen zijn. Probeer dezelfde aanvraag opnieuw.', { uncertain: true });
  } finally { clearTimeout(timer); }
}

export function getTableTokenFromUrl() {
  // Example: index.html?table=d5d46d46-8d68-41d4-8121-785d9dd0d308
  // No fallback: a missing QR token must not route to another table.
  return validateToken(new URL(window.location.href).searchParams.get('table'));
}

export async function getGuestMenu(token) {
  const data = await rpc('qr_guest_menu', { p_qr_token: validateToken(token) });
  if (!data?.restaurant || !Array.isArray(data.products) || data.table_number == null) {
    throw new GuestApiError('Het menu kon niet worden geladen.');
  }
  return data;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 50) {
    throw new GuestApiError('Kies tussen 1 en 50 bestelregels.');
  }
  return items.map(item => {
    if (!item || !UUID.test(item.product_id ?? '') ||
        !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
      throw new GuestApiError('Ongeldig product of aantal.');
    }
    if (item.option_id != null && !UUID.test(item.option_id)) {
      throw new GuestApiError('Ongeldige productoptie.');
    }
    const note = item.note ?? '';
    if (typeof note !== 'string' || Array.from(note).length > 180) {
      throw new GuestApiError('Een opmerking mag maximaal 180 tekens bevatten.');
    }
    // Prices are deliberately omitted. The database calculates the total.
    return { product_id: item.product_id.toLowerCase(),
      option_id: item.option_id ? item.option_id.toLowerCase() : null,
      quantity: item.quantity, note };
  });
}

function readPending(token) {
  let stored;
  try { stored = localStorage.getItem(STORAGE_PREFIX + token); }
  catch { throw new GuestApiError('Lokale opslag is niet beschikbaar. Bestellen is uitgeschakeld om dubbele bestellingen te voorkomen.'); }
  if (!stored) return null;
  try {
    const body = JSON.parse(stored);
    if (body.p_qr_token !== token || !UUID.test(body.p_idempotency_key ?? '') ||
        !/^[0-9a-f]{64}$/.test(body.p_guest_secret ?? '')) throw new Error();
    normalizeItems(body.p_items);
    return body;
  } catch {
    throw new GuestApiError('Een eerdere bestelaanvraag kan niet worden hersteld. Vraag het personeel om hulp voordat je opnieuw bestelt.');
  }
}

export function hasPendingCashOrder(token) {
  return readPending(validateToken(token)) !== null;
}

export async function createCashOrder(token, items) {
  token = validateToken(token);
  // No second click may issue another request while one is in flight.
  if (activeRequests.has(token)) {
    throw new GuestApiError('Er wordt al een bestelling verstuurd. Wacht op het resultaat.');
  }
  const normalized = normalizeItems(items);
  let body = readPending(token);
  if (body && JSON.stringify(body.p_items) !== JSON.stringify(normalized)) {
    throw new GuestApiError('Er staat nog een onbevestigde aanvraag klaar. Herstel die eerst met retryPendingCashOrder; maak nog geen nieuwe bestelling.');
  }
  if (!body) {
    if (!globalThis.crypto?.randomUUID || !globalThis.crypto?.getRandomValues) {
      throw new GuestApiError('Open de website via HTTPS om veilig te bestellen.');
    }
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    body = { p_qr_token: token, p_idempotency_key: crypto.randomUUID(),
      p_guest_secret: Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join(''),
      p_items: normalized };
    try { localStorage.setItem(STORAGE_PREFIX + token, JSON.stringify(body)); }
    catch { throw new GuestApiError('De bestelaanvraag kon niet veilig bewaard worden. Er is niets verstuurd.'); }
  }
  return sendCashOrder(token, body);
}

export async function retryPendingCashOrder(token) {
  token = validateToken(token);
  if (activeRequests.has(token)) {
    throw new GuestApiError('Er wordt al een bestelling verstuurd.');
  }
  const body = readPending(token);
  if (!body) throw new GuestApiError('Geen eerdere bestelaanvraag gevonden.');
  return sendCashOrder(token, body);
}

async function sendCashOrder(token, body) {
  const task = (async () => {
    const result = await rpc('qr_create_cash_order', body);
    if (!UUID.test(result?.id ?? '') || !Number.isInteger(result.total_cents) ||
        result.total_cents < 0 || result.order_number == null) {
      throw new GuestApiError('Onvolledige bestelbevestiging. Herhaal dezelfde aanvraag.', { uncertain: true });
    }
    // Keep the pending request if storage cleanup fails. Retrying will replay it.
    try { localStorage.removeItem(STORAGE_PREFIX + token); } catch { /* safe replay */ }
    return result;
  })();
  activeRequests.set(token, task);
  try { return await task; }
  finally { activeRequests.delete(token); }
}

// Any failure retains the EXACT request and secret for a safe retry.
// A failed request must not be silently discarded or replaced with a new UUID.
// No staff updates, order lookup, payment simulation or online payment is exposed here.
