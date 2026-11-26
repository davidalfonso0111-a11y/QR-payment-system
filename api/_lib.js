// Gedeelde server-hulpfuncties voor de Vercel API-routes.
// Bestanden die met "_" beginnen worden door Vercel NIET als losse route gepubliceerd.
// Alle geheime sleutels komen uit Vercel Environment Variables, nooit uit de browser.

// MOLLIE_API_URL alleen zetten voor lokale tests; standaard de echte Mollie API.
const MOLLIE_API = (process.env.MOLLIE_API_URL || 'https://api.mollie.com/v2').replace(/\/+$/, '');

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function env(name) {
  const value = process.env[name];
  if (!value || !String(value).trim()) {
    throw new Error('Omgevingsvariabele ontbreekt: ' + name);
  }
  return String(value).trim();
}

function supabaseUrl() {
  return env('SUPABASE_URL').replace(/\/+$/, '');
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 300) }; }
}

async function callRpc(name, args, headers) {
  const response = await fetch(supabaseUrl() + '/rest/v1/rpc/' + encodeURIComponent(name), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(args || {}),
    signal: AbortSignal.timeout(15000),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const message = (data && data.message) || ('RPC ' + name + ' mislukt');
    // Supabase/PostgREST: 4xx = validatie/toegang (veilig om te tonen), 5xx = serverfout.
    throw new HttpError(response.status >= 500 ? 502 : response.status, message, data);
  }
  return data;
}

// Supabase-aanroep met de service_role / secret key (alleen op de server).
function rpc(name, args) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const headers = { apikey: key };
  // Oude JWT-sleutels (eyJ...) moeten ook als Bearer mee; nieuwe sb_secret_-sleutels niet.
  if (key.startsWith('eyJ')) headers.Authorization = 'Bearer ' + key;
  return callRpc(name, args, headers);
}

// Supabase-aanroep namens een ingelogde medewerker (diens eigen JWT).
// De database controleert zelf rol en lidmaatschap via auth.uid().
function rpcAsUser(name, args, accessToken) {
  return callRpc(name, args, {
    apikey: env('SUPABASE_PUBLISHABLE_KEY'),
    Authorization: 'Bearer ' + accessToken,
  });
}

async function mollie(path, options = {}) {
  const response = await fetch(MOLLIE_API + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + env('MOLLIE_API_KEY'),
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    signal: AbortSignal.timeout(15000),
  });
  const data = await readJson(response);
  if (!response.ok) {
    const message = (data && (data.detail || data.title)) || 'Mollie-aanvraag mislukt';
    throw new HttpError(response.status >= 500 ? 502 : response.status, message, data);
  }
  return data;
}

function centsToMollie(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('Ongeldig bedrag');
  return (cents / 100).toFixed(2);
}

function mollieToCents(value) {
  // Mollie geeft altijd een string met 2 decimalen, bijv. "12.50".
  if (typeof value !== 'string' || !/^\d+\.\d{2}$/.test(value)) return null;
  const [euros, cents] = value.split('.');
  return Number(euros) * 100 + Number(cents);
}

function parseBody(req) {
  const body = req.body;
  if (body == null || body === '') return {};
  if (typeof body === 'string') {
    try { return JSON.parse(body); } catch { throw new HttpError(400, 'Ongeldige JSON'); }
  }
  return body;
}

function bearerToken(req) {
  const header = req.headers.authorization || req.headers.Authorization || '';
  const match = /^Bearer\s+([A-Za-z0-9._-]{20,4096})$/.exec(header);
  return match ? match[1] : null;
}

module.exports = {
  HttpError, env, rpc, rpcAsUser, mollie, centsToMollie, mollieToCents, parseBody, bearerToken,
};
