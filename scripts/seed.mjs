// @ts-check
import { getPool } from '../src/persistence/connection.mjs';
import { hashPassword, sha256 } from '../src/crypto/hashing.mjs';

async function seed() {
  const pool = getPool();
  const client = await pool.connect();

  try {
    console.log('Seeding test data into betting_automation...');

    // 1. Create Test Account
    const testEmail = 'tester@bettingautomation.com';
    const testPassword = 'Password123!';
    const passwordHash = await hashPassword(testPassword);
    const genesisHash = sha256('GENESIS');

    const accountRes = await client.query(`
      INSERT INTO accounts (email, credentials_hash, status, lockout_count, last_event_hash)
      VALUES ($1, $2, 'ACTIVE', 0, $3)
      ON CONFLICT (email) DO UPDATE SET credentials_hash = EXCLUDED.credentials_hash
      RETURNING account_id;
    `, [testEmail, passwordHash, genesisHash]);

    const accountId = accountRes.rows[0].account_id;
    console.log(`✓ Account ready: ${testEmail} (ID: ${accountId})`);

    // 2. Initialize Account Generation State
    await client.query(`
      INSERT INTO account_generation_states (account_id, license_revision)
      VALUES ($1, 1)
      ON CONFLICT (account_id) DO NOTHING;
    `, [accountId]);
    console.log('✓ Account generation state initialized');

    // 3. Create a Test Plan Entitlement
    await client.query(`
      INSERT INTO plan_entitlements (plan_id, capabilities, limits)
      VALUES (
        'starter_monthly',
        '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD"]'::jsonb,
        '{"max_machines": 2, "risk_tier": "MEDIUM"}'::jsonb
      )
      ON CONFLICT (plan_id) DO UPDATE 
      SET capabilities = EXCLUDED.capabilities, limits = EXCLUDED.limits;
    `);
    console.log('✓ Plan entitlements inserted');

    // 4. Create an Active License
    const licenseRes = await client.query(`
      INSERT INTO licenses (
        account_id, plan_id, status, capabilities, limits, 
        license_revision, expires_at, keygen_license_id
      )
      VALUES (
        $1, 'starter_monthly', 'VALID',
        '["CAP_AUTOMATION_START", "CAP_AUTOMATION_STOP", "CAP_FILE_UPLOAD"]'::jsonb,
        '{"max_machines": 2, "risk_tier": "MEDIUM"}'::jsonb,
        1, now() + interval '30 days', 'lic_test_001'
      )
      RETURNING license_id;
    `, [accountId]);
    console.log(`✓ Active license ready (ID: ${licenseRes.rows[0].license_id})`);

    // 5. Create an Active Subscription
    await client.query(`
      INSERT INTO subscriptions (
        account_id, provider_subscription_id, plan_id, 
        status, current_period_start, current_period_end
      )
      VALUES (
        $1, 'sub_test_001', 'starter_monthly',
        'ACTIVE', now(), now() + interval '30 days'
      )
      ON CONFLICT (provider_subscription_id) DO NOTHING;
    `, [accountId]);
    console.log('✓ Test subscription recorded');

    console.log('\nDatabase test data seeding completed successfully!');
  } catch (err) {
    console.error('Seeding failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

seed();
