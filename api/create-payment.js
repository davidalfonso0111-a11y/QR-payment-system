// POST /api/create-payment
// Body: { qr_token, idempotency_key, guest_secret, items }
// Maakt een bestelling (wacht op betaling) en een Mollie-betaling. Prijzen komen uit de database.
// Een herhaalde aanvraag (zelfde idempotency_key) hergebruikt een nog openstaande
// Mollie-betaling in plaats van steeds een nieuwe aan te maken.
const { HttpError, env, rpc, mollie, centsToMollie, mollieToCents, parseBody } = require('./_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkoutUrl(payment) {
  return payment && payment._links && payment._links.checkout ? payment._links.checkout.href : null;
}

async function syncStatus(payment) {
  return rpc('qr_apply_mollie_status', {
    p_provider_payment_id: payment.id,
    p_mollie_status: payment.status,
    p_amount_cents: mollieToCents(payment.amount && payment.amount.value),
    p_currency: payment.amount && payment.amount.currency,
  });
}

// Zoek een bruikbare openstaande betaling; verwerk intussen afgeronde betalingen.
async function reuseOpenPayment(orderId) {
  const pending = await rpc('qr_online_pending_payments', { p_order_id: orderId });
  let paid = false;
  for (const id of (pending || []).slice(0, 5)) {
    const payment = await mollie('/payments/' + encodeURIComponent(id), { method: 'GET' });
    if (payment.status === 'open' && checkoutUrl(payment)) {
      return { checkout_url: checkoutUrl(payment) };
    }
    if (['paid', 'failed', 'canceled', 'expired'].includes(payment.status)) {
      const result = await syncStatus(payment);
      if (result && result.result === 'paid') paid = true;
    }
  }
  return { paid };
}

function summary(order, extra) {
  return {
    order_id: order.id,
    order_number: order.order_number,
    total_cents: order.total_cents,
    status: order.status,
    payment_status: order.payment_status,
    checkout_url: null,
    ...extra,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST toegestaan' });
  }
  try {
    const { qr_token, idempotency_key, guest_secret, items } = parseBody(req);

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
      // Al betaald, geannuleerd of verwerkt: geen nieuwe betaling.
      return res.status(200).json(summary(order));
    }

    if (order.replayed) {
      const reused = await reuseOpenPayment(order.id);
      if (reused.checkout_url) {
        return res.status(200).json(summary(order, { checkout_url: reused.checkout_url }));
      }
      if (reused.paid) {
        return res.status(200).json(summary(order, { status: 'received', payment_status: 'paid' }));
      }
    }

    const site = env('PUBLIC_SITE_URL').replace(/\/+$/, '');
    let payment;
    try {
      payment = await mollie('/payments', {
        method: 'POST',
        body: JSON.stringify({
          amount: { currency: 'EUR', value: centsToMollie(order.total_cents) },
          description: 'Bestelling #' + order.order_number,
          redirectUrl: site + '/?table=' + encodeURIComponent(qr_token) + '&order=' + encodeURIComponent(order.id),
          webhookUrl: site + '/api/mollie-webhook',
          metadata: { order_id: order.id },
        }),
      });
    } catch (e) {
      console.error('Mollie create fout:', e.message);
      return res.status(502).json({ error: 'De betaalprovider is niet bereikbaar. Probeer het opnieuw.' });
    }

    try {
      await rpc('qr_attach_online_payment', {
        p_order_id: order.id,
        p_provider_payment_id: payment.id,
      });
    } catch (e) {
      // Bestelling is intussen niet meer betaalbaar: Mollie-betaling intrekken.
      console.error('attach fout:', e.message);
      try { await mollie('/payments/' + encodeURIComponent(payment.id), { method: 'DELETE' }); } catch {}
      return res.status(409).json({ error: 'Deze bestelling kan niet meer betaald worden. Bestel opnieuw.' });
    }

    return res.status(200).json(summary(order, { checkout_url: checkoutUrl(payment) }));
  } catch (e) {
    console.error('create-payment fout:', e.message);
    if (e instanceof HttpError && e.status >= 400 && e.status < 500 && e.details && e.details.code === 'P0001') {
      // Validatiefout uit de database (bijv. "Product niet beschikbaar").
      return res.status(400).json({ error: e.message });
    }
    return res.status(500).json({ error: 'Betaling kon niet worden gestart. Probeer het opnieuw.' });
  }
};
