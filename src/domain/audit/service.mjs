// @ts-check
import { sha256 } from '../../crypto/hashing.mjs';
import { canonicalStringify } from '../../protocol/canonical.mjs';

/**
 * Computes deterministic hash for an audit security event.
 * @param {string} prevHash 
 * @param {string} eventType 
 * @param {string} result 
 * @param {string} scopeId - accountId or 'GLOBAL'
 * @param {string} createdAt - ISO string
 * @param {any} metadata 
 * @returns {string}
 */
export function computeEventHash(prevHash, eventType, result, scopeId, createdAt, metadata) {
  const metadataStr = canonicalStringify(metadata || {});
  const data = `${prevHash}|${eventType}|${result}|${scopeId || 'GLOBAL'}|${createdAt}|${metadataStr}`;
  return sha256(data);
}

/**
 * Log a security event into the audit hash chain transactionally.
 * @param {import('pg').PoolClient | import('pg').Pool} db 
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
export async function logEvent(db, params) {
  // @ts-ignore
  let client = db;
  let releaseNeeded = false;
  // @ts-ignore
  if (typeof db.connect === 'function' && typeof db.release !== 'function') {
    // @ts-ignore
    client = await db.connect();
    releaseNeeded = true;
    await client.query('BEGIN');
  }

  try {
    // Redact metadata if present (simplified redactor for now)
    const metadata = params.metadata ? { ...params.metadata } : {};
    if (metadata.password) delete metadata.password;
    if (metadata.mfa_secret) delete metadata.mfa_secret;

    const createdAt = new Date().toISOString();

    if (params.accountId) {
      // Account-scoped chain
      const res = await client.query(
        'SELECT last_event_hash FROM accounts WHERE account_id = $1 FOR UPDATE',
        [params.accountId]
      );
      
      let prevHash = sha256('GENESIS');
      if (res.rows.length > 0 && res.rows[0].last_event_hash) {
        prevHash = res.rows[0].last_event_hash;
      }
      
      const newHash = computeEventHash(prevHash, params.eventType, params.result, params.accountId, createdAt, metadata);

      await client.query(`
        INSERT INTO security_events (
          account_id, machine_id, session_id, event_type, severity, 
          actor_type, actor_id, result, reason, metadata, prev_hash, event_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        params.accountId, 
        params.machineId || null, 
        params.sessionId || null, 
        params.eventType, 
        params.severity,
        params.actorType, 
        params.actorId || null, 
        params.result, 
        params.reason || null, 
        JSON.stringify(metadata),
        prevHash, 
        newHash,
        createdAt
      ]);

      if (res.rows.length > 0) {
        await client.query(
          'UPDATE accounts SET last_event_hash = $2 WHERE account_id = $1',
          [params.accountId, newHash]
        );
      }
    } else {
      // Global fallback for events without an account context
      const res = await client.query(
        'SELECT last_global_event_hash FROM backend_trust_state WHERE singleton_guard = true FOR UPDATE'
      );
      
      let prevHash = sha256('GENESIS');
      if (res.rows.length > 0 && res.rows[0].last_global_event_hash) {
        prevHash = res.rows[0].last_global_event_hash;
      }

      const newHash = computeEventHash(prevHash, params.eventType, params.result, 'GLOBAL', createdAt, metadata);

      await client.query(`
        INSERT INTO security_events (
          account_id, machine_id, session_id, event_type, severity, 
          actor_type, actor_id, result, reason, metadata, prev_hash, event_hash, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
      `, [
        null,
        params.machineId || null,
        params.sessionId || null,
        params.eventType,
        params.severity,
        params.actorType,
        params.actorId || null,
        params.result,
        params.reason || null,
        JSON.stringify(metadata),
        prevHash,
        newHash,
        createdAt
      ]);

      await client.query(
        'UPDATE backend_trust_state SET last_global_event_hash = $1 WHERE singleton_guard = true',
        [newHash]
      );
    }

    if (releaseNeeded) {
      await client.query('COMMIT');
    }
  } catch (err) {
    if (releaseNeeded) {
      await client.query('ROLLBACK');
    }
    throw err;
  } finally {
    if (releaseNeeded) {
      client.release();
    }
  }
}
