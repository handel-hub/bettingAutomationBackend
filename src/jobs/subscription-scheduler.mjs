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
    WHERE status IN ('ACTIVE', 'CANCELLED', 'PAST_DUE') 
      AND current_period_end < now()
    RETURNING subscription_id, account_id
  `);
  
  if (res.rowCount > 0) {
    console.log(`Expired ${res.rowCount} subscriptions. Cascading to licenses and authorizations...`);
    for (const sub of res.rows) {
      // 1. Mark active licenses under this account as EXPIRED
      await client.query(`
        UPDATE licenses 
        SET status = 'EXPIRED', updated_at = now()
        WHERE account_id = $1 AND status = 'VALID'
      `, [sub.account_id]);

      // 2. Cascade revocation to active authorizations
      await client.query(`
        UPDATE authorizations
        SET status = 'REVOKED', updated_at = now()
        WHERE account_id = $1 AND status = 'VALID'
      `, [sub.account_id]);

      // 3. Enqueue outbox event for external syncing
      await client.query(`
        INSERT INTO outbox_events (event_type, payload, idempotency_key)
        VALUES ('SUBSCRIPTION_EXPIRED', $1, $2)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [JSON.stringify({ subscriptionId: sub.subscription_id, accountId: sub.account_id }), `sub-exp-${sub.subscription_id}`]);

      // 4. Enqueue LICENSE_REVOKED for authoritative Control Plane enforcement (DEF-11 / CAN-11)
      await client.query(`
        INSERT INTO outbox_events (event_type, payload, idempotency_key)
        VALUES ('LICENSE_REVOKED', $1, $2)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [JSON.stringify({ scope: 'LICENSE', targetId: sub.account_id, accountId: sub.account_id, subscriptionId: sub.subscription_id, reason: 'SUBSCRIPTION_EXPIRED' }), `lic-rev-${sub.subscription_id}`]);
    }
  }
}
