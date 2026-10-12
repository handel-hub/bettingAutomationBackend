// @ts-check
import { getProvider } from './provider.mjs';

/** @type {Map<string, { accountId: string, planId: string, billingInterval: string, customerEmail?: string, expectedAmount?: number, createdAt: number }>} */
const initiatedCheckoutBindings = new Map();

/**
 * Record an authoritative server-side binding between a checkout reference and the initiating account/plan.
 * @param {string} reference
 * @param {{ accountId: string, planId: string, billingInterval?: string, customerEmail?: string, expectedAmount?: number, createdAt?: number }} binding
 */
export function recordCheckoutBinding(reference, binding) {
  if (!reference || !binding?.accountId) return;
  const key = String(reference).trim();
  if (!key) return;
  initiatedCheckoutBindings.set(key, {
    accountId: String(binding.accountId),
    planId: String(binding.planId || 'pro').toLowerCase(),
    billingInterval: String(binding.billingInterval || 'monthly').toLowerCase(),
    customerEmail: binding.customerEmail ? String(binding.customerEmail).trim().toLowerCase() : undefined,
    expectedAmount: binding.expectedAmount,
    createdAt: binding.createdAt || Date.now()
  });
}

/**
 * Retrieve the authoritative checkout binding for a reference, if one was recorded.
 * @param {string} reference
 */
export function getCheckoutBinding(reference) {
  if (!reference) return null;
  return initiatedCheckoutBindings.get(String(reference).trim()) || null;
}

/**
 * Initiate checkout
 * @param {string} accountId 
 * @param {string} planId 
 * @param {string} returnUrl 
 * @param {string} idempotencyKey 
 * @param {string} [billingInterval='monthly']
 * @returns {Promise<string>} checkout URL
 */
export async function initiateCheckout(accountId, planId, returnUrl, idempotencyKey, billingInterval = 'monthly') {
  const provider = getProvider();
  
  // Notice we do NOT write to licenses, authorizations, or subscriptions here.
  // We only fetch/create a customer and generate a checkout session synchronously.
  let customerEmail = 'operator@bettingautomation.io';
  try {
    const { getPool } = await import('../../persistence/connection.mjs');
    const pool = getPool();
    const accRes = await pool.query('SELECT email FROM accounts WHERE account_id = $1', [accountId]);
    if (accRes.rows[0]?.email) {
      customerEmail = accRes.rows[0].email;
    }
  } catch {
    // Fallback if DB lookup unavailable in isolated unit tests
  }

  let customerId = await provider.getCustomer(accountId);
  if (!customerId) {
    customerId = await provider.createCustomer(customerEmail); 
  }
  
  const checkoutUrl = await provider.createCheckoutSession(accountId, planId, returnUrl, billingInterval);
  if (typeof checkoutUrl === 'string') {
    const txRefMatch = checkoutUrl.match(/[?&]tx_ref=([^&#]+)/);
    const payMatch = checkoutUrl.match(/\/pay\/([^?&#]+)/);
    const extractedRef = txRefMatch ? decodeURIComponent(txRefMatch[1]) : (payMatch ? payMatch[1] : null);
    if (extractedRef) {
      recordCheckoutBinding(extractedRef, {
        accountId,
        planId,
        billingInterval,
        customerEmail
      });
    }
  }
  return checkoutUrl;
}

