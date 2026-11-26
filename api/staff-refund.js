// POST /api/staff-refund
// Header: Authorization: Bearer <JWT van ingelogde medewerker>
// Body: { restaurant_id, order_id, payment_id }
// Alleen eigenaar/manager. De database controleert de rol met de JWT van de
// medewerker; pas daarna wordt bij Mollie terugbetaald (sleutel blijft op de server).
const { HttpError, rpc, rpcAsUser, mollie, centsToMollie, parseBody, bearerToken } = require('./_lib');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Alleen POST toegestaan' });
  }
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'Log opnieuw in.' });

  try {
    const { restaurant_id, order_id, payment_id } = parseBody(req);
    if (!UUID.test(restaurant_id || '') || !UUID.test(order_id || '') || !UUID.test(payment_id || '')) {
      return res.status(400).json({ error: 'Ongeldige aanvraag' });
    }

    let prepared;
    try {
      prepared = await rpcAsUser('qr_staff_refund_prepare', {
        p_restaurant_id: restaurant_id, p_order_id: order_id, p_payment_id: payment_id,
      }, token);
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) {
        const forbidden = e.status === 401 || e.status === 403 || (e.details && e.details.code === '42501');
        return res.status(forbidden ? 403 : 400).json({
          error: forbidden ? 'Alleen een eigenaar of manager kan terugbetalen.' : e.message,
        });
      }
      throw e;
    }
    if (prepared.already_refunded) {
      return res.status(200).json({ refunded: true, replayed: true });
    }

    const refund = await mollie('/payments/' + encodeURIComponent(prepared.provider_payment_id) + '/refunds', {
      method: 'POST',
      // Zelfde payment_id => zelfde sleutel: dubbelklikken leidt niet tot twee terugbetalingen.
      headers: { 'Idempotency-Key': 'refund-' + payment_id },
      body: JSON.stringify({
        amount: { currency: 'EUR', value: centsToMollie(prepared.amount_cents) },
        description: 'Terugbetaling bestelling #' + prepared.order_number,
      }),
    });

    await rpc('qr_record_online_refund', {
      p_provider_payment_id: prepared.provider_payment_id,
      p_refund_id: refund.id,
      p_user_id: prepared.user_id,
    });
    return res.status(200).json({ refunded: true, replayed: false, refund_id: refund.id });
  } catch (e) {
    console.error('staff-refund fout:', e.message);
    if (e instanceof HttpError && e.status === 422) {
      return res.status(400).json({ error: 'Mollie weigerde de terugbetaling: ' + e.message });
    }
    return res.status(500).json({
      error: 'Terugbetaling niet bevestigd. Controleer in het Mollie-dashboard voordat je het opnieuw probeert.',
    });
  }
};
