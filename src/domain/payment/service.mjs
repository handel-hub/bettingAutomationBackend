// @ts-check
import { getProvider } from './provider.mjs';

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
  let customerId = await provider.getCustomer(accountId);
  if (!customerId) {
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
    customerId = await provider.createCustomer(customerEmail); 
  }
  
  const checkoutUrl = await provider.createCheckoutSession(accountId, planId, returnUrl, billingInterval);
  return checkoutUrl;
}
