// @ts-check

/**
 * @typedef {Object} PaymentProvider
 * @property {(accountId: string, planId: string, returnUrl: string) => Promise<string>} createCheckoutSession
 * @property {(customerId: string, planId: string) => Promise<any>} createSubscription
 * @property {(subscriptionId: string) => Promise<any>} cancelSubscription
 * @property {(subscriptionId: string, newPlanId: string) => Promise<any>} changeSubscriptionPlan
 * @property {(payload: string, signature: string) => boolean} verifyWebhookSignature
 * @property {(email: string) => Promise<string>} createCustomer
 * @property {(accountId: string) => Promise<string | null>} getCustomer
 * @property {(transactionIdOrRef: string | number) => Promise<any>} [verifyTransaction]
 */

/** @type {PaymentProvider} */
let provider = null;

export function setProvider(p) {
  provider = p;
}

export function getProvider() {
  if (!provider) throw new Error('Payment provider not configured');
  return provider;
}
