// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch the authoritative SubscriptionPlansCatalog.
 * Conforms to Contract Section 12.1 #5 and Section 16.1.
 * Supports the 12-Point Backend Flexibility Verification (§16.3).
 * 
 * @returns {Promise<Object>}
 */
export async function getSubscriptionPlansCatalog() {
  const pool = getPool();
  const res = await pool.query(
    'SELECT * FROM subscription_plans WHERE is_active = true ORDER BY sort_order ASC, created_at ASC'
  );

  let defaultPlanId = 'pro';
  let annualDiscountPercent = 20;
  let taxRate = 0.0750;
  let currency = 'NGN';
  let currencySymbol = '₦';

  const plans = res.rows.map((row) => {
    if (row.is_popular) {
      defaultPlanId = row.plan_id;
    }
    annualDiscountPercent = Number(row.annual_discount_percent) || annualDiscountPercent;
    taxRate = Number(row.tax_rate) || taxRate;
    currency = row.currency || currency;
    currencySymbol = row.currency_symbol || currencySymbol;

    const monthlyPrice = Number(row.monthly_price);
    const annualPrice = Number(row.annual_price);

    return {
      id: row.plan_id,
      name: row.name,
      tagline: row.tagline,
      description: row.description,
      monthlyPrice,
      annualPrice,
      popular: Boolean(row.is_popular),
      pricing: {
        monthlyPrice,
        annualPrice,
        currency: row.currency,
        currencySymbol: row.currency_symbol
      },
      features: Array.isArray(row.features) ? row.features : [],
      entitlements: row.entitlements || {},
      availableBillingIntervals: ['Monthly', 'Annual']
    };
  });

  return {
    defaultPlanId,
    annualDiscountPercent,
    taxRate,
    currency,
    currencySymbol,
    plans
  };
}

/**
 * Fetch a single plan by its unique ID.
 * @param {string} planId 
 * @returns {Promise<Object|null>}
 */
export async function getPlanById(planId) {
  const pool = getPool();
  const res = await pool.query(
    'SELECT * FROM subscription_plans WHERE plan_id = $1',
    [planId.toLowerCase()]
  );
  if (res.rows.length === 0) return null;
  const row = res.rows[0];
  return {
    id: row.plan_id,
    name: row.name,
    tagline: row.tagline,
    description: row.description,
    monthlyPrice: Number(row.monthly_price),
    annualPrice: Number(row.annual_price),
    popular: Boolean(row.is_popular),
    currency: row.currency,
    currencySymbol: row.currency_symbol,
    annualDiscountPercent: Number(row.annual_discount_percent),
    taxRate: Number(row.tax_rate),
    features: row.features || [],
    entitlements: row.entitlements || {}
  };
}

/**
 * Upsert or update a plan in the catalog (Implements 12-point flexibility).
 * @param {Object} plan 
 * @returns {Promise<Object>}
 */
export async function upsertPlan(plan) {
  const pool = getPool();
  const planId = (plan.planId || plan.id || plan.plan_id || 'custom').toLowerCase();
  const name = plan.name || 'Custom Plan';
  const tagline = plan.tagline || '';
  const description = plan.description || '';
  const monthlyPrice = Number(plan.monthlyPrice ?? plan.monthly_price ?? 10000);
  const annualPrice = Number(plan.annualPrice ?? plan.annual_price ?? (monthlyPrice * 12 * 0.8));
  const currency = plan.currency || 'NGN';
  const currencySymbol = plan.currencySymbol || plan.currency_symbol || '₦';
  const annualDiscountPercent = Number(plan.annualDiscountPercent ?? plan.annual_discount_percent ?? 20);
  const taxRate = Number(plan.taxRate ?? plan.tax_rate ?? 0.0750);
  const isPopular = Boolean(plan.popular ?? plan.is_popular ?? false);
  const sortOrder = Number(plan.sortOrder ?? plan.sort_order ?? 99);
  const features = JSON.stringify(plan.features || []);
  const entitlements = JSON.stringify(plan.entitlements || {});

  const res = await pool.query(`
    INSERT INTO subscription_plans (
      plan_id, name, tagline, description, monthly_price, annual_price,
      currency, currency_symbol, annual_discount_percent, tax_rate,
      is_popular, is_active, sort_order, features, entitlements
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, true, $12, $13, $14)
    ON CONFLICT (plan_id) DO UPDATE SET
      name = EXCLUDED.name,
      tagline = EXCLUDED.tagline,
      description = EXCLUDED.description,
      monthly_price = EXCLUDED.monthly_price,
      annual_price = EXCLUDED.annual_price,
      currency = EXCLUDED.currency,
      currency_symbol = EXCLUDED.currency_symbol,
      annual_discount_percent = EXCLUDED.annual_discount_percent,
      tax_rate = EXCLUDED.tax_rate,
      is_popular = EXCLUDED.is_popular,
      sort_order = EXCLUDED.sort_order,
      features = EXCLUDED.features,
      entitlements = EXCLUDED.entitlements,
      updated_at = now()
    RETURNING *
  `, [
    planId, name, tagline, description, monthlyPrice, annualPrice,
    currency, currencySymbol, annualDiscountPercent, taxRate,
    isPopular, sortOrder, features, entitlements
  ]);

  return res.rows[0];
}

/**
 * Remove or deactivate a plan from the catalog.
 * @param {string} planId 
 * @returns {Promise<boolean>}
 */
export async function deletePlan(planId) {
  const pool = getPool();
  const res = await pool.query(
    'DELETE FROM subscription_plans WHERE plan_id = $1',
    [planId.toLowerCase()]
  );
  return (res.rowCount || 0) > 0;
}

export const upsertSubscriptionPlan = upsertPlan;
export const deleteSubscriptionPlan = deletePlan;
