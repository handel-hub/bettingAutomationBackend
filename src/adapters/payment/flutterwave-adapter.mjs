// @ts-check
import crypto, { randomUUID } from 'crypto';

/**
 * Flutterwave v3 Payment Adapter
 */
export class FlutterwaveAdapter {
  /**
   * @param {Object} [config]
   * @param {string} [config.secretKey] - API Secret Key (e.g. FLWSECK_TEST-...)
   * @param {string} [config.publicKey] - API Public Key (e.g. FLWPUBK_TEST-...)
   * @param {string} [config.encryptionKey] - API Encryption Key / Secret Hash (e.g. FLWSECK_TEST12abc6fdcf9b)
   * @param {string} [config.webhookSecretHash] - Webhook Secret Hash for verif-hash (e.g. 2BEx@5@9$TiK!be)
   * @param {string} [config.secretHash] - Alias for webhookSecretHash
   * @param {string} [config.baseUrl]
   */
  constructor(config = {}) {
    this.secretKey = config.secretKey || process.env.FLW_SECRET_KEY || '';
    this.publicKey = config.publicKey || process.env.FLW_PUBLIC_KEY || '';
    
    // API Encryption Key (from API Keys tab for 3DES payload encryption)
    this.encryptionKey = config.encryptionKey || config.FLW_ENCRYPTION_KEY || process.env.FLW_ENCRYPTION_KEY || process.env.FLW_SECRET_HASH || '';

    // Webhook Secret Hash (from Webhooks tab for verif-hash verification)
    this.webhookSecretHash = (
      config.webhookSecretHash ||
      config.WEBHOOK_SECRET_HASH ||
      config.FLW_WEBHOOK_SECRET_HASH ||
      config.secretHash ||
      process.env.WEBHOOK_SECRET_HASH ||
      process.env.FLW_WEBHOOK_SECRET_HASH ||
      config.FLW_SECRET_HASH ||
      process.env.FLW_SECRET_HASH ||
      ''
    );
    // Backward-compatible alias
    this.secretHash = this.webhookSecretHash;

    this.baseUrl = config.baseUrl || 'https://api.flutterwave.com/v3';
  }

