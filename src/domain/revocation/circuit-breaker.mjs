import { getPool } from '../../persistence/connection.mjs';

const CIRCUIT_BREAKER_THRESHOLD = 10;

/**
 * Increment and check the revocation circuit breaker.
 * Uses an autonomous client committed independently so transaction rollbacks do not reset tripped state.
 * @param {import('pg').PoolClient} [autonomousClient] 
 * @returns {Promise<boolean>} true if tripped, false if safe
 */
export async function checkCircuitBreaker(autonomousClient = null) {
  const pool = getPool();
  const client = autonomousClient || await pool.connect();
  const shouldRelease = !autonomousClient;

  try {
    // Use upsert to increment the current minute's counter
    const res = await client.query(`
      INSERT INTO revocation_circuit_breaker (window_start, revocation_count, tripped)
      VALUES (date_trunc('minute', now()), 1, false)
      ON CONFLICT (window_start) DO UPDATE 
      SET revocation_count = revocation_circuit_breaker.revocation_count + 1
      RETURNING revocation_count, tripped, overridden_by
    `);
    
    const record = res.rows[0];
    
    // If previously tripped and not overridden, it stays tripped
    if (record.tripped && !record.overridden_by) {
      return true;
    }
    
    // If we just hit the threshold
    if (record.revocation_count >= CIRCUIT_BREAKER_THRESHOLD && !record.overridden_by) {
      await client.query(`
        UPDATE revocation_circuit_breaker 
        SET tripped = true 
        WHERE window_start = date_trunc('minute', now())
      `);
      
      const { logEvent } = await import('../audit/service.mjs');
      await logEvent(client, {
        eventType: 'CIRCUIT_BREAKER_TRIGGERED',
        severity: 'CRITICAL',
        actorType: 'SYSTEM',
        result: 'SUCCESS',
        reason: 'threshold_exceeded'
      });
      
      return true;
    }
    
    return false;
  } finally {
    if (shouldRelease) {
      client.release();
    }
  }
}

export const recordRevocation = checkCircuitBreaker;

/**
 * Check if the circuit breaker is currently tripped without incrementing.
 * @param {import('pg').PoolClient | import('pg').Pool} [db]
 * @returns {Promise<{ tripped: boolean, count: number }>}
 */
export async function isCircuitBreakerTripped(db = null) {
  const pool = db || getPool();
  const res = await pool.query(`
    SELECT revocation_count, tripped, overridden_by 
    FROM revocation_circuit_breaker 
    WHERE window_start = date_trunc('minute', now())
  `);
  if (res.rows.length === 0) return { tripped: false, count: 0 };
  const row = res.rows[0];
  return {
    tripped: Boolean(row.tripped && !row.overridden_by),
    count: Number(row.revocation_count)
  };
}

