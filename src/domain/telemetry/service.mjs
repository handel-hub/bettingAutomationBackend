// @ts-check
import { getPool } from '../../persistence/connection.mjs';

/**
 * Record an audit log event from ACP daemon or operator actions (UP-ACP-AUDIT-LOG).
 * @param {string} accountId 
 * @param {Object} data 
 * @param {string} [data.machineId]
 * @param {string} [data.sessionId]
 * @param {string} data.eventType
 * @param {'INFO' | 'WARN' | 'ERROR' | 'CRITICAL'} [data.severity='INFO']
 * @param {Object} data.payload
 * @returns {Promise<Object>}
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function resolveAccountOwnedMachineId(pool, accountId, machineId) {
  if (!machineId || !UUID_REGEX.test(String(machineId))) {
    return null;
  }
  const res = await pool.query(
    'SELECT machine_id FROM machines WHERE machine_id = $1 AND account_id = $2',
    [machineId, accountId]
  );
  return res.rows[0]?.machine_id || null;
}

export async function recordArbitrageAudit(accountId, data) {
  const pool = getPool();
  const {
    machineId = null,
    sessionId = null,
    eventType = 'AUDIT_LOG',
    severity = 'INFO',
    marketsScanned = 0,
    executionLatencyMs = null,
    ordersAccepted = 0,
    ordersRejected = 0,
    netProfitMargin = null,
    payload = {}
  } = data;

  const resolvedMachineId = await resolveAccountOwnedMachineId(pool, accountId, machineId);

  const eventPayload = {
    eventType,
    severity,
    sessionId,
    ...payload
  };

  const res = await pool.query(`
    INSERT INTO arbitrage_audit_telemetry (
      account_id, machine_id, markets_scanned, execution_latency_ms,
      orders_accepted, orders_rejected, net_profit_margin, event_payload
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING telemetry_id, account_id, machine_id, markets_scanned, execution_latency_ms,
              orders_accepted, orders_rejected, net_profit_margin, event_payload, recorded_at
  `, [
    accountId, resolvedMachineId, marketsScanned, executionLatencyMs,
    ordersAccepted, ordersRejected, netProfitMargin, JSON.stringify(eventPayload)
  ]);

  const row = res.rows[0];
  return {
    id: row.telemetry_id,
    accountId: row.account_id,
    machineId: row.machine_id,
    eventType: row.event_payload?.eventType || eventType,
    severity: row.event_payload?.severity || severity,
    payload: row.event_payload,
    recordedAt: row.recorded_at.toISOString(),
    createdAt: row.recorded_at.toISOString()
  };
}

/**
 * Query persisted audit logs for operator review.
 * @param {string} accountId 
 * @param {Object} [options]
 * @param {number} [options.limit=50]
 * @param {number} [options.offset=0]
 * @param {string} [options.eventType]
 * @returns {Promise<Object[]>}
 */
export async function listArbitrageAudits(accountId, options = {}) {
  const pool = getPool();
  const limit = Math.min(Number(options.limit) || 50, 100);
  const offset = Number(options.offset) || 0;

  let query = 'SELECT * FROM arbitrage_audit_telemetry WHERE account_id = $1';
  const params = [accountId];

  if (options.eventType) {
    params.push(options.eventType);
    query += ` AND (event_payload->>'eventType' = $${params.length})`;
  }

  query += ` ORDER BY recorded_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);

  const res = await pool.query(query, params);
  return res.rows.map(r => ({
    id: r.telemetry_id,
    accountId: r.account_id,
    machineId: r.machine_id,
    eventType: r.event_payload?.eventType || 'AUDIT_LOG',
    severity: r.event_payload?.severity || 'INFO',
    payload: r.event_payload,
    recordedAt: r.recorded_at.toISOString(),
    createdAt: r.recorded_at.toISOString()
  }));
}

/**
 * Ingest machine heartbeat telemetry from ACP daemon (UP-ACP-HEARTBEAT).
 * Updates machine liveness and persists diagnostics.
 * @param {string} accountId 
 * @param {Object} data 
 * @param {string} [data.machineId]
 * @param {Object} [data.telemetry]
 * @param {string[]} [data.recentLogs]
 * @returns {Promise<Object>}
 */
export async function recordHeartbeat(accountId, data) {
  const pool = getPool();
  const { machineId = null, telemetry = {}, recentLogs = [] } = data;
  const resolvedMachineId = await resolveAccountOwnedMachineId(pool, accountId, machineId);

  if (resolvedMachineId) {
    await pool.query(`
      UPDATE machines
      SET last_verified_at = now(), updated_at = now()
      WHERE machine_id = $1 AND account_id = $2
    `, [resolvedMachineId, accountId]);
  }

  const res = await pool.query(`
    INSERT INTO diagnostic_reports (account_id, machine_id, telemetry, recent_logs)
    VALUES ($1, $2, $3, $4)
    RETURNING report_id, created_at
  `, [accountId, resolvedMachineId, JSON.stringify(telemetry), JSON.stringify(recentLogs)]);

  return {
    reportId: res.rows[0].report_id,
    machineId: resolvedMachineId,
    status: 'RECORDED',
    timestamp: res.rows[0].created_at.toISOString()
  };
}
