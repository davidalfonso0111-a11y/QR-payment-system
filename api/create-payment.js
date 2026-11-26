// POST /api/create-payment
// Body: { qr_token, idempotency_key, guest_secret, items }
// Maakt een bestelling (wacht op betaling) en een Mollie-betaling. Prijzen komen uit de database.
const { env, rpc, mollie } = require('./_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST toegestaan' });
  }
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body || {};
    const { qr_token, idempotency_key, guest_secret, items } = body;

    if (!UUID.test(qr_token || '') || !UUID.test(idempotency_key || '')
        || !/^[0-9a-f]{64}$/.test(guest_secret || '')
        || !Array.isArray(items) || items.length === 0 || items.length > 50) {
      return res.status(400).json({ error: 'Ongeldige bestelaanvraag' });
    }

    const order = await rpc('qr_create_online_order', {
      p_qr_token: qr_token,
      p_idempotency_key: idempotency_key,
      p_guest_secret: guest_secret,
      p_items: items,
    });

    if (order.status !== 'awaiting_payment') {
      // Dezelfde aanvraag is al verwerkt (bijv. al betaald of geannuleerd).
      return res.status(200).json({
        order_id: order.id,
        order_number: order.order_number,
        status: order.status,
        payment_status: order.payment_status,
        checkout_url: null,
      });
    }

    const site = env('PUBLIC_SITE_URL').replace(/\/+$/, '');
    const payment = await mollie('/payments', {
      method: 'POST',
      body: JSON.stringify({
        amount: { currency: 'EUR', value: (order.total_cents / 100).toFixed(2) },
        description: 'Bestelling #' + order.order_number,
        redirectUrl: site + '/?table=' + qr_token + '&order=' + order.id,
        webhookUrl: site + '/api/mollie-webhook',
        metadata: { order_id: order.id },
      }),
    });

    await rpc('qr_attach_online_payment', {
      p_order_id: order.id,
      p_provider_payment_id: payment.id,
    });

    return res.status(200).json({
      order_id: order.id,
      order_number: order.order_number,
      total_cents: order.total_cents,
      status: order.status,
      payment_status: order.payment_status,
      checkout_url: payment._links && payment._links.checkout ? payment._links.checkout.href : null,
    });
  } catch (e) {
    console.error('create-payment fout:', e.message);
    return res.status(500).json({ error: 'Betaling kon niet worden gestart. Probeer het opnieuw.' });
  }
};
