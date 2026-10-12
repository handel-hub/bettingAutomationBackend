// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import { initiateCheckout } from '../../domain/payment/service.mjs';
import { handleWebhook } from '../../domain/payment/webhook-handler.mjs';
import { getProvider } from '../../domain/payment/provider.mjs';
import { getPool } from '../../persistence/connection.mjs';

const router = Router();

/**
 * @param {any} str
 * @returns {string}
 */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Endpoint for initiating a checkout (synchronous to provider, NO state mutation)
router.post('/checkout', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const authenticatedAccountId = req.accountId;
    const { accountId: bodyAccountId, planId, returnUrl } = req.body || {};
    if (bodyAccountId && bodyAccountId !== authenticatedAccountId) {
      return res.status(403).json({ error: 'Cannot initiate checkout for a different account' });
    }
    const accountId = authenticatedAccountId;
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey;
    if (!idempotencyKey) {
      return res.status(400).json({
        code: 'BE_VALIDATION_MISSING_IDEMPOTENCY_KEY',
        error: 'Missing required Idempotency-Key header for checkout request'
      });
    }
    
    if (!accountId || !planId) {
      return res.status(400).json({ error: 'Missing accountId or planId' });
    }
    
    const checkoutUrl = await initiateCheckout(accountId, planId, returnUrl || 'https://example.com/return', idempotencyKey.toString());
    
    res.json({ checkoutUrl });
  } catch (err) {
    next(err);
  }
});

// Callback redirect target for customer browser after payment
router.get('/callback', (req, res) => {
  const reference = escapeHtml(req.query.reference || req.query.trxref || req.query.tx_ref || req.query.transaction_id || 'N/A');
  const status = escapeHtml(req.query.status || 'success');
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>Payment Processed!</h2>
        <p>Reference: ${reference}</p>
        <p>Status: ${status}</p>
        <p>You can close this window and return to your application.</p>
      </body>
    </html>
  `);
});

// Endpoint for webhooks (async mutation via outbox)
router.post('/webhook', async (req, res, next) => {
  try {
    const signature = (
      req.headers['verif-hash'] ||
      req.headers['verif_hash'] ||
      req.headers['flutterwave-signature'] ||
      req.headers['x-flutterwave-signature'] ||
      req.headers['x-paystack-signature'] || 
      req.headers['x-provider-signature'] || 
      ''
    ).toString();
    
    const rawPayload = req.rawBody || JSON.stringify(req.body);
    
    const provider = getProvider();
    if (!provider.verifyWebhookSignature(rawPayload, signature)) {
      console.warn('Payment webhook signature verification failed');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    // Extract info from payload supporting both Flutterwave and Paystack schemas
    const providerEventId = String(req.body.data?.id || req.body.id || `evt-${Date.now()}`);
    let eventType = req.body.event || 'UNKNOWN_EVENT';

    // Normalize Flutterwave charge.completed based on data.status
    if (eventType === 'charge.completed') {
      const chargeStatus = req.body.data?.status;
      if (chargeStatus === 'successful') {
        eventType = 'charge.completed';
      } else {
        eventType = 'charge.failed';
      }
    }

    let accountId = req.body.data?.meta?.account_id || req.body.data?.metadata?.account_id || req.body.account_id;
    const txRef = req.body.data?.tx_ref || req.body.data?.reference;
    const hasFlwHeader = Boolean(
      req.headers['verif-hash'] ||
      req.headers['verif_hash'] ||
      req.headers['flutterwave-signature'] ||
      req.headers['x-flutterwave-signature']
    );
    const hasPaystackHeader = Boolean(req.headers['x-paystack-signature']);
    const isFlw = hasFlwHeader || (Boolean(req.body.data?.flw_ref) && !hasPaystackHeader);
    const providerName = isFlw ? 'flutterwave' : 'paystack';

    // If accountId is not directly in webhook payload, verify transaction with Flutterwave API to fetch full metadata
    if (!accountId && isFlw && req.body.data?.id && typeof provider.verifyTransaction === 'function') {
      try {
        const verified = await provider.verifyTransaction(req.body.data.id);
        if (verified?.data?.meta?.account_id) {
          accountId = verified.data.meta.account_id;
          req.body.data = { ...req.body.data, ...verified.data };
        }
      } catch (err) {
        console.warn('Flutterwave verifyTransaction fallback error:', err.message);
      }
    }

    // Fallback: extract UUID from tx_ref if present
    if (!accountId && txRef) {
      const uuidMatch = txRef.match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/i);
      if (uuidMatch) {
        accountId = uuidMatch[1];
      }
    }
    
    // Do NOT allow unverified customer.email fallback on failed charges (prevents cross-tenant PAST_DUE DoS - USF-03)
    const isFailedEvent = eventType === 'charge.failed' || eventType.includes('fail') || eventType.includes('declined');
    if (!accountId && !isFailedEvent && req.body.data?.customer?.email) {
      const pool = getPool();
      const accRes = await pool.query('SELECT account_id FROM accounts WHERE email = $1', [req.body.data.customer.email]);
      if (accRes.rows.length > 0) {
        accountId = accRes.rows[0].account_id;
      }
    }
    
    if (!accountId) {
      console.warn('Webhook received with no resolvable accountId');
      return res.status(400).json({ error: 'Unresolvable account_id in payment webhook' });
    }
    
    const idempotencyKey = req.headers['idempotency-key']?.toString() || txRef || providerEventId;
    const webhookPayload = { ...req.body, _provider: providerName };

    await handleWebhook(providerName, providerEventId, eventType, accountId, idempotencyKey, webhookPayload);
    
    // Return 200 immediately, async worker handles the rest
    res.status(200).send('OK');
  } catch (err) {
    next(err);
  }
});

export default router;
