// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch account by email for authentication purposes. 
 * This locks the account row if executed inside a transaction.
 * @param {import('pg').PoolClient} client 
 * @param {string} email 
 * @returns {Promise<any>}
 */
export async function getAccountByEmailForUpdate(client, email) {
  const res = await client.query('SELECT * FROM accounts WHERE email = $1 FOR UPDATE', [email]);
  return res.rows[0];
}

/**
 * Update account lockout counter and expiry.
 * @param {import('pg').PoolClient} client 
 * @param {string} accountId 
 * @param {number} newCount 
 * @param {Date | null} expiresAt 
 * @returns {Promise<void>}
 */
export async function updateAccountLockout(client, accountId, newCount, expiresAt) {
  // B-10 fix: increment atomically if newCount implies increment, but the design calls for explicit value here or atomic.
  // We'll use atomic increment if it's an increment.
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
