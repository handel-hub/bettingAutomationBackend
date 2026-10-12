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
import { initiateCheckout, recordCheckoutBinding, getCheckoutBinding } from '../../domain/payment/service.mjs';
import { getProvider } from '../../domain/payment/provider.mjs';
import { getPool } from '../../persistence/connection.mjs';
import { signLicensePayload } from '../../domain/licensing/service.mjs';
import { buildEnvelope } from '../../protocol/envelope.mjs';

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
    const planRes = await pool.query('SELECT * FROM subscription_plans WHERE LOWER(plan_id) = $1 AND is_active = true', [targetPlanId]);
    const plan = planRes.rows[0];
    if (!plan) {
      return res.status(400).json({
        code: 'INVALID_PLAN',
        error: `Unknown or inactive subscription plan: ${targetPlanId}`
      });
    }

    const amount = interval === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);
    const resolvedPlanName = plan.name;
    const resolvedPlanId = plan.plan_id;

    const effectiveReturnUrl = returnUrl || 'http://localhost:3000/workspace/billing';
    try {
      const parsedReturnUrl = new URL(String(effectiveReturnUrl));
      if (parsedReturnUrl.protocol !== 'http:' && parsedReturnUrl.protocol !== 'https:') {
        return res.status(400).json({ code: 'INVALID_RETURN_URL', error: 'returnUrl must use http or https protocol' });
      }
    } catch {
      return res.status(400).json({ code: 'INVALID_RETURN_URL', error: 'Invalid returnUrl format' });
    }

    const checkoutUrl = await initiateCheckout(
      accountId,
      resolvedPlanId,
      effectiveReturnUrl,
      idempotencyKey.toString(),
      interval
    );

    const txRefMatch = checkoutUrl.match(/[?&]tx_ref=([^&#]+)/);
    const payMatch = checkoutUrl.match(/\/pay\/([^?&#]+)/);
    const reference = txRefMatch ? decodeURIComponent(txRefMatch[1]) : (payMatch ? payMatch[1] : `flw_${accountId}_${Date.now()}`);

    recordCheckoutBinding(reference, {
      accountId,
      planId: resolvedPlanId,
      billingInterval: interval,
      expectedAmount: amount
    });

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
      const providerRef = String(tx.data?.tx_ref || tx.data?.reference || reference).trim();
      const providerTxId = String(tx.data?.id || reference).trim();
      const boundCheckout = getCheckoutBinding(String(reference).trim()) || getCheckoutBinding(providerRef);

      // 1. Authoritative checkout initiation binding check
      if (boundCheckout && boundCheckout.accountId && boundCheckout.accountId !== accountId) {
        return res.status(403).json({
          verified: false,
          code: 'CROSS_TENANT_REFERENCE_DENIED',
          error: 'Transaction reference was initiated by a different account'
        });
      }

      // 2. Tenant isolation guard: if account_id is embedded in payment metadata, verify it matches
      if (txMeta.account_id && txMeta.account_id !== accountId) {
        return res.status(403).json({ error: 'Transaction belongs to a different account' });
      }

      // 3. Embedded UUID guard in reference / providerRef (e.g. flw_<uuid>_ or account=<uuid>)
      const embeddedFlwMatch = providerRef.match(/^flw_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i) ||
        String(reference).match(/^flw_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i);
      const embeddedQueryMatch = providerRef.match(/[?&]account=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i) ||
        String(reference).match(/[?&]account=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
      const embeddedAccId = embeddedFlwMatch?.[1] || embeddedQueryMatch?.[1] || null;
      if (embeddedAccId && embeddedAccId.toLowerCase() !== String(accountId).toLowerCase()) {
        return res.status(403).json({
          verified: false,
          code: 'CROSS_TENANT_REFERENCE_DENIED',
          error: 'Transaction reference is bound to a different account'
        });
      }

      const pool = getPool();

      // 4. Verify tx.data?.customer?.email against the authenticated account's email
      const txCustomerEmail = tx.data?.customer?.email ? String(tx.data.customer.email).trim().toLowerCase() : null;
      if (txCustomerEmail) {
        const accRes = await pool.query('SELECT email FROM accounts WHERE account_id = $1', [accountId]);
        const callerEmail = accRes.rows[0]?.email ? String(accRes.rows[0].email).trim().toLowerCase() : null;
        if (callerEmail && txCustomerEmail !== callerEmail) {
          return res.status(403).json({
            verified: false,
            code: 'CUSTOMER_EMAIL_MISMATCH',
            error: 'Transaction customer email does not match authenticated account'
          });
        }
      }

      // 5. Prevent plan upgrade spoofing against initiated checkout binding
      if (boundCheckout?.planId && !txMeta.plan_id && req.body.planId && String(req.body.planId).toLowerCase() !== boundCheckout.planId) {
        return res.status(400).json({
          verified: false,
          code: 'PLAN_METADATA_MISMATCH',
          error: `Requested plan (${req.body.planId}) does not match initiated checkout plan (${boundCheckout.planId})`
        });
      }

      const planId = (txMeta.plan_id || boundCheckout?.planId || req.body.planId || 'pro').toLowerCase();
      const billingInterval = (txMeta.billing_interval || boundCheckout?.billingInterval || req.body.billingInterval || 'monthly').toLowerCase();
      const hasVerifiedPlanMeta = Boolean(txMeta.plan_id || boundCheckout?.planId);

      // Verify transaction currency is NGN
      const currency = String(tx.data?.currency || 'NGN').trim().toUpperCase();
      if (currency !== 'NGN') {
        return res.status(400).json({
          verified: false,
          code: 'CURRENCY_MISMATCH',
          error: `Unsupported transaction currency: expected NGN, received ${currency}`
        });
      }

      // Reject missing payment amounts (zero-trust: never default to 10000)
      const rawAmountVal = tx.data?.charged_amount ?? tx.data?.amount;
      if (rawAmountVal === undefined || rawAmountVal === null || Number.isNaN(Number(rawAmountVal)) || Number(rawAmountVal) <= 0) {
        return res.status(400).json({
          verified: false,
          code: 'MISSING_PAYMENT_AMOUNT',
          error: 'Verified transaction is missing a valid positive payment amount'
        });
      }

      // Normalize Paystack minor units (Kobo: 100 Kobo = 1 NGN) vs Flutterwave major units
      const isPaystack = Boolean(
        tx.data?.authorization ||
        tx.data?.domain ||
        (!tx.data?.flw_ref && !tx.data?.charged_amount && tx.data?.status === 'success')
      );
      const rawAmount = Number(rawAmountVal);
      const amount = isPaystack ? (rawAmount / 100) : rawAmount;
      const receiptUrl = tx.data?.receipt_url || null;

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
          code: 'PAYMENT_AMOUNT_MISMATCH',
          error: `Payment amount (${amount}) is insufficient for requested plan (${planId}: ${expectedPrice})`
        });
      }
      // Prevent cross-tier plan spoofing (e.g. using a Starter Annual payment to claim Pro Monthly when provider metadata omits plan_id)
      if (!hasVerifiedPlanMeta && amount !== expectedPrice) {
        return res.status(400).json({
          verified: false,
          code: 'PLAN_METADATA_MISMATCH',
          error: `Payment amount (${amount}) does not match exact price (${expectedPrice}) for unverified plan ${planId}`
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
    const responseCapabilities = paymentResult?.capabilities || [
      'CAP_EXECUTE',
      'CAP_OFFLINE_GRACE',
      'CAP_TELEMETRY_WRITE',
      'CAP_CONFIG_MODIFY',
      'CAP_AUTOMATION_START',
      'CAP_AUTOMATION_STOP',
      'CAP_ACCOUNT_MANAGE',
      'CAP_FILE_UPLOAD',
      'CAP_TACTICAL_BET',
      'CAP_CASH_OUT'
    ];
    const rawLicense = paymentResult ? {
      id: paymentResult.licenseId,
      licenseId: paymentResult.licenseId,
      accountId,
      status: paymentResult.licenseStatus || 'VALID',
      planId: paymentResult.planId,
      expiresAt: paymentResult.expiresAt || snapshot?.expirationDate || null,
      capabilities: paymentResult.capabilities,
      limits: paymentResult.limits
    } : {
      id: snapshot?.subscription?.id || `lic-${accountId}`,
      licenseId: snapshot?.subscription?.id || `lic-${accountId}`,
      accountId,
      status: 'VALID',
      planId: snapshot?.subscription?.planId || 'pro',
      expiresAt: snapshot?.expirationDate || null,
      capabilities: responseCapabilities
    };
    const signedLicense = rawLicense.status === 'VALID'
      ? await signLicensePayload(rawLicense)
      : rawLicense;

    const responsePayload = {
      verified: true,
      status: 'Authorized',
      snapshot,
      license: signedLicense,
      capabilities: responseCapabilities
    };
    const signedEnvelope = await buildEnvelope(responsePayload, 1);

    res.json({
      ...signedEnvelope,
      ...responsePayload
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
