// @ts-check
import { getPool } from './connection.mjs';
import { hashPassword, sha256 } from '../crypto/hashing.mjs';

/**
 * Idempotently provisions default developer accounts and subscriptions on startup.
 * Strictly forbidden in production environments.
 * 
 * Invariants:
 * - Uses ON CONFLICT DO NOTHING to ensure existing bans/lockouts are never overwritten.
 * - Multi-gated: Throws immediately if NODE_ENV === 'production'.
 */
export async function bootstrapDevAccounts() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[Security] bootstrapDevAccounts is strictly forbidden in production mode.');
  }

  const pool = getPool();
  const client = await pool.connect();

  try {
    const genesisHash = sha256('GENESIS');
    const defaultPassword = 'Password123!';
    const passwordHash = await hashPassword(defaultPassword);

    const accountsToBootstrap = [
      {
        email: 'operator@bettingautomation.io',
        name: 'Control Plane Operator',
        planId: 'pro',
        subscriptionId: 'sub_operator_pro',
        licenseId: 'lic_operator_default'
      },
      {
        email: 'tester@bettingautomation.com',
        name: 'Automated Test Operator',
        planId: 'pro',
        subscriptionId: 'sub_tester_pro',
        licenseId: 'lic_tester_default'
      }
    ];

    // 1. Ensure 'pro' plan entitlements exist
    await client.query(`
      INSERT INTO plan_entitlements (plan_id, capabilities, limits)
      VALUES (
        'pro',
        '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD", "CAP_TACTICAL_BET", "CAP_CASH_OUT"]'::jsonb,
        '{"max_machines": 5, "max_concurrent_browsers": 6, "risk_tier": "LOW", "price": 10000, "interval": "Monthly"}'::jsonb
      )
      ON CONFLICT (plan_id) DO NOTHING;
    `);

    for (const item of accountsToBootstrap) {
      // 2. Insert account non-destructively (never overwrite status if already exists)
      const insRes = await client.query(`
        INSERT INTO accounts (email, credentials_hash, status, lockout_count, last_event_hash)
        VALUES ($1, $2, 'ACTIVE', 0, $3)
        ON CONFLICT (email) DO NOTHING
        RETURNING account_id;
      `, [item.email, passwordHash, genesisHash]);

      let accountId = insRes.rows[0]?.account_id;
      if (!accountId) {
        const lookup = await client.query('SELECT account_id FROM accounts WHERE email = $1', [item.email]);
        accountId = lookup.rows[0]?.account_id;
      }

      if (!accountId) continue;

      // 3. Initialize generation states non-destructively
      await client.query(`
        INSERT INTO account_generation_states (account_id, license_revision)
        VALUES ($1, 1)
        ON CONFLICT (account_id) DO NOTHING;
      `, [accountId]);

      // 4. Initialize operator settings non-destructively
      await client.query(`
        INSERT INTO operator_settings (account_id, name)
        VALUES ($1, $2)
        ON CONFLICT (account_id) DO NOTHING;
      `, [accountId, item.name]);

      // 5. Ensure valid active license exists
      const licCheck = await client.query(`
        SELECT license_id FROM licenses 
        WHERE account_id = $1 AND status = 'VALID' AND (expires_at IS NULL OR expires_at > now())
        LIMIT 1;
      `, [accountId]);

      if (licCheck.rows.length === 0) {
        await client.query(`
          INSERT INTO licenses (
            account_id, plan_id, status, capabilities, limits, 
            license_revision, expires_at, keygen_license_id
          )
          VALUES (
            $1, $2, 'VALID',
            '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD", "CAP_TACTICAL_BET", "CAP_CASH_OUT"]'::jsonb,
            '{"max_machines": 5, "max_concurrent_browsers": 6, "risk_tier": "LOW"}'::jsonb,
            1, now() + interval '365 days', $3
          );
        `, [accountId, item.planId, item.licenseId]);
      }

      // 6. Ensure active subscription exists
      await client.query(`
        INSERT INTO subscriptions (
          account_id, provider_subscription_id, plan_id, 
          status, current_period_start, current_period_end
        )
        VALUES (
          $1, $2, $3,
          'ACTIVE', now(), now() + interval '365 days'
        )
        ON CONFLICT (provider_subscription_id) DO NOTHING;
      `, [accountId, item.subscriptionId, item.planId]);
    }
  } catch (err) {
    console.error('[Bootstrap] Error during bootstrapDevAccounts:', err);
  } finally {
    client.release();
  }
}
