// @ts-check
import { revoke } from '../domain/revocation/service.mjs';

/**
 * Sweeps subscriptions that have passed their current_period_end and updates them.
 * Closes LP-04/EV-12 (subscriptions expire without a live webhook trigger).
 * @param {import('pg').PoolClient} client 
 */
export async function scheduleSubscriptions(client) {
  const res = await client.query(`
    UPDATE subscriptions 
    SET status = 'EXPIRED' 
    WHERE status = 'ACTIVE' 
      AND current_period_end < now()
    RETURNING subscription_id, account_id
  `);
  
  if (res.rowCount > 0) {
    console.log(`Expired ${res.rowCount} subscriptions. Triggering cascades...`);
    // Enqueue outbox events or trigger cascade
    for (const sub of res.rows) {
      // In reality, we might revoke the specific license tied to the subscription
      // We will insert outbox events for the worker to handle the license downgrade/revoke
      await client.query(`
        INSERT INTO outbox_events (event_type, payload, idempotency_key)
        VALUES ('SUBSCRIPTION_EXPIRED', $1, $2)
      `, [JSON.stringify({ subscriptionId: sub.subscription_id, accountId: sub.account_id }), `sub-exp-${sub.subscription_id}`]);
    }
  }
}
