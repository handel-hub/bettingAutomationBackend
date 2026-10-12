// @ts-check
import { performance } from 'node:perf_hooks';
import { getPool } from '../persistence/connection.mjs';
import { withTransaction } from '../persistence/transaction.mjs';
import { randomUUID } from 'crypto';
import { runWithContext } from '../utils/context.mjs';
import { rootLogger } from '../utils/Logger.mjs';
import { metrics } from '../utils/metrics.mjs';

const outboxLogger = rootLogger.child({ component: 'OutboxWorker' });
const WORKER_ID = `worker-${randomUUID()}`;

let workerInterval = null;

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
 * @param {string} [lastError]
 */
export async function completeEvent(eventId, success, lastError = null) {
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

/**
 * Process a claimed outbox event
 * @param {any} event 
 * @returns {Promise<boolean>} success
 */
export async function processOutboxEvent(event) {
  const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
  const traceId = payload?._traceId || payload?.traceId || event.idempotency_key || `outbox-${event.event_id}`;
  const accountId = payload?.accountId || payload?.data?.meta?.account_id || payload?.data?.metadata?.account_id || payload?.account_id;

  const context = {
    traceId,
    accountId,
    startTime: performance.now(),
    queryCount: 0,
    queryDurationMs: 0
  };

  return runWithContext(context, async () => {
    return withTransaction('READ COMMITTED', async (client) => {
      if (event.event_type === 'REVOCATION_NOTICE' || event.event_type === 'LICENSE_REVOKED') {
        const { broadcast } = await import('../websocket/server.mjs');
        const targetAccountId = payload.scope === 'ACCOUNT' ? payload.targetId : (payload.accountId || null);
        broadcast('LICENSE_REVOKED', {
          scope: payload.scope || 'LICENSE',
          targetId: payload.targetId || payload.accountId,
          reason: payload.reason,
          timestamp: new Date().toISOString()
        }, targetAccountId);
        broadcast('revocation:notice', {
          scope: payload.scope || 'LICENSE',
          targetId: payload.targetId || payload.accountId,
          reason: payload.reason,
          timestamp: new Date().toISOString()
        }, targetAccountId);
        return true;
      } else if (event.event_type === 'SUBSCRIPTION_EXPIRED') {
        const { broadcast } = await import('../websocket/server.mjs');
        broadcast('SUBSCRIPTION_STATUS_CHANGED', {
          subscriptionId: payload.subscriptionId,
          accountId: payload.accountId,
          subscription: {
            planId: 'pro',
            status: 'EXPIRED'
          },
          timestamp: new Date().toISOString()
        }, payload.accountId);
        broadcast('subscription:expired', {
          subscriptionId: payload.subscriptionId,
          accountId: payload.accountId,
          timestamp: new Date().toISOString()
        }, payload.accountId);
        return true;
      } else if (event.event_type.startsWith('PAYMENT_') || event.event_type.startsWith('charge.')) {
        const isExplicitPaystack = payload._provider === 'paystack' || payload.provider === 'paystack';
        const isExplicitFlw = payload._provider === 'flutterwave' || payload.provider === 'flutterwave';
        const isFlw = isExplicitFlw || (!isExplicitPaystack && Boolean(payload.data?.flw_ref || (!payload.data?.channel && !payload.data?.authorization && payload.data?.charged_amount)));
        const isFlwSuccess = (event.event_type === 'charge.completed' || event.event_type === 'PAYMENT_SUCCESS') && (payload.data?.status === 'successful' || !payload.data?.status);
        const isPaystackSuccess = event.event_type === 'charge.success' || event.event_type === 'PAYMENT_SUCCESS';

        // 1. Success charge processing
        if (isPaystackSuccess || isFlwSuccess) {
          const accId = payload.data?.meta?.account_id || payload.data?.metadata?.account_id || payload.account_id;
          outboxLogger.info({
            event: 'payment_charge_success_processing',
            accountId: accId,
            eventId: event.event_id,
            traceId
          }, `Processing successful payment for account: ${accId}`);
          
          if (accId) {
            const planId = payload.data?.meta?.plan_id || payload.data?.metadata?.plan_id || payload.plan_id || 'PRO';
            const ref = String(payload.data?.tx_ref || payload.data?.reference || `ref-${Date.now()}`).trim();
            const providerTxId = String(payload.data?.id || ref).trim();
            const billingInterval = (payload.data?.meta?.billing_interval || payload.data?.metadata?.billing_interval || 'monthly').toLowerCase();
            
            let majorAmount;
            if (isFlw) {
              majorAmount = Number(payload.data?.charged_amount || payload.data?.amount || 10000);
            } else {
              const rawAmount = payload.data?.amount || 1000000;
              majorAmount = (typeof rawAmount === 'number' && rawAmount >= 100) ? (rawAmount / 100) : rawAmount;
            }

            const planRes = await client.query('SELECT * FROM subscription_plans WHERE LOWER(plan_id) = LOWER($1)', [planId]);
            const plan = planRes.rows[0];
            if (plan) {
              const expectedPrice = billingInterval === 'annual' ? Number(plan.annual_price) : Number(plan.monthly_price);
              if (majorAmount < expectedPrice) {
                outboxLogger.warn({
                  event: 'payment_webhook_amount_insufficient',
                  accountId: accId,
                  planId,
                  billingInterval,
                  majorAmount,
                  expectedPrice,
                  reference: ref
                }, `Rejected webhook payment with insufficient amount (${majorAmount} < ${expectedPrice})`);
                return true;
              }
            }

            const providerSubId = payload.data?.subscription_code || payload.data?.flw_ref || `sub-${ref}`;
            const { applyPaymentSuccess } = await import('../domain/billing/service.mjs');
            try {
              await applyPaymentSuccess(client, {
                accountId: accId,
                planId,
                billingInterval,
                amount: majorAmount,
                reference: ref,
                providerTxId,
                receiptUrl: payload.data?.receipt_url || null,
                providerSubId
              });
            } catch (payErr) {
              if (payErr && payErr.code === 'PAYMENT_ALREADY_REDEEMED') {
                outboxLogger.info({ event: 'payment_webhook_already_redeemed', reference: ref, providerTxId }, 'Payment already redeemed via verify endpoint; skipping duplicate credit');
                return true;
              }
              throw payErr;
            }
          }
        } else if (
          event.event_type === 'charge.failed' || 
          event.event_type === 'PAYMENT_FAILED' ||
          (event.event_type === 'charge.completed' && payload.data?.status && payload.data?.status !== 'successful') ||
          event.event_type.includes('fail') ||
          event.event_type.includes('declined')
        ) {
          const explicitAccountId = payload.data?.meta?.account_id || payload.data?.metadata?.account_id || null;
          const accId = explicitAccountId || payload.account_id;
          const reason = payload.data?.gateway_response || payload.data?.processor_response || payload.reason || 'Payment declined by bank';
          outboxLogger.warn({
            event: 'payment_charge_failed_processing',
            accountId: accId,
            reason,
            eventId: event.event_id,
            traceId
          }, `Processing failed/declined payment for account ${accId}: ${reason}`);
          
          if (accId) {
            const subCode = payload.data?.subscription_code || payload.data?.flw_ref || null;
            if (explicitAccountId) {
              await client.query(
                "UPDATE subscriptions SET status = 'PAST_DUE' WHERE account_id = $1 AND status = 'ACTIVE'",
                [explicitAccountId]
              );
            } else if (subCode) {
              await client.query(
                "UPDATE subscriptions SET status = 'PAST_DUE' WHERE account_id = $1 AND provider_subscription_id = $2 AND status = 'ACTIVE'",
                [accId, subCode]
              );
            }

            // Audit log the failed payment attempt
            const { logEvent } = await import('../domain/audit/service.mjs');
            const providerName = isFlw ? 'flutterwave' : 'paystack';
            await logEvent(client, {
              accountId: accId,
              eventType: 'PAYMENT_FAILED',
              severity: 'MEDIUM',
              actorType: 'PROVIDER',
              actorId: providerName,
              result: 'FAILURE',
              reason,
              metadata: {
                reference: payload.data?.tx_ref || payload.data?.reference,
                amount: payload.data?.amount,
                channel: payload.data?.channel
              }
            });

            // Broadcast to connected ACP / UI instances
            try {
              const { broadcast } = await import('../websocket/server.mjs');
              broadcast('SUBSCRIPTION_STATUS_CHANGED', {
                accountId: accId,
                subscription: {
                  status: 'PAST_DUE'
                },
                timestamp: new Date().toISOString()
              }, accId);
            } catch (wsErr) {
              // Non-critical if websocket is not active
            }
          }
        }
      }
      return true;
    });
  });
}

export function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    outboxLogger.info({ event: 'outbox_worker_stopped' }, 'Outbox worker stopped');
  }
}

