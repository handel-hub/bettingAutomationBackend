-- Migration 007: Active Subscription & Valid License Partial Unique Constraints (CAN-21 / DEF-21)

-- 1. Deduplicate any pre-existing ACTIVE subscriptions, keeping only the latest one per account
UPDATE subscriptions s1
SET status = 'EXPIRED', updated_at = now()
WHERE s1.status = 'ACTIVE'
  AND s1.subscription_id NOT IN (
    SELECT s2.subscription_id
    FROM (
      SELECT DISTINCT ON (account_id) subscription_id
      FROM subscriptions
      WHERE status = 'ACTIVE'
      ORDER BY account_id, current_period_end DESC, created_at DESC
    ) s2
  );

-- 2. Deduplicate any pre-existing VALID licenses, keeping only the latest one per account
UPDATE licenses l1
SET status = 'EXPIRED', updated_at = now()
WHERE l1.status = 'VALID'
  AND l1.license_id NOT IN (
    SELECT l2.license_id
    FROM (
      SELECT DISTINCT ON (account_id) license_id
      FROM licenses
      WHERE status = 'VALID'
      ORDER BY account_id, expires_at DESC NULLS LAST, created_at DESC
    ) l2
  );

-- 3. Create partial unique indices to guarantee single active subscription and single valid license per account
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_account_active ON subscriptions(account_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX IF NOT EXISTS idx_licenses_account_valid ON licenses(account_id) WHERE status = 'VALID';
