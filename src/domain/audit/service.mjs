// @ts-check
import { sha256 } from '../../crypto/hashing.mjs';

/**
 * Log a security event into the audit hash chain transactionally.
 * @param {import('pg').PoolClient} client 
 * @param {Object} params 
 * @param {string} [params.accountId]
 * @param {string} [params.machineId]
 * @param {string} [params.sessionId]
 * @param {string} params.eventType
 * @param {string} params.severity
 * @param {string} params.actorType
 * @param {string} [params.actorId]
 * @param {string} params.result
 * @param {string} [params.reason]
 * @param {any} [params.metadata]
 * @returns {Promise<void>}
 */
export async function logEvent(client, params) {
  // Redact metadata if present (simplified redactor for now)
  const metadata = params.metadata ? { ...params.metadata } : {};
  if (metadata.password) delete metadata.password;
  if (metadata.mfa_secret) delete metadata.mfa_secret;
  
  if (params.accountId) {
    // Account-scoped chain
    const res = await client.query('SELECT last_event_hash FROM accounts WHERE account_id = $1 FOR UPDATE', [params.accountId]);
    if (res.rows.length === 0) return; // Or throw depending on requirements
    
    const prevHash = res.rows[0].last_event_hash;
    const eventDataToHash = `${prevHash}|${params.eventType}|${params.result}|${params.accountId}|${Date.now()}`;
    const newHash = sha256(eventDataToHash);
    
    await client.query(`
      INSERT INTO security_events (
        account_id, machine_id, session_id, event_type, severity, 
        actor_type, actor_id, result, reason, metadata, prev_hash, event_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    `, [
      params.accountId, params.machineId, params.sessionId, params.eventType, params.severity,
      params.actorType, params.actorId, params.result, params.reason, JSON.stringify(metadata),
      prevHash, newHash
    ]);
    
    await client.query('UPDATE accounts SET last_event_hash = $2 WHERE account_id = $1', [params.accountId, newHash]);
  } else {
    // Global fallback for events without an account context
    const prevHash = sha256('GENESIS');
    const newHash = sha256(prevHash + params.eventType + Date.now());
    await client.query(`
      INSERT INTO security_events (
        machine_id, event_type, severity, actor_type, actor_id, result, reason, metadata, prev_hash, event_hash
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      params.machineId, params.eventType, params.severity, params.actorType, params.actorId,
      params.result, params.reason, JSON.stringify(metadata), prevHash, newHash
    ]);
  }
}
