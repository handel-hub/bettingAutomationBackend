// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';

/**
 * Handle incoming payment webhook
 * @param {string} provider 
 * @param {string} providerEventId 
 * @param {string} eventType 
 * @param {string} accountId 
 * @param {string} idempotencyKey 
 * @param {Record<string, unknown>} payload 
 * @returns {Promise<void>}
 */
export async function handleWebhook(provider, providerEventId, eventType, accountId, idempotencyKey, payload) {
  // 1. Signature verification should be done in the route or adapter before this
  
  // 2. Transactional outbox insert
  return withTransaction('READ COMMITTED', async (client) => {
    // Check if we already processed this provider event
    const existingRes = await client.query('SELECT event_id FROM payment_events WHERE provider_event_id = $1', [providerEventId]);
    if (existingRes.rows.length > 0) {
      return; // Already processed
    }
    
    // Insert into payment_events
    await client.query(`
      INSERT INTO payment_events (provider_event_id, provider, event_type, account_id, idempotency_key)
      VALUES ($1, $2, $3, $4, $5)
    `, [providerEventId, provider, eventType, accountId, idempotencyKey]);
    
    // Enqueue outbox event
    await client.query(`
      INSERT INTO outbox_events (event_type, payload, idempotency_key)
      VALUES ($1, $2, $3)
    `, [eventType, JSON.stringify(payload), idempotencyKey]);
  });
}
