// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Find active valid license for an account
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function findActiveByAccount(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT * FROM licenses 
    WHERE account_id = $1 
    AND status = 'VALID' 
    AND (expires_at IS NULL OR expires_at > now())
    ORDER BY issued_at DESC
    LIMIT 1
  `, [accountId]);
  return res.rows[0] || null;
}

/**
 * Find latest license for an account regardless of expiration
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function findLatestByAccount(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT * FROM licenses 
    WHERE account_id = $1 
    ORDER BY issued_at DESC 
    LIMIT 1
  `, [accountId]);
  return res.rows[0] || null;
}

/**
 * Upsert license for an account
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ accountId: string, planId: string, capabilities: any, limits: any, expiresAt?: Date | string }} data
 * @returns {Promise<any>}
 */
export async function upsertLicense(client, { accountId, planId, capabilities, limits, expiresAt }) {
  const runner = client || getPool();
  const licCheck = await runner.query('SELECT license_id FROM licenses WHERE account_id = $1', [accountId]);
  if (licCheck.rows.length > 0) {
    const res = await runner.query(`
      UPDATE licenses 
      SET status = 'VALID', plan_id = $1, capabilities = $2, limits = $3, 
          expires_at = COALESCE($4, now() + interval '30 days'),
          license_revision = license_revision + 1, updated_at = now()
      WHERE account_id = $5
      RETURNING *
    `, [planId, JSON.stringify(capabilities), JSON.stringify(limits), expiresAt || null, accountId]);
    return res.rows[0];
  } else {
    const res = await runner.query(`
      INSERT INTO licenses (account_id, plan_id, status, capabilities, limits, issued_at, expires_at, license_revision)
      VALUES ($1, $2, 'VALID', $3, $4, now(), COALESCE($5, now() + interval '30 days'), 1)
      RETURNING *
    `, [accountId, planId, JSON.stringify(capabilities), JSON.stringify(limits), expiresAt || null]);
    return res.rows[0];
  }
}

/**
 * Revoke license for an account
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} accountId
 * @returns {Promise<void>}
 */
export async function revokeLicense(client, accountId) {
  const runner = client || getPool();
  await runner.query("UPDATE licenses SET status = 'REVOKED', updated_at = now() WHERE account_id = $1", [accountId]);
}
