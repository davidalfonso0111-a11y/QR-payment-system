// POST /api/mollie-webhook  (door Mollie aangeroepen met body: id=tr_xxx)
// We vertrouwen de webhook niet: de betaling wordt opnieuw bij Mollie opgehaald.
const { rpc, mollie, mollieToCents } = require('./_lib');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).end();
  }
  try {
    let body = req.body;
    if (typeof body === 'string') {
      body = Object.fromEntries(new URLSearchParams(body));
    }
    const id = body && body.id;
    if (typeof id !== 'string' || !/^tr_[A-Za-z0-9]{3,60}$/.test(id)) {
      return res.status(400).end();
    }

    const payment = await mollie('/payments/' + id, { method: 'GET' });
    try {
      await rpc('qr_apply_mollie_status', {
        p_provider_payment_id: id,
        p_mollie_status: payment.status,
        p_amount_cents: mollieToCents(payment.amount && payment.amount.value),
        p_currency: payment.amount && payment.amount.currency,
      });
    } catch (e) {
      // Betaling hoort niet bij ons (bijv. test of ander project): niet eindeloos laten herhalen.
      if (/Onbekende betaling/.test(e.message)) return res.status(200).end();
      throw e;
    }

    return res.status(200).end();
  } catch (e) {
    console.error('mollie-webhook fout:', e.message);
    // 500 zodat Mollie het later opnieuw probeert.
    return res.status(500).end();
  }
};
