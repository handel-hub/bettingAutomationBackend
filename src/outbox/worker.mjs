// @ts-check
import { getPool } from '../persistence/connection.mjs';
import { withTransaction } from '../persistence/transaction.mjs';
import { randomUUID } from 'crypto';

const WORKER_ID = `worker-${randomUUID()}`;

export async function claimNextEvent() {
  const pool = getPool();
  const res = await pool.query(`
    UPDATE outbox_events
    SET status = 'PROCESSING', 
        claimed_at = now(), 
        lease_expires_at = now() + interval '2 minutes', 
        worker_id = $1
    WHERE event_id = (
      SELECT event_id FROM outbox_events
      WHERE (status = 'PENDING' AND next_attempt_at <= now())
         OR (status = 'PROCESSING' AND lease_expires_at < now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING *;
  `, [WORKER_ID]);
  
  return res.rows[0] || null;
}

/**
 * @param {string} eventId 
 * @param {boolean} success 
 */
export async function completeEvent(eventId, success) {
  const pool = getPool();
  if (success) {
    await pool.query(`
      UPDATE outbox_events 
      SET status = 'DELIVERED', delivered_at = now() 
      WHERE event_id = $1
    `, [eventId]);
  } else {
    // Increment attempts, if max reached set to FAILED
    await pool.query(`
      UPDATE outbox_events 
      SET attempts = attempts + 1,
          status = CASE WHEN attempts + 1 >= max_attempts THEN 'FAILED' ELSE 'PENDING' END,
          next_attempt_at = now() + (interval '1 minute' * power(2, attempts))
      WHERE event_id = $1
    `, [eventId]);
  }
}

export async function startWorker() {
  console.log(`Starting Outbox Worker ${WORKER_ID}`);
  
  setInterval(async () => {
    try {
      const event = await claimNextEvent();
      if (event) {
        // Process event
        // e.g. if event_type === 'CREATE_LICENSE', call Keygen API, etc.
        console.log(`Processing outbox event: ${event.event_id}`);
        
        let success = true;
        try {
          if (event.event_type === 'REVOCATION_NOTICE') {
            // Forward revocation to external systems if necessary
          } else if (event.event_type.startsWith('PAYMENT_') || event.event_type.startsWith('charge.')) {
            const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
            const pool = getPool();
            
            // Paystack charges: event is 'charge.success'
            if (event.event_type === 'charge.success' || event.event_type === 'PAYMENT_SUCCESS') {
              const accountId = payload.data?.metadata?.account_id || payload.account_id;
              console.log(`✓ Processing successful payment for account: ${accountId}`);
              
              if (accountId) {
                // Ensure subscription is ACTIVE and extend license
                await pool.query(
                  "UPDATE subscriptions SET status = 'ACTIVE', current_period_end = now() + interval '30 days' WHERE account_id = $1",
                  [accountId]
                );
                await pool.query(
                  "UPDATE licenses SET status = 'VALID', expires_at = now() + interval '30 days' WHERE account_id = $1",
                  [accountId]
                );
              }
            } else if (
              event.event_type === 'charge.failed' || 
              event.event_type === 'PAYMENT_FAILED' ||
              event.event_type.includes('fail') ||
              event.event_type.includes('declined')
            ) {
              const accountId = payload.data?.metadata?.account_id || payload.account_id;
              const reason = payload.data?.gateway_response || payload.reason || 'Payment declined by bank';
              console.warn(`⚠ Processing failed/declined payment for account ${accountId}: ${reason}`);
              
              if (accountId) {
                // Mark subscription as PAST_DUE on failed charge
                await pool.query(
                  "UPDATE subscriptions SET status = 'PAST_DUE' WHERE account_id = $1 AND status = 'ACTIVE'",
                  [accountId]
                );
                
                // Audit log the failed payment attempt
                const { logEvent } = await import('../domain/audit/service.mjs');
                const client = await pool.connect();
                try {
                  await logEvent(client, {
                    accountId,
                    eventType: 'PAYMENT_FAILED',
                    severity: 'MEDIUM',
                    actorType: 'PROVIDER',
                    actorId: 'paystack',
                    result: 'FAILURE',
                    reason,
                    metadata: {
                      reference: payload.data?.reference,
                      amount: payload.data?.amount,
                      channel: payload.data?.channel
                    }
                  });
                } finally {
                  client.release();
                }
              }
            }
          }
        } catch (e) {
          console.error(`Error processing event ${event.event_id}:`, e);
          success = false;
        }
        
        await completeEvent(event.event_id, success);
      }
    } catch (err) {
      console.error('Outbox worker error:', err);
    }
  }, 5000); // Poll every 5s
}