  /**
   * Create a checkout session (Standard Hosted Payment Link)
   * @param {string} accountId 
   * @param {string} planId 
   * @param {string} returnUrl 
   * @param {string} [billingInterval='monthly']
   * @returns {Promise<string>} Checkout hosted link
   */
  async createCheckoutSession(accountId, planId, returnUrl, billingInterval = 'monthly') {
    let email = `${accountId}@bettingautomation.io`;
    let amount = 10000; // Default ₦10,000 in major units (NGN)

    try {
      const { findById } = await import('../../domain/account/repository.mjs');
      const acc = await findById(undefined, accountId);
      if (acc?.email) {
        email = acc.email;
      }

      const { getPool } = await import('../../persistence/connection.mjs');
      const pool = getPool();
      const planRes = await pool.query('SELECT monthly_price, annual_price FROM subscription_plans WHERE LOWER(plan_id) = LOWER($1)', [planId]);
      if (planRes.rows.length > 0) {
        amount = billingInterval === 'annual' ? Number(planRes.rows[0].annual_price) : Number(planRes.rows[0].monthly_price);
      } else {
        const entRes = await pool.query('SELECT limits FROM plan_entitlements WHERE plan_id = $1', [planId]);
        if (entRes.rows.length > 0 && entRes.rows[0].limits?.price) {
          amount = Number(entRes.rows[0].limits.price);
        }
      }
    } catch {
      // Fallback to defaults
    }

    const txRef = `flw_${accountId}_${planId}_${Date.now()}`;

    // If mock key or explicitly instructed to mock, return deterministic hosted mock link
    if (
      !this.secretKey ||
      this.secretKey.includes('mock') ||
      process.env.FLW_MOCK === 'true'
    ) {
      return `https://checkout.flutterwave.com/v3/hosted/pay/${txRef}?account=${accountId}&plan=${planId}&amount=${amount}`;
    }

    const payload = {
      tx_ref: txRef,
      amount,
      currency: 'NGN',
      redirect_url: returnUrl,
      meta: {
        account_id: accountId,
        plan_id: planId,
        billing_interval: billingInterval
      },
      customer: {
        email
      },
      customizations: {
        title: 'Betting Automation Subscription'
      }
    };

    const res = await fetch(`${this.baseUrl}/payments`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Flutterwave payments API error HTTP_${res.status}: ${errText}`);
    }

    const data = await res.json();
    if (data.status !== 'success' || !data.data?.link) {
      throw new Error(`Flutterwave payment initialization failed: ${data.message || 'Unknown error'}`);
    }

    return data.data.link;
  }

  /**
   * Verify webhook secret hash.
   * Flutterwave sends the configured secret hash in the `verif-hash` HTTP header.
   * We hash both with SHA-256 before timingSafeEqual to guarantee equal length and avoid RangeError.
   * @param {string | Buffer} payload 
   * @param {string} signature 
   * @returns {boolean}
   */
  verifyWebhookSignature(payload, signature) {
    if (!signature || !this.secretHash) {
      return false;
    }

    // 1. Basic Verification via verif-hash (Secret Hash match in constant time)
    const sigHash = crypto.createHash('sha256').update(String(signature).trim()).digest();
    const expectedHash = crypto.createHash('sha256').update(String(this.secretHash).trim()).digest();

    if (crypto.timingSafeEqual(sigHash, expectedHash)) {
      return true;
    }

    // 2. Advanced Verification via flutterwave-signature (HMAC-SHA256)
    try {
      const raw = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
      const hmacBase64 = crypto.createHmac('sha256', this.secretHash).update(raw).digest('base64');
      const hmacHex = crypto.createHmac('sha256', this.secretHash).update(raw).digest('hex');

      const hmacBase64Buf = crypto.createHash('sha256').update(hmacBase64).digest();
      const hmacHexBuf = crypto.createHash('sha256').update(hmacHex).digest();

      if (crypto.timingSafeEqual(sigHash, hmacBase64Buf) || crypto.timingSafeEqual(sigHash, hmacHexBuf)) {
        return true;
      }
    } catch {
      // Fallback
    }

    return false;
  }

  /**
   * Verify a transaction on Flutterwave v3
   * Supports both numeric transaction IDs (GET /v3/transactions/:id/verify)
   * and string transaction references (GET /v3/transactions/verify_by_reference?tx_ref=:ref).
   * @param {string | number} transactionIdOrRef 
   * @returns {Promise<any>}
   */
  async verifyTransaction(transactionIdOrRef) {
    if (
      !this.secretKey ||
      this.secretKey.includes('mock') ||
      process.env.FLW_MOCK === 'true'
    ) {
      return {
        status: 'success',
        data: {
          id: transactionIdOrRef,
          tx_ref: String(transactionIdOrRef),
          status: 'successful',
          amount: 10000,
          currency: 'NGN'
        }
      };
    }

    const paramStr = String(transactionIdOrRef).trim();
    const isReference = isNaN(Number(paramStr)) || paramStr.startsWith('flw_') || paramStr.startsWith('FLW');
    const verifyUrl = isReference
      ? `${this.baseUrl}/transactions/verify_by_reference?tx_ref=${encodeURIComponent(paramStr)}`
      : `${this.baseUrl}/transactions/${paramStr}/verify`;

    const res = await fetch(verifyUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Flutterwave verify API error HTTP_${res.status}: ${errText}`);
    }

    return res.json();
  }

  /**
   * @param {string} email 
   */
  async createCustomer(email) {
    return `flw_cust_${Date.now()}`;
  }

  /**
   * @param {string} accountId 
   */
  async getCustomer(accountId) {
    return null;
  }

  /**
   * @param {string} customerId 
   * @param {string} planId 
   */
  async createSubscription(customerId, planId) {
    return { id: `flw_sub_${Date.now()}` };
  }

  /**
   * @param {string} subscriptionId 
   */
  async cancelSubscription(subscriptionId) {
    return { id: subscriptionId, status: 'cancelled' };
  }

  /**
   * @param {string} subscriptionId 
   * @param {string} newPlanId 
   */
  async changeSubscriptionPlan(subscriptionId, newPlanId) {
    return { id: subscriptionId, plan: newPlanId };
  }
}
