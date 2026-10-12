// @ts-check
import {
  findSubscriptionByAccount,
  findInvoicesByAccount,
  findLatestPaymentAuth,
  cancelSubscriptionInDb,
  resumeSubscriptionInDb,
  upsertInvoice
} from './repository.mjs';

/**
 * Fetch BillingSnapshot for the operator.
 * Aggregates active subscription, payment method, notices, and persisted invoices.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getBillingSnapshot(accountId) {
  // 1. Fetch Subscription, Entitlements & Subscription Plan catalog metadata
  const sub = await findSubscriptionByAccount(undefined, accountId);

  const planPrice = sub?.monthly_price ? Number(sub.monthly_price) : (sub?.limits?.price || 10000);
  const billingInterval = sub?.limits?.interval || 'Monthly';
  const planName = sub?.sp_name || (sub?.plan_id ? (sub.plan_id.charAt(0).toUpperCase() + sub.plan_id.slice(1).toLowerCase()) : 'Pro');
  const currentPlanId = sub?.plan_id ? sub.plan_id.toLowerCase() : 'pro';

  // 2. Fetch Invoices with statutory tax and fiscal breakdown
  const invRows = await findInvoicesByAccount(undefined, accountId, 20);

  const invoices = invRows.map(r => {
    const gross = Number(r.amount);
    const taxRate = r.tax_rate !== null && r.tax_rate !== undefined ? Number(r.tax_rate) : 0.075;
    const subtotal = r.subtotal !== null && r.subtotal !== undefined ? Number(r.subtotal) : Math.round((gross / (1 + taxRate)) * 100) / 100;
    const taxAmount = r.tax_amount !== null && r.tax_amount !== undefined ? Number(r.tax_amount) : Math.round((gross - subtotal) * 100) / 100;
    return {
      id: r.id,
      reference: r.reference,
      date: r.paid_at || r.created_at,
      amount: gross,
      subtotal,
      taxAmount,
      taxRate,
      planName: r.plan_name || planName,
      billingInterval: r.billing_interval || billingInterval,
      currency: r.currency || 'NGN',
      currencySymbol: r.currency_symbol || '₦',
      status: r.status,
      receiptUrl: r.receipt_url
    };
  });

  // 3. Fetch latest payment event to infer card info if available
  const latestPayEvent = await findLatestPaymentAuth(undefined, accountId);

  let paymentMethod = null;
  if (latestPayEvent) {
    const authData = latestPayEvent.payload?.data?.authorization;
    if (authData) {
      paymentMethod = {
        cardBrand: authData.brand || authData.card_type || 'Mastercard',
        last4: authData.last4 || '4081',
        expMonth: authData.exp_month || '12',
        expYear: authData.exp_year || '2028'
      };
    }
  }

  // Determine available actions
  /** @type {('UPDATE_PAYMENT' | 'CANCEL_SUBSCRIPTION' | 'RESUME_SUBSCRIPTION' | 'CONTACT_SUPPORT')[]} */
  const availableActions = ['UPDATE_PAYMENT', 'CONTACT_SUPPORT'];
  if (sub?.status === 'ACTIVE') {
    availableActions.push('CANCEL_SUBSCRIPTION');
  } else if (sub?.status === 'CANCELLED') {
    availableActions.push('RESUME_SUBSCRIPTION');
  }

  const notices = [];
  if (sub?.sp_notices && Array.isArray(sub.sp_notices)) {
    notices.push(...sub.sp_notices);
  }
  if (sub?.status === 'PAST_DUE') {
    notices.push('Your latest subscription charge failed. Please update your payment method.');
  }

  return {
    currentPlan: planName,
    currentPlanId,
    price: planPrice,
    currency: 'NGN',
    currencySymbol: '₦',
    status: sub
      ? (sub.status === 'ACTIVE'
          ? 'Active'
          : (sub.status === 'PAST_DUE'
              ? 'Past_Due'
              : (sub.status === 'EXPIRED' ? 'Payment_Required' : 'Cancelled')))
      : 'Payment_Required',

    billingInterval,
    renewalDate: sub?.status === 'ACTIVE' ? sub.current_period_end : null,
    expirationDate: sub?.current_period_end || null,
    availableActions,
    notices,
    paymentMethod,
    invoices,
    invoiceSummary: {
      totalCount: invoices.length,
      paidCount: invoices.filter(i => i.status === 'Paid').length
    }
  };
}

