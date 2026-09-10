// @ts-check
import { getPool } from '../../persistence/connection.mjs';
import { getBillingSnapshot } from '../billing/service.mjs';
import { getPlatformRegistrySnapshot } from '../platforms/service.mjs';
import { getCustomerCareSnapshot } from '../support/service.mjs';
import { getAutomationSnapshot } from '../automation/service.mjs';

/**
 * Composite business state aggregation for initial console load (CNT-PRELUDE-01).
 * @param {string} accountId 
 * @returns {Promise<Object>}
 */
export async function getPreludeSnapshot(accountId) {
  const pool = getPool();

  // 1. Fetch Account & Profile
  const accRes = await pool.query('SELECT account_id, email, status, created_at FROM accounts WHERE account_id = $1', [accountId]);
  const account = accRes.rows[0] ? {
    id: accRes.rows[0].account_id,
    email: accRes.rows[0].email,
    status: accRes.rows[0].status,
    createdAt: accRes.rows[0].created_at
  } : null;

  // 2. Fetch Active License
  const licRes = await pool.query(
    'SELECT license_id, plan_id, status, capabilities, limits, issued_at, expires_at FROM licenses WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1',
    [accountId]
  );
  const license = licRes.rows[0] ? {
    id: licRes.rows[0].license_id,
    planId: licRes.rows[0].plan_id,
    status: licRes.rows[0].status,
    capabilities: licRes.rows[0].capabilities,
    limits: licRes.rows[0].limits,
    issuedAt: licRes.rows[0].issued_at,
    expiresAt: licRes.rows[0].expires_at
  } : null;

  // 3. Parallel domain aggregations
  const [billing, platforms, support, automation] = await Promise.all([
    getBillingSnapshot(accountId),
    getPlatformRegistrySnapshot(),
    getCustomerCareSnapshot(accountId),
    getAutomationSnapshot(accountId)
  ]);

  return {
    account,
    license,
    billing,
    platforms,
    support,
    automation,
    timestamp: new Date().toISOString()
  };
}
