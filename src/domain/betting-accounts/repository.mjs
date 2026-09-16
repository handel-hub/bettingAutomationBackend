// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Insert a betting account and its default automation config
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {Object} data
 * @returns {Promise<any>}
 */
export async function insertAccount(client, data) {
  const runner = client || getPool();
  const { accountId, name, platformDisplayName, accountUsername, ciphertext, nonce, tag, tags } = data;

  const insertRes = await runner.query(`
    INSERT INTO betting_accounts (
      account_id, name, platform_display_name, account_username,
      account_password_encrypted, password_iv, password_tag, tags
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING *
  `, [
    accountId,
    name,
    platformDisplayName,
    accountUsername,
    ciphertext,
    nonce,
    tag,
    JSON.stringify(tags || [])
  ]);

  const acc = insertRes.rows[0];

  await runner.query(`
    INSERT INTO automation_account_configs (account_id)
    VALUES ($1)
    ON CONFLICT (account_id) DO NOTHING
  `, [acc.id]);

  return acc;
}

/**
 * List betting accounts with pagination, search, and automation config joins
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {{ offset?: number, limit?: number, filterQuery?: string }} [options]
 * @returns {Promise<any[]>}
 */
export async function findAccountsByAccount(client, accountId, options = {}) {
  const runner = client || getPool();
  const offset = Number(options.offset) || 0;
  const limit = Math.min(Number(options.limit) || 50, 100);

  let query = `
    SELECT ba.*, aac.bet_cycle_enabled, aac.browser_status, aac.account_status,
           aac.pricing_source, aac.risk_source, aac.rebet_source
    FROM betting_accounts ba
    LEFT JOIN automation_account_configs aac ON ba.id = aac.account_id
    WHERE ba.account_id = $1
  `;
  const params = [accountId];

  if (options.filterQuery) {
    params.push(`%${options.filterQuery.toLowerCase()}%`);
    query += ` AND (lower(ba.name) LIKE $${params.length} OR lower(ba.account_username) LIKE $${params.length})`;
  }

  query += ` ORDER BY ba.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const res = await runner.query(query, params);
  return res.rows;
}

/**
 * Count total betting accounts for an account
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function countAccountsByAccount(client, accountId) {
  const runner = client || getPool();
  const countRes = await runner.query('SELECT COUNT(*) FROM betting_accounts WHERE account_id = $1', [accountId]);
  return Number(countRes.rows[0]?.count || 0);
}

/**
 * Find detailed betting account by ID
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function findAccountById(client, accountId, id) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT ba.*, aac.bet_cycle_enabled, aac.browser_status, aac.account_status,
           aac.pricing_source, aac.risk_source, aac.rebet_source,
           aac.custom_pricing, aac.custom_risk, aac.custom_rebet
    FROM betting_accounts ba
    LEFT JOIN automation_account_configs aac ON ba.id = aac.account_id
    WHERE ba.id = $1 AND ba.account_id = $2
  `, [id, accountId]);
  return res.rows[0] || null;
}

/**
 * Delete a single betting account
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function deleteAccount(client, accountId, id) {
  const runner = client || getPool();
  const res = await runner.query('DELETE FROM betting_accounts WHERE id = $1 AND account_id = $2 RETURNING id', [id, accountId]);
  return res.rows[0] || null;
}

/**
 * Update state of a single betting account
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {string} id
 * @param {{ newState: string, category: string, description: string }} stateInfo
 * @returns {Promise<any>}
 */
export async function updateAccountState(client, accountId, id, { newState, category, description }) {
  const runner = client || getPool();
  const res = await runner.query(`
    UPDATE betting_accounts
    SET backend_state = $1, presentation_category = $2, status_description = $3, updated_at = now()
    WHERE id = $4 AND account_id = $5
    RETURNING id, backend_state
  `, [newState, category, description, id, accountId]);
  return res.rows[0] || null;
}

/**
 * Batch update state of multiple accounts
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {string[]} ids
 * @param {{ newState: string, category: string, description: string }} stateInfo
 * @returns {Promise<string[]>} updated IDs
 */
export async function batchUpdateAccountState(client, accountId, ids, { newState, category, description }) {
  const runner = client || getPool();
  const res = await runner.query(`
    UPDATE betting_accounts
    SET backend_state = $1, presentation_category = $2, status_description = $3, updated_at = now()
    WHERE account_id = $4 AND id = ANY($5)
    RETURNING id
  `, [newState, category, description, accountId, ids]);
  return res.rows.map(r => r.id);
}

/**
 * Batch delete multiple accounts
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {string[]} ids
 * @returns {Promise<string[]>} deleted IDs
 */
export async function batchDeleteAccounts(client, accountId, ids) {
  const runner = client || getPool();
  const res = await runner.query(`
    DELETE FROM betting_accounts
    WHERE account_id = $1 AND id = ANY($2)
    RETURNING id
  `, [accountId, ids]);
  return res.rows.map(r => r.id);
}

/**
 * Fetch encryption credentials for decryption
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {string} id
 * @returns {Promise<any>}
 */
export async function getCredentialsForDecryption(client, accountId, id) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT platform_display_name, account_username, account_password_encrypted, password_iv, password_tag
    FROM betting_accounts
    WHERE id = $1 AND account_id = $2
  `, [id, accountId]);
  return res.rows[0] || null;
}
