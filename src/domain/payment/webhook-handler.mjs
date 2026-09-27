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
    // Check if we already processed this provider event or idempotency key
    const existingRes = await client.query(
      'SELECT event_id FROM payment_events WHERE provider_event_id = $1 OR idempotency_key = $2',
      [providerEventId, idempotencyKey]
    );
    if (existingRes.rows.length > 0) {
      paymentLogger.info({
        event: 'payment_webhook_duplicate_skipped',
        provider,
        providerEventId,
        idempotencyKey,
        accountId
      }, `Duplicate payment webhook received and skipped: ${providerEventId}`);
      return { skipped: true, duplicate: true };
    }
    
    // Determine initial payment status
    const isFailed = eventType.includes('fail') || eventType.includes('declined');
    const paymentStatus = isFailed ? 'FAILED' : 'RECEIVED';

    // Insert into payment_events with race conflict handling
    try {
      const insRes = await client.query(`
        INSERT INTO payment_events (provider_event_id, provider, event_type, account_id, idempotency_key, status)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (provider_event_id) DO NOTHING
        RETURNING event_id
      `, [providerEventId, provider, eventType, accountId, idempotencyKey, paymentStatus]);

      if (insRes.rows.length === 0) {
        paymentLogger.info({
          event: 'payment_webhook_duplicate_race_skipped',
          provider,
          providerEventId,
          accountId
        }, `Concurrent duplicate payment event skipped via ON CONFLICT: ${providerEventId}`);
        return { skipped: true, duplicate: true };
      }
    } catch (insertErr) {
      if (insertErr.code === '23505') {
        paymentLogger.info({
          event: 'payment_webhook_duplicate_race_skipped',
          provider,
          providerEventId,
          idempotencyKey,
          accountId
        }, `Concurrent duplicate payment webhook caught by unique constraint and skipped: ${providerEventId}`);
        return { skipped: true, duplicate: true };
      }
      throw insertErr;
    }
    
    // Enqueue outbox event with idempotency protection
    try {
      await client.query(`
        INSERT INTO outbox_events (event_type, payload, idempotency_key)
        VALUES ($1, $2, $3)
        ON CONFLICT (idempotency_key) DO NOTHING
      `, [eventType, JSON.stringify(enrichedPayload), idempotencyKey]);
    } catch (outboxErr) {
      if (outboxErr.code === '23505') {
        paymentLogger.info({
          event: 'payment_webhook_outbox_race_skipped',
          provider,
          providerEventId,
          idempotencyKey,
          accountId
        }, `Concurrent duplicate outbox enqueue caught by unique constraint and skipped: ${idempotencyKey}`);
        return { skipped: true, duplicate: true };
      }
      throw outboxErr;
    }

    paymentLogger.info({
      event: 'payment_webhook_enqueued',
      provider,
      providerEventId,
      eventType,
      accountId,
      paymentStatus,
      traceId
    }, `Payment webhook enqueued into outbox: ${eventType} (${provider})`);

    return { success: true };
  });
}
