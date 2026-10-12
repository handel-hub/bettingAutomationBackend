// @ts-check
import { setProvider } from '../../domain/payment/provider.mjs';
import { FlutterwaveAdapter } from './flutterwave-adapter.mjs';
import { Paystack } from 'paystack-sdk';
import crypto from 'crypto';

/**
 * Initializes the payment adapter.
 * Supports Flutterwave, Paystack, and Stub providers.
 * Backward compatible with initializePaymentAdapter(secretKey).
 * @param {string | Object} [providerOrSecretKey] 
 * @param {Object} [options]
 */
export function initializePaymentAdapter(providerOrSecretKey, options = {}) {
  let providerType = 'stub';
  let config = typeof providerOrSecretKey === 'object' && providerOrSecretKey !== null ? { ...providerOrSecretKey } : { ...options };

  if (typeof providerOrSecretKey === 'string') {
    if (providerOrSecretKey === 'flutterwave') {
      providerType = 'flutterwave';
    } else if (providerOrSecretKey === 'paystack' || providerOrSecretKey.startsWith('sk_')) {
      providerType = 'paystack';
      if (providerOrSecretKey.startsWith('sk_')) {
        config.secretKey = providerOrSecretKey;
      }
    } else if (providerOrSecretKey === 'stub') {
      providerType = 'stub';
    } else if (providerOrSecretKey.startsWith('FLWSECK_')) {
      providerType = 'flutterwave';
      config.secretKey = providerOrSecretKey;
    }
  } else if (config.PAYMENT_PROVIDER) {
    providerType = config.PAYMENT_PROVIDER;
  }

  // 1. Flutterwave Provider
  if (providerType === 'flutterwave') {
    console.log('Initializing Flutterwave payment provider');
    const flw = new FlutterwaveAdapter({
      secretKey: config.FLW_SECRET_KEY || config.secretKey,
      publicKey: config.FLW_PUBLIC_KEY || config.publicKey,
      encryptionKey: config.FLW_ENCRYPTION_KEY || config.FLW_SECRET_HASH || config.encryptionKey,
      webhookSecretHash: config.WEBHOOK_SECRET_HASH || config.FLW_WEBHOOK_SECRET_HASH || config.secretHash || config.FLW_SECRET_HASH || config.PAYMENT_WEBHOOK_SECRET,
      baseUrl: config.FLW_BASE_URL || config.baseUrl
    });
    setProvider(flw);
    return flw;
  }

  // 2. Paystack Provider
  const paystackSecret = config.PAYSTACK_SECRET_KEY || config.secretKey || (typeof providerOrSecretKey === 'string' && providerOrSecretKey.startsWith('sk_') ? providerOrSecretKey : null);
  if (providerType === 'paystack') {
    if (!paystackSecret || !paystackSecret.startsWith('sk_')) {
      const isTestStubAllowed = (config.NODE_ENV === 'test' || process.env.NODE_ENV === 'test') &&
        (config.ALLOW_TEST_PAYMENT_STUB === 'true' || process.env.ALLOW_TEST_PAYMENT_STUB === 'true');
      if (!isTestStubAllowed) {
        throw new Error('Paystack payment provider requires a valid PAYSTACK_SECRET_KEY starting with "sk_"');
      }
    } else {
      console.log('Initializing Paystack payment provider');
      const paystack = new Paystack(paystackSecret);

      const p = {
        async createCheckoutSession(accountId, planId, returnUrl, billingInterval = 'monthly') {
          let email = `${accountId}@bettingautomation.io`; 
          let amount = 1000000; // ₦10,000 in Kobo default
          const interval = (billingInterval || 'monthly').toLowerCase();
          
          try {
            const { findById } = await import('../../domain/account/repository.mjs');
            const acc = await findById(undefined, accountId);
            if (acc?.email) {
              email = acc.email;
            }
            
            const { getPool } = await import('../../persistence/connection.mjs');
            const pool = getPool();
            const spRes = await pool.query('SELECT monthly_price, annual_price FROM subscription_plans WHERE LOWER(plan_id) = LOWER($1)', [planId]);
            if (spRes.rows.length > 0) {
              const majorPrice = interval === 'annual' ? Number(spRes.rows[0].annual_price) : Number(spRes.rows[0].monthly_price);
              amount = Math.round(majorPrice * 100);
            } else {
              const planRes = await pool.query('SELECT limits FROM plan_entitlements WHERE plan_id = $1', [planId]);
              if (planRes.rows.length > 0 && planRes.rows[0].limits?.price) {
                amount = Math.round(Number(planRes.rows[0].limits.price) * 100);
              }
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
              plan_id: planId,
              billing_interval: interval
            }
          });
          
          if (!response.status) {
            throw new Error(`Paystack error: ${response.message}`);
          }
          
          return response.data.authorization_url;
        },
        async createSubscription(customerId, planId) {
          const response = await paystack.subscription.create({
            customer: customerId,
            plan: planId
          });
          if (!response.status) throw new Error(response.message);
          return { id: response.data.subscription_code };
        },
        async cancelSubscription(subscriptionId) {
          const response = await paystack.subscription.disable({
            code: subscriptionId,
            token: 'dummy_token'
          });
          return { id: subscriptionId, status: 'cancelled' };
        },
        async changeSubscriptionPlan(subscriptionId, newPlanId) {
          return { id: subscriptionId, plan: newPlanId };
        },
        verifyWebhookSignature(payload, signature) {
          if (!signature) return false;
          const hash = crypto.createHmac('sha512', paystackSecret).update(payload).digest('hex');
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
          return null;
        },
        async verifyTransaction(transactionIdOrRef) {
          const response = await paystack.transaction.verify({ reference: String(transactionIdOrRef) });
          if (!response.status) throw new Error(response.message);
          return response;
        }
      };
      setProvider(p);
      return p;
    }
  }

  // 3. Stub Provider Fallback — Strictly restricted to explicit test environment with ALLOW_TEST_PAYMENT_STUB=true
  const isTestStubAllowed = (config.NODE_ENV === 'test' || process.env.NODE_ENV === 'test') &&
    (config.ALLOW_TEST_PAYMENT_STUB === 'true' || process.env.ALLOW_TEST_PAYMENT_STUB === 'true');
  if (!isTestStubAllowed) {
    throw new Error('Payment provider "stub" is forbidden outside NODE_ENV=test with ALLOW_TEST_PAYMENT_STUB=true');
  }

  console.log('Initializing stub payment provider (TEST MODE)');
  const stub = {
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
    },
    async verifyTransaction(transactionIdOrRef) {
      return {
        status: 'success',
        data: {
          id: transactionIdOrRef,
          tx_ref: String(transactionIdOrRef),
          status: 'successful',
          amount: 100000,
          currency: 'NGN',
          meta: {
            plan_id: 'pro',
            billing_interval: 'monthly'
          }
        }
      };
    }
  };
  setProvider(stub);
  return stub;
}

