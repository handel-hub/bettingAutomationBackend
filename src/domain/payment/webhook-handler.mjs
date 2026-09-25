// @ts-check
import { withTransaction } from '../../persistence/transaction.mjs';
import { rootLogger } from '../../utils/Logger.mjs';
import { getContext } from '../../utils/context.mjs';

const paymentLogger = rootLogger.child({ component: 'PaymentWebhook' });

/**
 * Handle incoming payment webhook
 * @param {string} provider 
 * @param {string} providerEventId 
 * @param {string} eventType 
 * @param {string} accountId 
 * @param {string} idempotencyKey 
 * @param {Record<string, any>} payload 
 * @returns {Promise<void>}
 */
export async function handleWebhook(provider, providerEventId, eventType, accountId, idempotencyKey, payload) {
  const ctx = getContext();
  const traceId = ctx?.traceId || idempotencyKey;

  // Ensure traceId is attached to payload so outbox worker inherits the causal trace
  const enrichedPayload = {
    ...payload,
    _traceId: traceId,
    _provider: provider
  };
  
  // 2. Transactional outbox insert
  return withTransaction('READ COMMITTED', async (client) => {
    // Check if we already processed this provider event
    const existingRes = await client.query('SELECT event_id FROM payment_events WHERE provider_event_id = $1', [providerEventId]);
    if (existingRes.rows.length > 0) {
      paymentLogger.info({
        event: 'payment_webhook_duplicate_skipped',
        provider,
        providerEventId,
        accountId
      }, `Duplicate payment webhook received and skipped: ${providerEventId}`);
      return;
    }
    
    // Determine initial payment status
    const isFailed = eventType.includes('fail') || eventType.includes('declined');
    const paymentStatus = isFailed ? 'FAILED' : 'RECEIVED';

    // Insert into payment_events
    await client.query(`
      INSERT INTO payment_events (provider_event_id, provider, event_type, account_id, idempotency_key, status)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [providerEventId, provider, eventType, accountId, idempotencyKey, paymentStatus]);
    
    // Enqueue outbox event
    await client.query(`
      INSERT INTO outbox_events (event_type, payload, idempotency_key)
      VALUES ($1, $2, $3)
    `, [eventType, JSON.stringify(enrichedPayload), idempotencyKey]);

    paymentLogger.info({
      event: 'payment_webhook_enqueued',
      provider,
      providerEventId,
      eventType,
      accountId,
      paymentStatus,
      traceId
    }, `Payment webhook enqueued into outbox: ${eventType} (${provider})`);
  });
}
