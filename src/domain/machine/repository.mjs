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

/**
 * Enforces account seat limits with smart dormancy reclamation.
 * If the account is at or above capacity, reclaims eligible inactive/dormant machines.
 * A machine is eligible for reclamation if:
 * 1. It belongs to accountId and status != 'REVOKED'.
 * 2. It is not the machine currently being bound/authenticated.
 * 3. It currently has NO active unexpired session (sessions.status = 'AUTHENTICATED' AND expires_at > now()).
 * 4. It currently has NO active unexpired authorization lease (authorizations.status = 'VALID' AND expires_at > now()).
 * 5. EITHER it was explicitly logged out OR its last activity is older than dormancyInterval (default: 1 hour).
 * 
 * @param {import('pg').PoolClient | import('pg').Pool} client
 * @param {string} accountId
 * @param {number} maxMachines
 * @param {string | null} [excludeMachineId]
 * @param {string} [dormancyInterval='1 hour']
 * @returns {Promise<{ allowed: boolean, activeCount: number, reclaimedCount: number }>}
 */
export async function enforceSeatLimitWithDormancyReclamation(
  client,
  accountId,
  maxMachines,
  excludeMachineId = null,
  dormancyInterval = '1 hour'
) {
  const runner = client || getPool();

  const countRes = await runner.query(
    "SELECT count(*)::int as count FROM machines WHERE account_id = $1 AND status != 'REVOKED'",
    [accountId]
  );
  let activeCount = Number(countRes.rows[0]?.count || 0);

  if (activeCount < maxMachines) {
    return { allowed: true, activeCount, reclaimedCount: 0 };
  }

  const excess = activeCount - maxMachines + 1;

  // Find candidate dormant machines
  const dormantRes = await runner.query(`
    SELECT m.machine_id
    FROM machines m
    WHERE m.account_id = $1
      AND m.status != 'REVOKED'
      AND ($2::uuid IS NULL OR m.machine_id != $2)
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.machine_id = m.machine_id
          AND s.status = 'AUTHENTICATED'
          AND s.expires_at > now()
      )
      AND NOT EXISTS (
        SELECT 1 FROM authorizations a
        JOIN sessions s ON s.session_id = a.session_id
        WHERE s.machine_id = m.machine_id
          AND a.status = 'VALID'
          AND a.expires_at > now()
      )
      AND (
        COALESCE(m.last_verified_at, m.updated_at, m.created_at) < now() - ($3::interval)
        OR EXISTS (
          SELECT 1 FROM sessions s
          WHERE s.machine_id = m.machine_id
            AND s.status = 'LOGGED_OUT'
        )
      )
    ORDER BY COALESCE(m.last_verified_at, m.updated_at, m.created_at) ASC
    LIMIT $4
  `, [accountId, excludeMachineId, dormancyInterval, excess]);

  const machinesToRevoke = dormantRes.rows.map(r => r.machine_id);

  if (machinesToRevoke.length >= excess) {
    await runner.query(`
      UPDATE machines
      SET status = 'REVOKED', revoked_at = now()
      WHERE machine_id = ANY($1::uuid[])
    `, [machinesToRevoke]);

    await runner.query(`
      UPDATE sessions
      SET status = 'REVOKED'
      WHERE machine_id = ANY($1::uuid[]) AND status = 'AUTHENTICATED'
    `, [machinesToRevoke]);

    activeCount -= machinesToRevoke.length;
    return { allowed: true, activeCount, reclaimedCount: machinesToRevoke.length };
  }

  return { allowed: false, activeCount, reclaimedCount: machinesToRevoke.length };
}

/**
 * List machines registered for an account with live session status
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any[]>}
 */
export async function listMachinesByAccount(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT m.machine_id, m.installation_id, m.status, m.descriptor, m.created_at, m.updated_at, m.last_verified_at,
           EXISTS(
             SELECT 1 FROM sessions s 
             WHERE s.machine_id = m.machine_id 
               AND s.status = 'AUTHENTICATED' 
               AND s.expires_at > now()
           ) as has_active_session
    FROM machines m
    WHERE m.account_id = $1 AND m.status != 'REVOKED'
    ORDER BY m.created_at DESC
  `, [accountId]);
  return res.rows;
}

/**
 * Revoke a machine and its active sessions
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} machineId
 * @param {string | null} [accountId]
 * @returns {Promise<void>}
 */
export async function revokeMachine(client, machineId, accountId = null) {
  const runner = client || getPool();
  const updRes = await runner.query(`
    UPDATE machines 
    SET status = 'REVOKED', revoked_at = now() 
    WHERE machine_id = $1 AND ($2::uuid IS NULL OR account_id = $2)
    RETURNING machine_id, account_id
  `, [machineId, accountId || null]);
  if (updRes.rows.length === 0) {
    return;
  }
  await runner.query(`
    UPDATE sessions
    SET status = 'REVOKED'
    WHERE machine_id = $1 AND status = 'AUTHENTICATED'
  `, [machineId]);
}

