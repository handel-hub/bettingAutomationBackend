// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch BillingSnapshot for the operator.
 * Aggregates active subscription, payment method, notices, and persisted invoices.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getBillingSnapshot(accountId) {
  const pool = getPool();

  // 1. Fetch Subscription, Entitlements & Subscription Plan catalog metadata
  const subRes = await pool.query(`
    SELECT s.subscription_id, s.provider_subscription_id, s.plan_id, s.status,
           s.current_period_start, s.current_period_end, s.cancelled_at,
           pe.limits,
           sp.name as sp_name, sp.tagline, sp.description, sp.monthly_price, sp.annual_price,
           sp.features as sp_features
    FROM subscriptions s
    LEFT JOIN plan_entitlements pe ON s.plan_id = pe.plan_id
    LEFT JOIN subscription_plans sp ON LOWER(s.plan_id) = LOWER(sp.plan_id)
    WHERE s.account_id = $1
    ORDER BY s.created_at DESC LIMIT 1
  `, [accountId]);

  const sub = subRes.rows[0];
  const planPrice = sub?.monthly_price ? Number(sub.monthly_price) : (sub?.limits?.price || 10000);
  const billingInterval = sub?.limits?.interval || 'Monthly';
  const planName = sub?.sp_name || (sub?.plan_id ? (sub.plan_id.charAt(0).toUpperCase() + sub.plan_id.slice(1).toLowerCase()) : 'Pro');
  const currentPlanId = sub?.plan_id ? sub.plan_id.toLowerCase() : 'pro';

  // 2. Fetch Invoices with statutory tax and fiscal breakdown
  const invRes = await pool.query(`
    SELECT id, reference, amount, currency, status, paid_at, receipt_url, created_at,
           subtotal, tax_amount, tax_rate, plan_name, billing_interval, currency_symbol
    FROM invoices
    WHERE account_id = $1
    ORDER BY created_at DESC LIMIT 20
  `, [accountId]);

  const invoices = invRes.rows.map(r => {
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
  const payEventRes = await pool.query(`
    SELECT payload FROM outbox_events
    WHERE event_type = 'charge.success'
      AND (payload->'data'->'metadata'->>'account_id' = $1 OR payload->>'account_id' = $1)
    ORDER BY created_at DESC LIMIT 1
  `, [accountId]);

  let paymentMethod = null;
  if (payEventRes.rows.length > 0) {
    const authData = payEventRes.rows[0].payload?.data?.authorization;
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
    status: sub ? (sub.status === 'ACTIVE' ? 'Active' : (sub.status === 'PAST_DUE' ? 'Past_Due' : 'Cancelled')) : 'Payment_Required',
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
  const pool = getPool();
  const res = await pool.query(`
    UPDATE subscriptions
    SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
    WHERE account_id = $1 AND status = 'ACTIVE'
    RETURNING current_period_end
  `, [accountId]);

  return {
    status: 'Cancelled',
    expirationDate: res.rows[0]?.current_period_end || new Date(Date.now() + 30 * 86400000).toISOString()
  };
}

/**
 * Resume auto-renewal of cancelled subscription.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function resumeSubscription(accountId) {
  const pool = getPool();
  const res = await pool.query(`
    UPDATE subscriptions
    SET status = 'ACTIVE', cancelled_at = null, updated_at = now()
    WHERE account_id = $1 AND status = 'CANCELLED'
    RETURNING current_period_end
  `, [accountId]);

  return {
    status: 'Active',
    renewalDate: res.rows[0]?.current_period_end || new Date(Date.now() + 30 * 86400000).toISOString()
  };
}

/**
 * Create a persistent invoice record in database with statutory VAT fields
 * @param {string} accountId 
 * @param {Object} invoiceData 
 * @returns {Promise<Object>}
 */
export async function createInvoice(accountId, invoiceData) {
  const pool = getPool();
  const {
    id,
    reference,
    amount,
    currency = 'NGN',
    status = 'Paid',
    paidAt,
    receiptUrl,
    subtotal,
    taxAmount,
    taxRate = 0.075,
    planName,
    billingInterval,
    currencySymbol = '₦'
  } = invoiceData;

  const gross = Number(amount);
  const rate = Number(taxRate);
  const calcSubtotal = subtotal !== undefined ? Number(subtotal) : Math.round((gross / (1 + rate)) * 100) / 100;
  const calcTax = taxAmount !== undefined ? Number(taxAmount) : Math.round((gross - calcSubtotal) * 100) / 100;

  const res = await pool.query(`
    INSERT INTO invoices (
      id, account_id, reference, amount, currency, status, paid_at, receipt_url,
      subtotal, tax_amount, tax_rate, plan_name, billing_interval, currency_symbol
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    ON CONFLICT (id) DO UPDATE SET
      status = EXCLUDED.status,
      paid_at = EXCLUDED.paid_at,
      receipt_url = EXCLUDED.receipt_url,
      subtotal = EXCLUDED.subtotal,
      tax_amount = EXCLUDED.tax_amount,
      tax_rate = EXCLUDED.tax_rate,
      plan_name = EXCLUDED.plan_name,
      billing_interval = EXCLUDED.billing_interval,
      currency_symbol = EXCLUDED.currency_symbol
    RETURNING *
  `, [
    id, accountId, reference, gross, currency, status, paidAt || new Date(), receiptUrl || null,
    calcSubtotal, calcTax, rate, planName || null, billingInterval || null, currencySymbol
  ]);

  return res.rows[0];
}
