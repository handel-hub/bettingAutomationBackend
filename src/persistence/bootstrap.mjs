// @ts-check
import { getPool } from './connection.mjs';
import { hashPassword, sha256 } from '../crypto/hashing.mjs';
import { getKmsAdapter } from '../crypto/kms-adapter.mjs';

const PRO_CAPABILITIES = [
  'CAP_AUTOMATION_START',
  'CAP_AUTOMATION_STOP',
  'CAP_BROWSER_ALLOCATE',
  'CAP_FILE_UPLOAD',
  'CAP_FILE_DOWNLOAD',
  'CAP_CONFIG_MODIFY',
  'CAP_UPDATE_INSTALL',
  'CAP_TACTICAL_BET',
  'CAP_CASH_OUT'
];

/**
 * Idempotently provisions test operator accounts, subscriptions, licenses, and KMS key.
 * Strictly forbidden in production environments unless ALLOW_TEST_PROVISIONING === 'true'.
 * 
 * @param {Object} [options]
 * @param {string} [options.scenario='all']
 * @returns {Promise<{ publicKeyHex: string, accounts: string[] }>}
 */
export async function bootstrapDevAccounts(options = {}) {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_TEST_PROVISIONING !== 'true') {
    throw new Error('[Security] bootstrapDevAccounts is strictly forbidden in production mode.');
  }

  const kmsAdapter = getKmsAdapter();
  const publicKeyHex = await kmsAdapter.initialize();

  const pool = getPool();
  const client = await pool.connect();
  const provisionedEmails = [];

  try {
    const genesisHash = sha256('GENESIS');
    const legacyPasswordHash = await hashPassword('Password123!');
    const canonicalPasswordHash = await hashPassword('OperatorPass123!');

    const accountsToBootstrap = [
      {
        email: 'operator@bettingautomation.io',
        passwordHash: legacyPasswordHash,
        name: 'Control Plane Operator',
        planId: 'pro',
        subscriptionId: 'sub_operator_pro',
        licenseId: 'lic_operator_default',
        licenseStatus: 'VALID',
        subStatus: 'ACTIVE'
      },
      {
        email: 'tester@bettingautomation.com',
        passwordHash: legacyPasswordHash,
        name: 'Automated Test Operator',
        planId: 'pro',
        subscriptionId: 'sub_tester_pro',
        licenseId: 'lic_tester_default',
        licenseStatus: 'VALID',
        subStatus: 'ACTIVE'
      },
      {
        email: 'operator@betting.local',
        passwordHash: canonicalPasswordHash,
        name: 'Canonical Pro Operator',
        planId: 'pro',
        subscriptionId: 'sub_canonical_pro',
        licenseId: 'lic_canonical_pro',
        licenseStatus: 'VALID',
        subStatus: 'ACTIVE'
      },
      {
        email: 'unpaid@betting.local',
        passwordHash: canonicalPasswordHash,
        name: 'Unpaid Test Operator',
        planId: null,
        subscriptionId: null,
        licenseId: null,
        licenseStatus: 'NONE',
        subStatus: 'NONE'
      },
      {
        email: 'expired@betting.local',
        passwordHash: canonicalPasswordHash,
        name: 'Expired License Operator',
        planId: 'pro',
        subscriptionId: 'sub_canonical_expired',
        licenseId: 'lic_canonical_expired',
        licenseStatus: 'EXPIRED',
        subStatus: 'EXPIRED'
      },
      {
        email: 'revoked@betting.local',
        passwordHash: canonicalPasswordHash,
        name: 'Revoked License Operator',
        planId: 'pro',
        subscriptionId: 'sub_canonical_revoked',
        licenseId: 'lic_canonical_revoked',
        licenseStatus: 'REVOKED',
        subStatus: 'CANCELLED'
      }
    ];

    // 1. Ensure 'pro' and 'starter' plan entitlements exist
    await client.query(`
      INSERT INTO plan_entitlements (plan_id, capabilities, limits)
      VALUES
        (
          'pro',
          $1::jsonb,
          '{"max_machines": 5, "max_concurrent_browsers": 6, "risk_tier": "LOW", "price": 10000, "interval": "Monthly"}'::jsonb
        ),
        (
          'starter',
          $1::jsonb,
          '{"max_machines": 2, "max_concurrent_browsers": 2, "risk_tier": "LOW", "price": 5000, "interval": "Monthly"}'::jsonb
        )
      ON CONFLICT (plan_id) DO UPDATE SET capabilities = EXCLUDED.capabilities;
    `, [JSON.stringify(PRO_CAPABILITIES)]);

    for (const item of accountsToBootstrap) {
      // 2. Insert account non-destructively (update password hash for canonical .local test accounts to ensure consistency)
      const insRes = await client.query(`
        INSERT INTO accounts (email, credentials_hash, status, lockout_count, last_event_hash)
        VALUES ($1, $2, 'ACTIVE', 0, $3)
        ON CONFLICT (email) DO NOTHING
        RETURNING account_id;
      `, [item.email, item.passwordHash, genesisHash]);

      let accountId = insRes.rows[0]?.account_id;
      if (!accountId) {
        const lookup = await client.query('SELECT account_id FROM accounts WHERE email = $1', [item.email]);
        accountId = lookup.rows[0]?.account_id;
        if (accountId && item.email.endsWith('@betting.local')) {
          await client.query(
            "UPDATE accounts SET credentials_hash = $1, status = 'ACTIVE', lockout_count = 0, lockout_expires_at = NULL WHERE account_id = $2",
            [item.passwordHash, accountId]
          );
        }
      }

      if (!accountId) continue;
      provisionedEmails.push(item.email);

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

      if (item.licenseStatus === 'NONE') {
        // Ensure unpaid account has no valid licenses or active subscriptions
        await client.query('DELETE FROM authorizations WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM licenses WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM subscriptions WHERE account_id = $1', [accountId]);
        continue;
      }

      if (item.licenseStatus === 'VALID') {
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
              $3::jsonb,
              '{"max_machines": 5, "max_concurrent_browsers": 6, "risk_tier": "LOW"}'::jsonb,
              1, now() + interval '365 days', $4
            );
          `, [accountId, item.planId, JSON.stringify(PRO_CAPABILITIES), item.licenseId]);
        }

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
      } else if (item.licenseStatus === 'EXPIRED') {
        await client.query('DELETE FROM authorizations WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM licenses WHERE account_id = $1', [accountId]);
        await client.query(`
          INSERT INTO licenses (
            account_id, plan_id, status, capabilities, limits,
            license_revision, expires_at, keygen_license_id
          )
          VALUES (
            $1, $2, 'EXPIRED',
            $3::jsonb,
            '{"max_machines": 5, "max_concurrent_browsers": 6, "risk_tier": "LOW"}'::jsonb,
            1, now() - interval '2 days', $4
          );
        `, [accountId, item.planId, JSON.stringify(PRO_CAPABILITIES), item.licenseId]);

        await client.query('DELETE FROM subscriptions WHERE account_id = $1', [accountId]);
        await client.query(`
          INSERT INTO subscriptions (
            account_id, provider_subscription_id, plan_id,
            status, current_period_start, current_period_end
          )
          VALUES (
            $1, $2, $3,
            'EXPIRED', now() - interval '32 days', now() - interval '2 days'
          )
          ON CONFLICT (provider_subscription_id) DO UPDATE SET status = 'EXPIRED', current_period_end = now() - interval '2 days';
        `, [accountId, item.subscriptionId, item.planId]);
      } else if (item.licenseStatus === 'REVOKED') {
        await client.query('DELETE FROM authorizations WHERE account_id = $1', [accountId]);
        await client.query('DELETE FROM licenses WHERE account_id = $1', [accountId]);
        await client.query(`
          INSERT INTO licenses (
            account_id, plan_id, status, capabilities, limits,
            license_revision, expires_at, keygen_license_id
          )
          VALUES (
            $1, $2, 'REVOKED',
            '[]'::jsonb,
            '{"max_machines": 0, "max_concurrent_browsers": 0, "risk_tier": "HIGH"}'::jsonb,
            1, now() - interval '1 day', $3
          );
        `, [accountId, item.planId, item.licenseId]);
      }
    }
  } catch (err) {
    console.error('[Bootstrap] Error during bootstrapDevAccounts:', err);
    throw err;
  } finally {
    client.release();
  }

  return { publicKeyHex, accounts: provisionedEmails };
}

