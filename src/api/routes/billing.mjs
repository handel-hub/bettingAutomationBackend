// @ts-check
import { Router } from 'express';
import { operatorAuth } from '../middleware/operator-auth.mjs';
import {
  getBillingSnapshot,
  cancelSubscription,
  resumeSubscription,
  applyPaymentSuccess
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
    const idempotencyKey = req.headers['idempotency-key'] || req.body?.idempotencyKey;
    if (!idempotencyKey) {
      return res.status(400).json({
        code: 'BE_VALIDATION_MISSING_IDEMPOTENCY_KEY',
        error: 'Missing required Idempotency-Key header for checkout request'
      });
    }
    const { planId, planName, billingInterval = 'monthly', returnUrl } = req.body || {};
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
      returnUrl || 'http://localhost:3000/workspace/billing',
      idempotencyKey.toString(),
      interval
    );

    const txRefMatch = checkoutUrl.match(/[?&]tx_ref=([^&#]+)/);
    const payMatch = checkoutUrl.match(/\/pay\/([^?&#]+)/);
    const reference = txRefMatch ? decodeURIComponent(txRefMatch[1]) : (payMatch ? payMatch[1] : `flw_${Date.now()}`);

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

// Verification handler supporting /checkout/verify and /verify with dual-path instant activation
async function handleVerify(req, res, next) {
  try {
    // @ts-ignore
    const accountId = req.accountId;
    const { reference } = req.body;

    if (!reference) {
      return res.status(400).json({ error: 'Missing transaction reference' });
    }

    const provider = getProvider();
    let tx = null;
    try {
      if (provider.verifyTransaction) {
        tx = await provider.verifyTransaction(reference);
      }
    } catch (providerErr) {
      return res.status(400).json({
        verified: false,
        error: providerErr.message || 'Payment provider verification failed'
      });
    }

    // Determine verification success (supporting both Flutterwave 'successful' and Paystack 'success')
    const isSuccess = Boolean(
      tx &&
      (tx.status === 'success' || tx.status === true) &&
      (!tx.data || tx.data.status === 'successful' || tx.data.status === 'success' || !tx.data.status)
    );

    if (!isSuccess) {
      const snapshot = await getBillingSnapshot(accountId);
      return res.status(400).json({
        verified: false,
        error: 'Payment transaction was not successful or has not been completed',
        snapshot
      });
    }

    let paymentResult = null;
    if (isSuccess && accountId) {
      const txMeta = tx.data?.meta || tx.data?.metadata || {};
      
      // Tenant isolation guard: if account_id is embedded in payment metadata, verify it matches
      if (txMeta.account_id && txMeta.account_id !== accountId) {
        return res.status(403).json({ error: 'Transaction belongs to a different account' });
      }

      const planId = (txMeta.plan_id || req.body.planId || 'pro').toLowerCase();
      const billingInterval = (txMeta.billing_interval || req.body.billingInterval || 'monthly').toLowerCase();

      // Normalize Paystack minor units (Kobo) vs Flutterwave major units
      const isPaystack = Boolean(
        tx.data?.authorization ||
        tx.data?.domain ||
        (!tx.data?.flw_ref && !tx.data?.charged_amount && tx.data?.status === 'success')
      );
      const rawAmount = Number(tx.data?.charged_amount ?? tx.data?.amount ?? 10000);
      const amount = (isPaystack && rawAmount >= 100000) ? (rawAmount / 100) : rawAmount;
      const receiptUrl = tx.data?.receipt_url || null;
      const providerRef = String(tx.data?.tx_ref || tx.data?.reference || reference).trim();
      const providerTxId = String(tx.data?.id || reference).trim();

      const pool = getPool();
      const planRes = await pool.query('SELECT * FROM subscription_plans WHERE LOWER(plan_id) = $1 AND is_active = true', [planId]);
      const plan = planRes.rows[0];

      if (!plan) {
        return res.status(400).json({
          verified: false,
          error: `Unknown or inactive subscription plan: ${planId}`
        });
      }

      const expectedPrice = billingInterval === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);
      if (amount < expectedPrice) {
        return res.status(400).json({
          verified: false,
          error: `Payment amount (${amount}) is insufficient for requested plan (${planId}: ${expectedPrice})`
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        paymentResult = await applyPaymentSuccess(client, {
          accountId,
          planId,
          billingInterval,
          amount,
          reference: providerRef,
          providerTxId,
          receiptUrl
        });
        await client.query('COMMIT');
      } catch (dbErr) {
        await client.query('ROLLBACK');
        if (dbErr && dbErr.code === 'PAYMENT_ALREADY_REDEEMED') {
          return res.status(409).json({
            verified: false,
            code: 'PAYMENT_ALREADY_REDEEMED',
            error: dbErr.message
          });
        }
        throw dbErr;
      } finally {
        client.release();
      }
    }

    const snapshot = await getBillingSnapshot(accountId);
    res.json({
      verified: true,
      status: 'Authorized',
      snapshot,
      license: paymentResult ? {
        licenseId: paymentResult.licenseId,
        status: paymentResult.licenseStatus || 'VALID',
        planId: paymentResult.planId,
        capabilities: paymentResult.capabilities,
        limits: paymentResult.limits
      } : { status: 'VALID' },
      capabilities: paymentResult?.capabilities || [
        'CAP_AUTOMATION_START',
        'CAP_AUTOMATION_STOP',
        'CAP_FILE_UPLOAD',
        'CAP_TACTICAL_BET',
        'CAP_CASH_OUT'
      ]
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
