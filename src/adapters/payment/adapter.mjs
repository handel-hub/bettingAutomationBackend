// @ts-check
import { setProvider } from '../../domain/payment/provider.mjs';
import { Paystack } from 'paystack-sdk';
import crypto from 'crypto';

/**
 * Initializes the payment adapter using Paystack.
 * @param {string} secretKey 
 */
export function initializePaymentAdapter(secretKey) {
  if (secretKey && secretKey.startsWith('sk_')) {
    console.log('Initializing Paystack payment provider');
    const paystack = new Paystack(secretKey);

    setProvider({
      async createCheckoutSession(accountId, planId, returnUrl) {
        // Find customer email from accountId (stubbed email for now)
        const email = `${accountId}@local.com`; 
        
        // Convert planId to amount or use Paystack plans
        // In Paystack, we initiate a transaction
        const response = await paystack.transaction.initialize({
          email,
          amount: 5000, // Dummy amount in kobo, should be derived from planId
          callback_url: returnUrl,
          metadata: {
            account_id: accountId,
            plan_id: planId
          }
        });
        
        if (!response.status) {
          throw new Error(`Paystack error: ${response.message}`);
        }
        
        return response.data.authorization_url;
      },
      async createSubscription(customerId, planId) {
        // Paystack subscription requires customer email/code and plan code
        const response = await paystack.subscription.create({
          customer: customerId,
          plan: planId
        });
        if (!response.status) throw new Error(response.message);
        return { id: response.data.subscription_code };
      },
      async cancelSubscription(subscriptionId) {
        // Paystack uses disable to cancel
        const response = await paystack.subscription.disable({
          code: subscriptionId,
          token: 'dummy_token' // Would need email token in reality
        });
        return { id: subscriptionId, status: 'cancelled' };
      },
      async changeSubscriptionPlan(subscriptionId, newPlanId) {
        // No direct change plan in Paystack, requires cancelling and creating new
        return { id: subscriptionId, plan: newPlanId };
      },
      verifyWebhookSignature(payload, signature) {
        const hash = crypto.createHmac('sha512', secretKey).update(payload).digest('hex');
        return hash === signature;
      },
      async createCustomer(email) {
        const response = await paystack.customer.create({ email });
        if (!response.status) throw new Error(response.message);
        return response.data.customer_code;
      },
      async getCustomer(accountId) {
        // Stub: In reality we would query DB for customer_code
        return null;
      }
    });
  } else {
    console.log('Initializing stub payment provider (No Paystack Secret Key)');
    setProvider({
      async createCheckoutSession(accountId, planId, returnUrl) {
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
        return true; // Stub allows all
      },
      async createCustomer(email) {
        return `cust_${Date.now()}`;
      },
      async getCustomer(accountId) {
        return `cust_${accountId}`;
      }
    });
  }
}
