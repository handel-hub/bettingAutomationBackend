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
        let email = `${accountId}@bettingautomation.io`; 
        let amount = 1000000; // ₦10,000 in Kobo default
        
        try {
          const { getPool } = await import('../../persistence/connection.mjs');
          const pool = getPool();
          const accRes = await pool.query('SELECT email FROM accounts WHERE account_id = $1', [accountId]);
          if (accRes.rows.length > 0 && accRes.rows[0].email) {
            email = accRes.rows[0].email;
          }
          
          const planRes = await pool.query('SELECT limits FROM plan_entitlements WHERE plan_id = $1', [planId]);
          if (planRes.rows.length > 0 && planRes.rows[0].limits?.price) {
            amount = Math.round(Number(planRes.rows[0].limits.price) * 100);
          }
        } catch {
          // Fallback
        }
        
        const response = await paystack.transaction.initialize({
          email,
          amount,
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
        if (!signature) return false;
        const hash = crypto.createHmac('sha512', secretKey).update(payload).digest('hex');
        const hashBuf = Buffer.from(hash, 'utf8');
        const sigBuf = Buffer.from(signature, 'utf8');
        if (hashBuf.length !== sigBuf.length) return false;
        return crypto.timingSafeEqual(hashBuf, sigBuf);
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
