// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Fetch a session for renewal (locks the row)
 * @param {import('pg').PoolClient} client
 * @param {string} sessionId
 * @returns {Promise<any>}
 */
export async function getSessionForUpdate(client, sessionId) {
  const res = await client.query('SELECT * FROM sessions WHERE session_id = $1 FOR UPDATE', [sessionId]);
  return res.rows[0];
}

/**
 * Update session state on successful renewal
 * @param {import('pg').PoolClient} client
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function renewSessionInDb(client, sessionId) {
  await client.query(`
    UPDATE sessions 
    SET last_renewed_at = now(),
        renew_after = now() + interval '1 hour',
        expires_at = now() + interval '2 hours'
    WHERE session_id = $1
  `, [sessionId]);
}

/**
 * Revoke a session
 * @param {import('pg').PoolClient} client
 * @param {string} sessionId
 * @returns {Promise<void>}
 */
export async function revokeSessionInDb(client, sessionId) {
  await client.query(`
    UPDATE sessions 
    SET status = 'REVOKED'
    WHERE session_id = $1
  `, [sessionId]);
}
