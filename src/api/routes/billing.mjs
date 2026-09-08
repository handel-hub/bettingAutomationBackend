// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  getBillingSnapshot,
  cancelSubscription,
  resumeSubscription
} from '../../domain/billing/service.mjs';
import { initiateCheckout } from '../../domain/payment/service.mjs';
import { getProvider } from '../../domain/payment/provider.mjs';

const router = Router();

// GET /api/v1/billing - Snapshot
router.get('/', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const snapshot = await getBillingSnapshot(accountId);
    res.json(snapshot);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/billing/checkout/initialize - Paystack checkout initialization
router.post('/checkout/initialize', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { planName = 'PRO', returnUrl } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || `chk-${Date.now()}`;

    const checkoutUrl = await initiateCheckout(accountId, planName.toUpperCase(), returnUrl, idempotencyKey.toString());
    const reference = checkoutUrl.split('/').pop() || `PSTK-${Date.now()}`;

    res.json({
      authorizationUrl: checkoutUrl,
      accessCode: reference,
      reference
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/billing/checkout/verify - Verify charge and return fresh snapshot
router.post('/checkout/verify', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { reference } = req.body;

    const provider = getProvider();
    if (provider.verifyTransaction) {
      await provider.verifyTransaction(reference);
    }

    const snapshot = await getBillingSnapshot(accountId);
    res.json({
      status: 'Authorized',
      snapshot
    });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/billing/subscription/cancel
router.post('/subscription/cancel', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await cancelSubscription(accountId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/billing/subscription/resume
router.post('/subscription/resume', operatorAuth, async (req, res, next) => {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await resumeSubscription(accountId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/billing/session - Manage cards portal session
router.post('/session', operatorAuth, async (req, res, next) => {
  try {
    res.json({ portalUrl: 'https://paystack.com' });
  } catch (err) {
    next(err);
  }
});

export default router;
