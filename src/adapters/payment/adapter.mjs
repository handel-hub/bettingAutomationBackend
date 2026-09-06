// @ts-check
import { getProvider, setProvider } from '../../domain/payment/provider.mjs';

/**
 * Initializes the payment adapter.
 */
export function initializePaymentAdapter(secretKey) {
  setProvider({
    async createCheckoutSession(accountId, planId, returnUrl) {
      // Stub: in reality, call paystack/stripe
      return `https://checkout.provider.com/${planId}?account=${accountId}`;
    },
    async createSubscription(customerId, planId) {
      return { id: `sub_${Date.now()}` };
    },
    async cancelSubscription(subscriptionId) {
      return { id: subscriptionId, status: 'cancelled' };
    },
    async changeSubscriptionPlan(subscriptionId, newPlanId) {
      return { id: subscriptionId, plan: newPlanId };
    },
    verifyWebhookSignature(payload, signature) {
      // Stub: verify signature against secret
      return signature === 'valid_signature';
    },
    async createCustomer(email) {
      return `cust_${Date.now()}`;
    },
    async getCustomer(accountId) {
      return `cust_${accountId}`;
    }
  });
}
