// @ts-check

const CIRCUIT_BREAKER_THRESHOLD = 10;

/**
 * Increment and check the revocation circuit breaker.
 * Must be called inside the revocation transaction.
 * @param {import('pg').PoolClient} client 
 * @returns {Promise<boolean>} true if tripped, false if safe
 */
export async function checkCircuitBreaker(client) {
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
}
