// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Count open tickets for an account
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<number>}
 */
export async function countOpenTickets(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(
    "SELECT COUNT(*) FROM support_tickets WHERE account_id = $1 AND status IN ('OPEN', 'PENDING')",
    [accountId]
  );
  return Number(res.rows[0]?.count || 0);
}

/**
 * Find available support channels
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @returns {Promise<any[]>}
 */
export async function findAvailableSupportChannels(client) {
  const runner = client || getPool();
  const res = await runner.query(
    'SELECT id, title, description, action_type, action_target, icon, is_available FROM support_channels WHERE is_available = true ORDER BY sort_order ASC'
  );
  return res.rows;
}

/**
 * Find all support channels
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @returns {Promise<any[]>}
 */
export async function findAllSupportChannels(client) {
  const runner = client || getPool();
  const res = await runner.query('SELECT * FROM support_channels ORDER BY sort_order ASC');
  return res.rows;
}

/**
 * Upsert support channel
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {Object} channel
 * @returns {Promise<any>}
 */
export async function upsertSupportChannelInDb(client, channel) {
  const runner = client || getPool();
  const { id, title, description, actionType = 'EXTERNAL_LINK', actionTarget, icon = null, isAvailable = true, sortOrder = 10 } = channel;
  const res = await runner.query(`
    INSERT INTO support_channels (id, title, description, action_type, action_target, icon, is_available, sort_order, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      action_type = EXCLUDED.action_type,
      action_target = EXCLUDED.action_target,
      icon = EXCLUDED.icon,
      is_available = EXCLUDED.is_available,
      sort_order = EXCLUDED.sort_order,
      updated_at = now()
    RETURNING *
  `, [id, title, description, actionType, actionTarget, icon, isAvailable, sortOrder]);
  return res.rows[0];
}

/**
 * Insert support ticket
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {{ subject: string, category?: string, message: string, fileIds?: string[] }} data
 * @returns {Promise<any>}
 */
export async function insertTicket(client, accountId, data) {
  const runner = client || getPool();
  const { subject, category = 'GENERAL', message, fileIds = [] } = data;
  const res = await runner.query(`
    INSERT INTO support_tickets (account_id, subject, category, message, file_ids)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING ticket_id, status, created_at
  `, [accountId, subject, category, message, JSON.stringify(fileIds)]);
  return res.rows[0];
}

/**
 * List support tickets for account
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @returns {Promise<any[]>}
 */
export async function findTicketsByAccount(client, accountId) {
  const runner = client || getPool();
  const res = await runner.query(`
    SELECT ticket_id, subject, category, message, status, file_ids, created_at, updated_at
    FROM support_tickets
    WHERE account_id = $1
    ORDER BY created_at DESC
  `, [accountId]);
  return res.rows;
}

/**
 * Insert diagnostic report
 * @param {import('pg').PoolClient | import('pg').Pool} [client]
 * @param {string} accountId
 * @param {{ telemetry?: any, recentLogs?: string[], machineId?: string | null }} data
 * @returns {Promise<any>}
 */
export async function insertDiagnosticReport(client, accountId, data) {
  const runner = client || getPool();
  const { telemetry = {}, recentLogs = [], machineId = null } = data;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let resolvedMachineId = null;
  if (machineId && UUID_REGEX.test(String(machineId))) {
    const machRes = await runner.query(
      'SELECT machine_id FROM machines WHERE machine_id = $1 AND account_id = $2',
      [machineId, accountId]
    );
    resolvedMachineId = machRes.rows[0]?.machine_id || null;
  }
  const res = await runner.query(`
    INSERT INTO diagnostic_reports (account_id, machine_id, telemetry, recent_logs)
    VALUES ($1, $2, $3, $4)
    RETURNING report_id
  `, [accountId, resolvedMachineId, JSON.stringify(telemetry), JSON.stringify(recentLogs)]);
  return res.rows[0];
}
