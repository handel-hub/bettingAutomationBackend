// @ts-check
import {
  findSubscriptionByAccount,
  findInvoicesByAccount,
  findLatestPaymentAuth,
  cancelSubscriptionInDb,
  resumeSubscriptionInDb,
  upsertInvoice
} from './repository.mjs';

/**
 * Fetch BillingSnapshot for the operator.
 * Aggregates active subscription, payment method, notices, and persisted invoices.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getBillingSnapshot(accountId) {
  // 1. Fetch Subscription, Entitlements & Subscription Plan catalog metadata
  const sub = await findSubscriptionByAccount(undefined, accountId);

  const planPrice = sub?.monthly_price ? Number(sub.monthly_price) : (sub?.limits?.price || 10000);
  const billingInterval = sub?.limits?.interval || 'Monthly';
  const planName = sub?.sp_name || (sub?.plan_id ? (sub.plan_id.charAt(0).toUpperCase() + sub.plan_id.slice(1).toLowerCase()) : 'Pro');
  const currentPlanId = sub?.plan_id ? sub.plan_id.toLowerCase() : 'pro';

  // 2. Fetch Invoices with statutory tax and fiscal breakdown
  const invRows = await findInvoicesByAccount(undefined, accountId, 20);

  const invoices = invRows.map(r => {
    const gross = Number(r.amount);
    const taxRate = r.tax_rate !== null && r.tax_rate !== undefined ? Number(r.tax_rate) : 0.075;
    const subtotal = r.subtotal !== null && r.subtotal !== undefined ? Number(r.subtotal) : Math.round((gross / (1 + taxRate)) * 100) / 100;
    const taxAmount = r.tax_amount !== null && r.tax_amount !== undefined ? Number(r.tax_amount) : Math.round((gross - subtotal) * 100) / 100;
    return {
      id: r.id,
      reference: r.reference,
      date: r.paid_at || r.created_at,
      amount: gross,
      subtotal,
      taxAmount,
      taxRate,
      planName: r.plan_name || planName,
      billingInterval: r.billing_interval || billingInterval,
      currency: r.currency || 'NGN',
      currencySymbol: r.currency_symbol || '₦',
      status: r.status,
      receiptUrl: r.receipt_url
    };
  });

  // 3. Fetch latest payment event to infer card info if available
  const latestPayEvent = await findLatestPaymentAuth(undefined, accountId);

  let paymentMethod = null;
  if (latestPayEvent) {
    const authData = latestPayEvent.payload?.data?.authorization;
    if (authData) {
      paymentMethod = {
        cardBrand: authData.brand || authData.card_type || 'Mastercard',
        last4: authData.last4 || '4081',
        expMonth: authData.exp_month || '12',
        expYear: authData.exp_year || '2028'
      };
    }
  }

  // Determine available actions
  /** @type {('UPDATE_PAYMENT' | 'CANCEL_SUBSCRIPTION' | 'RESUME_SUBSCRIPTION' | 'CONTACT_SUPPORT')[]} */
  const availableActions = ['UPDATE_PAYMENT', 'CONTACT_SUPPORT'];
  if (sub?.status === 'ACTIVE') {
    availableActions.push('CANCEL_SUBSCRIPTION');
  } else if (sub?.status === 'CANCELLED') {
    availableActions.push('RESUME_SUBSCRIPTION');
  }

  const notices = [];
  if (sub?.sp_notices && Array.isArray(sub.sp_notices)) {
    notices.push(...sub.sp_notices);
  }
  if (sub?.status === 'PAST_DUE') {
    notices.push('Your latest subscription charge failed. Please update your payment method.');
  }

  return {
    currentPlan: planName,
    currentPlanId,
    price: planPrice,
    currency: 'NGN',
    currencySymbol: '₦',
    status: sub ? (sub.status === 'ACTIVE' ? 'Active' : (sub.status === 'PAST_DUE' ? 'Past_Due' : 'Cancelled')) : 'Payment_Required',
    billingInterval,
    renewalDate: sub?.status === 'ACTIVE' ? sub.current_period_end : null,
    expirationDate: sub?.current_period_end || null,
    availableActions,
    notices,
    paymentMethod,
    invoices,
    invoiceSummary: {
      totalCount: invoices.length,
      paidCount: invoices.filter(i => i.status === 'Paid').length
    }
  };
}

/**
 * Cancel auto-renewal of subscription at period end.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function cancelSubscription(accountId) {
  const row = await cancelSubscriptionInDb(undefined, accountId);

  return {
    status: 'Cancelled',
    expirationDate: row?.current_period_end || new Date(Date.now() + 30 * 86400000).toISOString()
  };
}

/**
 * Resume auto-renewal of cancelled subscription.
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function resumeSubscription(accountId) {
  const row = await resumeSubscriptionInDb(undefined, accountId);

  return {
    status: 'Active',
    renewalDate: row?.current_period_end || new Date(Date.now() + 30 * 86400000).toISOString()
  };
}

/**
 * Create a persistent invoice record in database with statutory VAT fields
 * @param {string} accountId 
 * @param {Object} invoiceData 
 * @returns {Promise<Object>}
 */
export async function createInvoice(accountId, invoiceData) {
  return upsertInvoice(undefined, accountId, invoiceData);
}
