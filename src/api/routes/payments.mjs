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

// Endpoint for webhooks (async mutation via outbox)
router.post('/webhook', async (req, res, next) => {
  try {
    const signature = req.headers['x-provider-signature']?.toString() || '';
    const rawPayload = JSON.stringify(req.body);
    
    const provider = getProvider();
    if (!provider.verifyWebhookSignature(rawPayload, signature)) {
      return res.status(400).json({ error: 'Invalid signature' });
    }
    
    // Extract info from payload depending on provider (Paystack, etc.)
    const providerEventId = req.body.id || `evt-${Date.now()}`;
    const eventType = req.body.event || 'UNKNOWN_EVENT';
    const accountId = req.body.data?.metadata?.account_id || 'unknown_account';
    const idempotencyKey = req.headers['idempotency-key']?.toString() || providerEventId;
    
    await handleWebhook('paystack', providerEventId, eventType, accountId, idempotencyKey, req.body);
    
    // Return 200 immediately, async worker handles the rest
    res.status(200).send('OK');
  } catch (err) {
    next(err);
  }
});

export default router;