export function startWorker() {
  outboxLogger.info({ event: 'outbox_worker_started', workerId: WORKER_ID }, `Starting Outbox Worker ${WORKER_ID}`);
  let isRunning = false;

  const runDrainCycle = async () => {
    if (isRunning) return;
    isRunning = true;
    try {
      let drained = 0;
      while (drained < 10) {
        const event = await claimNextEvent();
        if (!event) break;
        drained++;

        const start = performance.now();
        let success = false;
        let lastError = null;

        try {
          success = await processOutboxEvent(event);
        } catch (procErr) {
          lastError = procErr.message;
          outboxLogger.error({
            event: 'outbox_event_processing_error',
            eventId: event.event_id,
            eventType: event.event_type,
            procErr
          }, `Error processing outbox event ${event.event_id}: ${procErr.message}`);
          success = false;
        } finally {
          const elapsed = performance.now() - start;
          metrics.recordOutboxEvent(event.event_type, elapsed, success);

          try {
            await completeEvent(event.event_id, success, lastError);
            outboxLogger.info({
              event: 'outbox_event_completed',
              eventId: event.event_id,
              eventType: event.event_type,
              success,
              durationMs: Math.round(elapsed * 100) / 100
            }, `Completed outbox event ${event.event_id} (${success ? 'DELIVERED' : 'RETRY'}) in ${elapsed.toFixed(1)}ms`);
          } catch (completeErr) {
            outboxLogger.error({
              event: 'outbox_complete_event_error',
              eventId: event.event_id,
              completeErr
            }, `Failed to complete outbox event ${event.event_id}: ${completeErr.message}`);
          }
        }
      }
    } catch (err) {
      outboxLogger.error({ event: 'outbox_worker_loop_error', err }, `Outbox worker loop error: ${err.message}`);
    } finally {
      isRunning = false;
    }
  };

  workerInterval = setInterval(runDrainCycle, 5000);
  return workerInterval;
}
