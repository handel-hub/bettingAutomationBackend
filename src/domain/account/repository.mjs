// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Find account by ID
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function findById(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query('SELECT * FROM accounts WHERE account_id = $1', [accountId]);
  return res.rows[0] || null;
}

/**
 * Lock account row by ID for update
 * @param {import('pg').PoolClient} client
 * @param {string} accountId
 * @returns {Promise<any>}
 */
export async function findByIdForUpdate(client, accountId) {
  const res = await client.query('SELECT * FROM accounts WHERE account_id = $1 FOR UPDATE', [accountId]);
  return res.rows[0] || null;
}

/**
 * Find account by email
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} email
 * @returns {Promise<any>}
 */
export async function findByEmail(client, email) {
  const runner = client || getPool();
  const res = await runner.query('SELECT * FROM accounts WHERE email = $1', [email]);
  return res.rows[0] || null;
}

/**
 * Find account by email for update
 * @param {import('pg').PoolClient} client
 * @param {string} email
 * @returns {Promise<any>}
 */
export async function findByEmailForUpdate(client, email) {
  const res = await client.query('SELECT * FROM accounts WHERE email = $1 FOR UPDATE', [email]);
  return res.rows[0] || null;
}

/**
 * Update account status (e.g. ACTIVE, LOCKED, SUSPENDED)
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} accountId
 * @param {string} status
 * @returns {Promise<void>}
 */
export async function updateStatus(client, accountId, status) {
  const runner = client || getPool();
  await runner.query('UPDATE accounts SET status = $1, updated_at = now() WHERE account_id = $2', [status, accountId]);
}

/**
 * Update account lockout counter and expiry
 * @param {import('pg').PoolClient} client
 * @param {string} accountId
 * @param {number} newCount
 * @param {Date | null} expiresAt
 * @returns {Promise<void>}
 */
export async function updateLockout(client, accountId, newCount, expiresAt) {
  if (newCount > 0) {
    await client.query(
      'UPDATE accounts SET lockout_count = lockout_count + 1, lockout_expires_at = $2 WHERE account_id = $1',
      [accountId, expiresAt]
    );
  } else {
    await client.query(
      'UPDATE accounts SET lockout_count = 0, lockout_expires_at = NULL WHERE account_id = $1',
      [accountId]
    );
  }
}
