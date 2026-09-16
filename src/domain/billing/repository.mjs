// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Find subscription and plan entitlements by account ID
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function findSubscriptionByAccount(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
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
  return res.rows[0] || null;
}

/**
 * Find invoices by account ID
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {number} [limit=20]
 * @returns {Promise<any[]>}
 */
export async function findInvoicesByAccount(client, accountId, limit = 20) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT id, reference, amount, currency, status, paid_at, receipt_url, created_at,
           subtotal, tax_amount, tax_rate, plan_name, billing_interval, currency_symbol
    FROM invoices
    WHERE account_id = $1
    ORDER BY created_at DESC LIMIT $2
  `, [accountId, limit]);
  return res.rows;
}

/**
 * Find latest payment authorization event from outbox
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function findLatestPaymentAuth(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT payload FROM outbox_events
    WHERE event_type = 'charge.success'
      AND (payload->'data'->'metadata'->>'account_id' = $1 OR payload->>'account_id' = $1)
    ORDER BY created_at DESC LIMIT 1
  `, [accountId]);
  return res.rows[0] || null;
}

/**
 * Cancel subscription renewal
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function cancelSubscriptionInDb(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    UPDATE subscriptions
    SET status = 'CANCELLED', cancelled_at = now(), updated_at = now()
    WHERE account_id = $1 AND status = 'ACTIVE'
    RETURNING current_period_end
  `, [accountId]);
  return res.rows[0] || null;
}

/**
 * Resume cancelled subscription
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function resumeSubscriptionInDb(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    UPDATE subscriptions
    SET status = 'ACTIVE', cancelled_at = null, updated_at = now()
    WHERE account_id = $1 AND status = 'CANCELLED'
    RETURNING current_period_end
  `, [accountId]);
  return res.rows[0] || null;
}

/**
 * Upsert invoice record
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {any} invoiceData
 * @returns {Promise<any>}
 */
export async function upsertInvoice(client, accountId, invoiceData) {
  const runner = client || getPool();
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

  const res = await runner.query(`
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