/**
 * Cancel auto-renewal of subscription at period end.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function cancelSubscription(accountId) {
  const row = await cancelSubscriptionInDb(undefined, accountId);

  return {
    status: 'Cancelled',
    expirationDate: row?.current_period_end || new Date(Date.now() + 30 * 86400000).toISOString()
  };
}

/**
 * Resume auto-renewal of cancelled subscription.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function resumeSubscription(accountId) {
  const row = await resumeSubscriptionInDb(undefined, accountId);
  if (!row) {
    const err = new Error('Cannot resume an expired or non-existent subscription without payment');
    // @ts-ignore
    err.status = 402;
    // @ts-ignore
    err.code = 'SUBSCRIPTION_PERIOD_EXPIRED';
    throw err;
  }

  return {
    status: 'Active',
    renewalDate: row.current_period_end
  };
}

/**
 * Create a persistent invoice record in database with statutory VAT fields
 * @param {string} accountId 
 * @param {Object} invoiceData 
 * @returns {Promise<Object>}
 */
export async function createInvoice(accountId, invoiceData) {
  return upsertInvoice(undefined, accountId, invoiceData);
}

/**
 * Apply payment success state transition:
 * - Upserts subscription to ACTIVE
 * - Upserts license to VALID with entitlements
 * - Upserts invoice with VAT breakdown
 * - Emits canonical WebSocket events: SUBSCRIPTION_STATUS_CHANGED, LICENSE_UPDATED
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {Object} params
 * @param {string} params.accountId
 * @param {string} [params.planId]
 * @param {string} [params.billingInterval]
 * @param {number} [params.amount]
 * @param {string} [params.reference]
 * @param {string} [params.receiptUrl]
 * @param {string} [params.providerSubId]
 * @returns {Promise<Object>}
 */
