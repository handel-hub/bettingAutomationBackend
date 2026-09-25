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

/**
 * Process a claimed outbox event
 * @param {any} event 
 * @returns {Promise<boolean>} success
 */
export async function processOutboxEvent(event) {
  return withTransaction('READ COMMITTED', async (client) => {
    if (event.event_type === 'REVOCATION_NOTICE') {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      const { broadcast } = await import('../websocket/server.mjs');
      const targetAccountId = payload.scope === 'ACCOUNT' ? payload.targetId : null;
      broadcast('LICENSE_REVOKED', {
        scope: payload.scope,
        targetId: payload.targetId,
        reason: payload.reason,
        timestamp: new Date().toISOString()
      }, targetAccountId);
      broadcast('revocation:notice', {
        scope: payload.scope,
        targetId: payload.targetId,
        reason: payload.reason,
        timestamp: new Date().toISOString()
      }, targetAccountId);
      return true;
    } else if (event.event_type === 'SUBSCRIPTION_EXPIRED') {
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
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
      const payload = typeof event.payload === 'string' ? JSON.parse(event.payload) : event.payload;
      
      const isExplicitPaystack = payload._provider === 'paystack' || payload.provider === 'paystack';
      const isExplicitFlw = payload._provider === 'flutterwave' || payload.provider === 'flutterwave';
      const isFlw = isExplicitFlw || (!isExplicitPaystack && Boolean(payload.data?.flw_ref || (!payload.data?.channel && !payload.data?.authorization && payload.data?.charged_amount)));
      const isFlwSuccess = (event.event_type === 'charge.completed' || event.event_type === 'PAYMENT_SUCCESS') && (payload.data?.status === 'successful' || !payload.data?.status);
      const isPaystackSuccess = event.event_type === 'charge.success' || event.event_type === 'PAYMENT_SUCCESS';

      // 1. Success charge processing
      if (isPaystackSuccess || isFlwSuccess) {
        const accountId = payload.data?.meta?.account_id || payload.data?.metadata?.account_id || payload.account_id;
        console.log(`✓ Processing successful payment for account: ${accountId}`);
        
        if (accountId) {
          const planId = payload.data?.meta?.plan_id || payload.data?.metadata?.plan_id || payload.plan_id || 'PRO';
          const ref = payload.data?.tx_ref || payload.data?.reference || `ref-${Date.now()}`;
          const billingInterval = (payload.data?.meta?.billing_interval || payload.data?.metadata?.billing_interval || 'monthly').toLowerCase();
          
          let majorAmount;
          if (isFlw) {
            majorAmount = Number(payload.data?.charged_amount || payload.data?.amount || 10000);
          } else {
            const rawAmount = payload.data?.amount || 1000000;
            majorAmount = (typeof rawAmount === 'number' && rawAmount >= 100) ? (rawAmount / 100) : rawAmount;
          }

          const providerSubId = payload.data?.subscription_code || payload.data?.flw_ref || `sub-${ref}`;
          const { applyPaymentSuccess } = await import('../domain/billing/service.mjs');
          await applyPaymentSuccess(client, {
            accountId,
            planId,
            billingInterval,
            amount: majorAmount,
            reference: ref,
            receiptUrl: payload.data?.receipt_url || null,
            providerSubId
          });
        }
      } else if (
        event.event_type === 'charge.failed' || 
        event.event_type === 'PAYMENT_FAILED' ||
        (event.event_type === 'charge.completed' && payload.data?.status && payload.data?.status !== 'successful') ||
        event.event_type.includes('fail') ||
        event.event_type.includes('declined')
      ) {
        const accountId = payload.data?.meta?.account_id || payload.data?.metadata?.account_id || payload.account_id;
        const reason = payload.data?.gateway_response || payload.data?.processor_response || payload.reason || 'Payment declined by bank';
        console.warn(`⚠ Processing failed/declined payment for account ${accountId}: ${reason}`);
        
        if (accountId) {
          // Mark subscription as PAST_DUE on failed charge
          await client.query(
            "UPDATE subscriptions SET status = 'PAST_DUE' WHERE account_id = $1 AND status = 'ACTIVE'",
            [accountId]
          );

          // Audit log the failed payment attempt
          const { logEvent } = await import('../domain/audit/service.mjs');
          const providerName = isFlw ? 'flutterwave' : 'paystack';
          await logEvent(client, {
            accountId,
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
              accountId,
              subscription: {
                status: 'PAST_DUE'
              },
              timestamp: new Date().toISOString()
            }, accountId);
          } catch (wsErr) {
            // Non-critical if websocket is not active
          }
        }
      }
    }
    return true;
  });
}

export async function startWorker() {
  console.log(`Starting Outbox Worker ${WORKER_ID}`);
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
        console.log(`Processing outbox event: ${event.event_id}`);
        let success = false;
        try {
          success = await processOutboxEvent(event);
        } catch (procErr) {
          console.error(`Error processing outbox event ${event.event_id}:`, procErr);
          success = false;
        } finally {
          try {
            await completeEvent(event.event_id, success);
          } catch (completeErr) {
            console.error(`Failed to complete outbox event ${event.event_id}:`, completeErr);
          }
        }
      }
    } catch (err) {
      console.error('Outbox worker loop error:', err);
    } finally {
      isRunning = false;
    }
  };

  return setInterval(runDrainCycle, 5000); // Poll every 5s
}
