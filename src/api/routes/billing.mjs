// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  getBillingSnapshot,
  cancelSubscription,
  resumeSubscription
} from '../../domain/billing/service.mjs';
import { getSubscriptionPlansCatalog } from '../../domain/plans/service.mjs';
import { initiateCheckout } from '../../domain/payment/service.mjs';
import { getProvider } from '../../domain/payment/provider.mjs';
import { getPool } from '../../persistence/connection.mjs';

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

// GET /api/v1/billing/plans - Dynamic Server-Driven Subscription Plans Catalog (CNT-BILL-PLANS-01)
router.get('/plans', async (req, res, next) => {
  try {
    const catalog = await getSubscriptionPlansCatalog();
    res.json(catalog);
  } catch (err) {
    next(err);
  }
});

// Checkout handler supporting Contract Section 8.1 #13 and backward compatibility
async function handleCheckout(req, res, next) {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { planId, planName, billingInterval = 'monthly', returnUrl } = req.body;
    const idempotencyKey = req.headers['idempotency-key'] || `chk-${Date.now()}`;
    const targetPlanId = (planId || planName || 'pro').toLowerCase();
    const interval = (billingInterval || 'monthly').toLowerCase();

    const pool = getPool();
    const planRes = await pool.query('SELECT * FROM subscription_plans WHERE LOWER(plan_id) = $1', [targetPlanId]);
    const plan = planRes.rows[0];

    const amount = plan ? (interval === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price)) : 10000;
    const resolvedPlanName = plan ? plan.name : (targetPlanId.charAt(0).toUpperCase() + targetPlanId.slice(1));
    const resolvedPlanId = plan ? plan.plan_id : targetPlanId;

    const checkoutUrl = await initiateCheckout(
      accountId,
      resolvedPlanId,
      returnUrl || 'https://app.bettingautomation.io/billing/return',
      idempotencyKey.toString(),
      interval
    );

    const refMatch = checkoutUrl.match(/\/pay\/([^?]+)/);
    const reference = refMatch ? refMatch[1] : (checkoutUrl.split('/').pop()?.split('?')[0] || `flw_${Date.now()}`);

    res.json({
      checkoutUrl,
      authorizationUrl: checkoutUrl, // backward compatibility
      reference,
      accessCode: reference, // backward compatibility
      amount,
      currency: 'NGN',
      currencySymbol: '₦',
      planName: resolvedPlanName,
      billingInterval: interval
    });
  } catch (err) {
    next(err);
  }
}

// POST /api/v1/billing/checkout & /checkout/initialize
router.post('/checkout', operatorAuth, handleCheckout);
router.post('/checkout/initialize', operatorAuth, handleCheckout);

// Verification handler supporting /checkout/verify and /verify
async function handleVerify(req, res, next) {
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
}

// POST /api/v1/billing/checkout/verify & /verify
router.post('/checkout/verify', operatorAuth, handleVerify);
router.post('/verify', operatorAuth, handleVerify);

// Cancellation handlers
async function handleCancel(req, res, next) {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await cancelSubscription(accountId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

router.post('/subscription/cancel', operatorAuth, handleCancel);
router.post('/cancel', operatorAuth, handleCancel);

// Resume handlers
async function handleResume(req, res, next) {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const result = await resumeSubscription(accountId);
    res.json(result);
  } catch (err) {
    next(err);
  }
}

router.post('/subscription/resume', operatorAuth, handleResume);
router.post('/resume', operatorAuth, handleResume);

// POST /api/v1/billing/session - Manage cards portal session
router.post('/session', operatorAuth, async (req, res, next) => {
  try {
    res.json({ portalUrl: 'https://flutterwave.com' });
  } catch (err) {
    next(err);
  }
});

export default router;