export async function applyPaymentSuccess(client, {
  accountId,
  planId = 'pro',
  billingInterval = 'monthly',
  amount = 10000,
  reference,
  providerTxId = null,
  receiptUrl = null,
  providerSubId = null
}) {
  const { getPool } = await import('../../persistence/connection.mjs');
  const runner = client || getPool();
  const effectivePlanId = planId || 'pro';
  const normalizedPlanId = effectivePlanId.toLowerCase();
  const interval = (billingInterval || 'monthly').toLowerCase();
  const periodInterval = interval === 'annual' ? '365 days' : '30 days';
  const ref = String(reference || `ref-${Date.now()}`).trim();
  const txIdStr = providerTxId ? String(providerTxId).trim() : ref;

  // Serialize concurrent payment redemptions (/checkout/verify vs outbox webhook worker) for this account (F-04)
  await runner.query(
    'SELECT account_id FROM accounts WHERE account_id = $1 FOR UPDATE',
    [accountId]
  );

  // Canonical multi-alias replay & cross-account theft check (USF-02 / ADR-03)
  const candidateRefs = Array.from(new Set([ref, txIdStr, `inv-${ref}`, `inv-${txIdStr}`]));
  const existingInvRes = await runner.query(
    `SELECT id, reference, account_id FROM invoices
     WHERE reference = ANY($1::text[]) OR id = ANY($1::text[])
     FOR UPDATE`,
    [candidateRefs]
  );
  if (existingInvRes.rows.length > 0) {
    const err = new Error('Payment transaction reference has already been redeemed');
    // @ts-ignore
    err.status = 409;
    // @ts-ignore
    err.code = 'PAYMENT_ALREADY_REDEEMED';
    throw err;
  }

  // Validate planId against subscription_plans / plan_entitlements (USF-02)
  const planCheckRes = await runner.query(
    'SELECT plan_id, entitlements FROM subscription_plans WHERE LOWER(plan_id) = $1',
    [normalizedPlanId]
  );
  const entRes = await runner.query(
    'SELECT plan_id, capabilities, limits FROM plan_entitlements WHERE LOWER(plan_id) = $1',
    [normalizedPlanId]
  );
  if (planCheckRes.rows.length === 0 && entRes.rows.length === 0) {
    const err = new Error(`Unknown subscription plan: ${effectivePlanId}`);
    // @ts-ignore
    err.status = 400;
    // @ts-ignore
    err.code = 'INVALID_PLAN';
    throw err;
  }
  const canonicalPlanId = planCheckRes.rows[0]?.plan_id || entRes.rows[0]?.plan_id || effectivePlanId;

  // Fetch entitlements for capabilities & limits from authoritative plan_entitlements
  let capabilities = ['CAP_AUTOMATION_START', 'CAP_AUTOMATION_STOP', 'CAP_FILE_UPLOAD', 'CAP_TACTICAL_BET', 'CAP_CASH_OUT'];
  let limits = { max_machines: 5, max_concurrent_browsers: 5, risk_tier: 'LOW' };
  if (entRes.rows.length > 0) {
    capabilities = entRes.rows[0].capabilities || capabilities;
    limits = entRes.rows[0].limits || limits;
  }

  // Verify latest license has not been administratively REVOKED (CRITICAL-03 / REM-04)
  const licCheck = await runner.query(
    'SELECT license_id, status FROM licenses WHERE account_id = $1 ORDER BY expires_at DESC NULLS LAST, created_at DESC LIMIT 1 FOR UPDATE',
    [accountId]
  );
  if (licCheck.rows.length > 0 && licCheck.rows[0].status === 'REVOKED') {
    const err = new Error('License has been administratively revoked and cannot be reactivated without administrator clearance');
    // @ts-ignore
    err.status = 403;
    // @ts-ignore
    err.code = 'LICENSE_REVOKED';
    throw err;
  }

  // 1. Ensure subscription row exists and is ACTIVE
  const subCheck = await runner.query('SELECT subscription_id FROM subscriptions WHERE account_id = $1 ORDER BY current_period_end DESC, created_at DESC LIMIT 1', [accountId]);
  let subId;
  if (subCheck.rows.length > 0) {
    subId = subCheck.rows[0].subscription_id;
    // Expire any other active subscriptions for this account to preserve partial unique index
    await runner.query(
      `UPDATE subscriptions SET status = 'EXPIRED', updated_at = now() WHERE account_id = $1 AND status = 'ACTIVE' AND subscription_id != $2`,
      [accountId, subId]
    );
    await runner.query(
      `UPDATE subscriptions SET status = 'ACTIVE', plan_id = $1, current_period_end = now() + interval '${periodInterval}', updated_at = now() WHERE subscription_id = $2`,
      [canonicalPlanId, subId]
    );
  } else {
    // Expire any existing active subscription before insert
    await runner.query(
      `UPDATE subscriptions SET status = 'EXPIRED', updated_at = now() WHERE account_id = $1 AND status = 'ACTIVE'`,
      [accountId]
    );
    const subCode = providerSubId || `sub-${ref}`;
    subId = subCode;
    await runner.query(`
      INSERT INTO subscriptions (account_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, $3, 'ACTIVE', now(), now() + interval '${periodInterval}')
    `, [accountId, subCode, effectivePlanId]);
  }

  // 2. Ensure license row exists and is VALID
  let licenseKey = `lic-${accountId}`;
  let licenseExpiresAt = null;
  if (licCheck.rows.length > 0) {
    licenseKey = licCheck.rows[0].license_id || licenseKey;
    // Expire any other valid licenses for this account to preserve partial unique index
    await runner.query(
      `UPDATE licenses SET status = 'EXPIRED', updated_at = now() WHERE account_id = $1 AND status = 'VALID' AND license_id != $2`,
      [accountId, licenseKey]
    );
    const updLicRes = await runner.query(`
      UPDATE licenses 
      SET status = 'VALID', plan_id = $1, capabilities = $2, limits = $3, expires_at = now() + interval '${periodInterval}',
          license_revision = license_revision + 1, updated_at = now()
      WHERE license_id = $4 AND status != 'REVOKED'
      RETURNING expires_at
    `, [canonicalPlanId, JSON.stringify(capabilities), JSON.stringify(limits), licenseKey]);
    licenseExpiresAt = updLicRes.rows[0]?.expires_at || null;
  } else {
    // Expire any existing valid license before insert
    await runner.query(
      `UPDATE licenses SET status = 'EXPIRED', updated_at = now() WHERE account_id = $1 AND status = 'VALID'`,
      [accountId]
    );
    const insLicRes = await runner.query(`
      INSERT INTO licenses (account_id, plan_id, status, capabilities, limits, issued_at, expires_at, license_revision)
      VALUES ($1, $2, 'VALID', $3, $4, now(), now() + interval '${periodInterval}', 1)
      RETURNING license_id, expires_at
    `, [accountId, canonicalPlanId, JSON.stringify(capabilities), JSON.stringify(limits)]);
    licenseKey = insLicRes.rows[0]?.license_id || licenseKey;
    licenseExpiresAt = insLicRes.rows[0]?.expires_at || null;
  }

  // 3. Persist invoice record in invoices table (canonical id = inv-${txIdStr}, reference = ${ref})
  const majorAmount = Number(amount);
  const invId = `inv-${txIdStr}`;
  const taxRate = 0.075;
  const subtotal = Math.round((majorAmount / (1 + taxRate)) * 100) / 100;
  const taxAmount = Math.round((majorAmount - subtotal) * 100) / 100;
  const planNameResolved = normalizedPlanId.charAt(0).toUpperCase() + normalizedPlanId.slice(1).toLowerCase();

  try {
    await runner.query(`
      INSERT INTO invoices (
        id, account_id, reference, amount, currency, status, paid_at, receipt_url,
        subtotal, tax_amount, tax_rate, plan_name, billing_interval, currency_symbol
      )
      VALUES ($1, $2, $3, $4, 'NGN', 'Paid', now(), $5, $6, $7, $8, $9, $10, '₦')
    `, [invId, accountId, ref, majorAmount, receiptUrl || null, subtotal, taxAmount, taxRate, planNameResolved, interval]);
  } catch (invErr) {
    if (invErr && invErr.code === '23505') {
      const dupErr = new Error('Payment transaction reference has already been redeemed');
      // @ts-ignore
      dupErr.status = 409;
      // @ts-ignore
      dupErr.code = 'PAYMENT_ALREADY_REDEEMED';
      throw dupErr;
    }
    throw invErr;
  }

  // Broadcast to connected ACP / UI instances
  try {
    const { broadcast } = await import('../../websocket/server.mjs');
    broadcast('SUBSCRIPTION_STATUS_CHANGED', {
      subscriptionId: subId,
      accountId,
      subscription: {
        planId: normalizedPlanId,
        status: 'ACTIVE'
      },
      timestamp: new Date().toISOString()
    }, accountId);

    broadcast('LICENSE_UPDATED', {
      licenseKey,
      accountId,
      license: {
        planId: normalizedPlanId,
        status: 'VALID'
      },
      timestamp: new Date().toISOString()
    }, accountId);
  } catch (wsErr) {
    // Non-critical if websocket is not active
  }

  return {
    subscriptionId: subId,
    status: 'ACTIVE',
    planId: normalizedPlanId,
    licenseId: licenseKey,
    licenseStatus: 'VALID',
    expiresAt: licenseExpiresAt,
    capabilities,
    limits
  };
}
