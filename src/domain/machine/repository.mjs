// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Find machine by ID
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} machineId
 * @returns {Promise<any>}
 */
export async function findById(client, machineId) {
  const runner = client || getPool();
  const res = await runner.query('SELECT * FROM machines WHERE machine_id = $1', [machineId]);
  return res.rows[0] || null;
}

/**
 * Find machine by ID, installation ID, or hardware ID
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} identifier
 * @returns {Promise<any>}
 */
export async function findByIdOrInstallationId(client, identifier) {
  const runner = client || getPool();
  const res = await runner.query(
    "SELECT * FROM machines WHERE (machine_id::text = $1 OR installation_id = $1 OR descriptor->>'hardwareId' = $1)",
    [identifier]
  );
  return res.rows[0] || null;
}

/**
 * Find existing machine by installation ID and public key hex
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} installationId
 * @param {string} publicKeyHex
 * @returns {Promise<any>}
 */
export async function findByInstallationAndPublicKey(client, installationId, publicKeyHex) {
  const runner = client || getPool();
  const res = await runner.query(
    'SELECT * FROM machines WHERE installation_id = $1 AND public_key_hex = $2',
    [installationId, publicKeyHex]
  );
  return res.rows[0] || null;
}

/**
 * Find suspected clones with same installation_id but different public_key
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} installationId
 * @param {string} publicKeyHex
 * @returns {Promise<any[]>}
 */
export async function findClones(client, installationId, publicKeyHex) {
  const runner = client || getPool();
  const res = await runner.query(
    'SELECT machine_id FROM machines WHERE installation_id = $1 AND public_key_hex != $2',
    [installationId, publicKeyHex]
  );
  return res.rows;
}

/**
 * Count active machines for an account
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function countActiveByAccount(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(
    "SELECT COUNT(*) FROM machines WHERE account_id = $1 AND status != 'REVOKED'",
    [accountId]
  );
  return Number(res.rows[0]?.count || 0);
}

/**
 * Insert a newly registered machine
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {{ installationId: string, accountId: string | null, publicKeyHex: string, descriptor: any }} params
 * @returns {Promise<any>}
 */
export async function createMachine(client, { installationId, accountId, publicKeyHex, descriptor }) {
  const runner = client || getPool();
  const res = await runner.query(`
    INSERT INTO machines (installation_id, account_id, public_key_hex, descriptor, status, machine_generation)
    VALUES ($1, $2, $3, $4, 'REGISTERED', 1)
    RETURNING *
  `, [installationId, accountId, publicKeyHex, JSON.stringify(descriptor || {})]);
  return res.rows[0];
}

/**
 * Update machine status (e.g. REVOKED, REGISTERED)
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} machineId
 * @param {string} status
 * @returns {Promise<void>}
 */
export async function updateStatus(client, machineId, status) {
  const runner = client || getPool();
  await runner.query('UPDATE machines SET status = $1 WHERE machine_id = $2', [status, machineId]);
}

/**
 * Insert initial machine session state
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} accountId
 * @param {string} machineId
 * @returns {Promise<void>}
 */
export async function createSessionState(client, accountId, machineId) {
  const runner = client || getPool();
  await runner.query(`
    INSERT INTO machine_session_states (account_id, machine_id, session_generation, authorization_revision, machine_generation)
    VALUES ($1, $2, 1, 1, 1)
    ON CONFLICT (account_id, machine_id) DO NOTHING
  `, [accountId, machineId]);
}
