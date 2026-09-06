// @ts-check
import { getProvider } from './provider.mjs';

/**
 * Initiate checkout
 * @param {string} accountId 
 * @param {string} planId 
 * @param {string} returnUrl 
 * @param {string} idempotencyKey 
 * @returns {Promise<string>} checkout URL
 */
export async function initiateCheckout(accountId, planId, returnUrl, idempotencyKey) {
  const provider = getProvider();
  
  // Notice we do NOT write to licenses, authorizations, or subscriptions here.
  // We only fetch/create a customer and generate a checkout session synchronously.
  let customerId = await provider.getCustomer(accountId);
  if (!customerId) {
    // We would need the email here if creating a customer, assume we fetch it
    customerId = await provider.createCustomer('dummy@example.com'); 
  }
  
  const checkoutUrl = await provider.createCheckoutSession(accountId, planId, returnUrl);
  return checkoutUrl;
}
