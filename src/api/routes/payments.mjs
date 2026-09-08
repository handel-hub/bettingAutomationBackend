// @ts-check
import { Router } from 'express';
import { initiateCheckout } from '../../domain/payment/service.mjs';
import { handleWebhook } from '../../domain/payment/webhook-handler.mjs';
import { getProvider } from '../../domain/payment/provider.mjs';
import { getPool } from '../../persistence/connection.mjs';

const router = Router();

// Endpoint for initiating a checkout (synchronous to provider, NO state mutation)
router.post('/checkout', async (req, res, next) => {
  try {
    // In reality, authenticate the user to get accountId
    const { accountId, planId, returnUrl } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || `chk-${Date.now()}`;
    
    if (!accountId || !planId) {
      return res.status(400).json({ error: 'Missing accountId or planId' });
    }
    
    const checkoutUrl = await initiateCheckout(accountId, planId, returnUrl || 'https://example.com/return', idempotencyKey.toString());
    
    res.json({ checkoutUrl });
  } catch (err) {
    next(err);
  }
});

// Callback redirect target for customer browser after Paystack payment
router.get('/callback', (req, res) => {
  const { reference, trxref } = req.query;
  res.send(`
    <html>
      <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
        <h2>Payment Processed!</h2>
        <p>Reference: ${reference || trxref || 'N/A'}</p>
        <p>You can close this window and return to your application.</p>
      </body>
    </html>
  `);
});

// Endpoint for webhooks (async mutation via outbox)
router.post('/webhook', async (req, res, next) => {
  try {
    const signature = (
      req.headers['x-paystack-signature'] || 
      req.headers['x-provider-signature'] || 
      ''
    ).toString();
    
    const rawPayload = JSON.stringify(req.body);
    
    const provider = getProvider();
    if (!provider.verifyWebhookSignature(rawPayload, signature)) {
      console.warn('Paystack webhook signature verification failed');
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    // Extract info from payload depending on provider (Paystack, etc.)
    const providerEventId = String(req.body.data?.id || req.body.id || `evt-${Date.now()}`);
    const eventType = req.body.event || 'UNKNOWN_EVENT';
    let accountId = req.body.data?.metadata?.account_id || req.body.account_id;
    
    if (!accountId && req.body.data?.customer?.email) {
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
    
    const idempotencyKey = req.headers['idempotency-key']?.toString() || providerEventId;
    
    await handleWebhook('paystack', providerEventId, eventType, accountId, idempotencyKey, req.body);
    
    // Return 200 immediately, async worker handles the rest
    res.status(200).send('OK');
  } catch (err) {
    next(err);
  }
});

export default router;
