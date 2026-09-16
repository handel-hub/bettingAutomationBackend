// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { checkCircuitBreaker } from './circuit-breaker.mjs';

/**
 * Revoke target and cascade appropriately
 * @param {'ACCOUNT'|'MACHINE'|'SESSION'|'LICENSE'} scope 
 * @param {string} targetId 
 * @param {string} reason 
 * @param {{ type: string, id?: string } | null} [actor=null]
 */
export async function revoke(scope, targetId, reason, actor = null) {
  // 1. Autonomous check circuit breaker (outside outer transaction so rollbacks don't reset it)
  const isTripped = await checkCircuitBreaker();
  if (isTripped) {
    throw new Error('CIRCUIT_BREAKER_ACTIVE');
  }

  return withTransaction('SERIALIZABLE', async (client) => {
    // 2. Cascade revocation based on scope following strict lock hierarchy:
    // accounts -> machines -> machine_session_states -> sessions -> authorizations
    if (scope === 'ACCOUNT') {
      await client.query('UPDATE accounts SET status = \'SUSPENDED\' WHERE account_id = $1', [targetId]);
      await client.query('UPDATE machines SET status = \'REVOKED\', revoked_at = now() WHERE account_id = $1', [targetId]);
      await client.query(`
        UPDATE machine_session_states 
        SET session_generation = session_generation + 1, authorization_revision = authorization_revision + 1
        WHERE account_id = $1
      `, [targetId]);
      await client.query('UPDATE sessions SET status = \'REVOKED\' WHERE account_id = $1', [targetId]);
      await client.query('UPDATE authorizations SET status = \'REVOKED\' WHERE account_id = $1', [targetId]);
      await client.query(`
        UPDATE file_transfers SET status = 'CANCELLED', cancelled_at = now() 
        WHERE session_id IN (SELECT session_id FROM sessions WHERE account_id = $1)
      `, [targetId]);
    } else if (scope === 'MACHINE') {
      await client.query('UPDATE machines SET status = \'REVOKED\', revoked_at = now() WHERE machine_id = $1', [targetId]);
      await client.query(`
        UPDATE machine_session_states 
        SET session_generation = session_generation + 1, authorization_revision = authorization_revision + 1
        WHERE machine_id = $1
      `, [targetId]);
      await client.query('UPDATE sessions SET status = \'REVOKED\' WHERE machine_id = $1', [targetId]);
      await client.query(`
        UPDATE authorizations SET status = 'REVOKED' 
        WHERE session_id IN (SELECT session_id FROM sessions WHERE machine_id = $1)
      `, [targetId]);
    } else if (scope === 'SESSION') {
      await client.query(`
        UPDATE machine_session_states 
        SET session_generation = session_generation + 1, authorization_revision = authorization_revision + 1
        WHERE machine_id = (SELECT machine_id FROM sessions WHERE session_id = $1)
      `, [targetId]);
      await client.query('UPDATE sessions SET status = \'REVOKED\' WHERE session_id = $1', [targetId]);
      await client.query('UPDATE authorizations SET status = \'REVOKED\' WHERE session_id = $1', [targetId]);
    } else if (scope === 'LICENSE') {
      await client.query('UPDATE licenses SET status = \'REVOKED\', revoked_at = now() WHERE license_id = $1', [targetId]);
      await client.query('UPDATE authorizations SET status = \'REVOKED\' WHERE license_id = $1', [targetId]);
      await client.query(`
        UPDATE sessions SET status = 'REVOKED' 
        WHERE session_id IN (SELECT session_id FROM authorizations WHERE license_id = $1)
      `, [targetId]);
    } else {
      throw new Error('Invalid revocation scope');
    }
    
    // 3. Enqueue REVOCATION_NOTICE via outbox
    const payload = { scope, targetId, reason };
    const idempotencyKey = `revoke-${scope}-${targetId}-${Date.now()}`;
    
    await client.query(`
      INSERT INTO outbox_events (event_type, payload, idempotency_key)
      VALUES ('REVOCATION_NOTICE', $1, $2)
    `, [JSON.stringify(payload), idempotencyKey]);
    
    // 4. Audit with actor attribution
    const { logEvent } = await import('../audit/service.mjs');
    await logEvent(client, {
      eventType: 'REVOCATION_CASCADE',
      severity: 'HIGH',
      actorType: actor?.type || 'SYSTEM',
      actorId: actor?.id || null,
      result: 'SUCCESS',
      reason
    });
  });
}
