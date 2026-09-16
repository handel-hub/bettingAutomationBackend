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
          
          // Fetch entitlements for capabilities & limits
          let capabilities = ['CAP_AUTOMATION_START', 'CAP_AUTOMATION_STOP', 'CAP_FILE_UPLOAD', 'CAP_TACTICAL_BET', 'CAP_CASH_OUT'];
          let limits = { max_machines: 5, max_concurrent_browsers: 5, risk_tier: 'LOW' };
          try {
            const entRes = await client.query('SELECT capabilities, limits FROM plan_entitlements WHERE plan_id = $1', [planId]);
            if (entRes.rows.length > 0) {
              capabilities = entRes.rows[0].capabilities || capabilities;
              limits = entRes.rows[0].limits || limits;
            }
          } catch (e) {
            // Fallback
          }
          
          // 1. Ensure subscription row exists and is ACTIVE
          const subCheck = await client.query('SELECT subscription_id FROM subscriptions WHERE account_id = $1', [accountId]);
          if (subCheck.rows.length > 0) {
            await client.query(
              "UPDATE subscriptions SET status = 'ACTIVE', plan_id = $1, current_period_end = now() + interval '30 days', updated_at = now() WHERE account_id = $2",
              [planId, accountId]
            );
          } else {
            const providerSubId = payload.data?.subscription_code || payload.data?.flw_ref || `sub-${ref}`;
            await client.query(`
              INSERT INTO subscriptions (account_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end)
              VALUES ($1, $2, $3, 'ACTIVE', now(), now() + interval '30 days')
            `, [accountId, providerSubId, planId]);
          }
          
          // 2. Ensure license row exists and is VALID
          const licCheck = await client.query('SELECT license_id FROM licenses WHERE account_id = $1', [accountId]);
          if (licCheck.rows.length > 0) {
            await client.query(`
              UPDATE licenses 
              SET status = 'VALID', plan_id = $1, capabilities = $2, limits = $3, expires_at = now() + interval '30 days',
                  license_revision = license_revision + 1, updated_at = now()
              WHERE account_id = $4
            `, [planId, JSON.stringify(capabilities), JSON.stringify(limits), accountId]);
          } else {
            await client.query(`
              INSERT INTO licenses (account_id, plan_id, status, capabilities, limits, issued_at, expires_at, license_revision)
              VALUES ($1, $2, 'VALID', $3, $4, now(), now() + interval '30 days', 1)
            `, [accountId, planId, JSON.stringify(capabilities), JSON.stringify(limits)]);
          }

          // 3. Persist invoice record in invoices table with normalized currency amount and statutory VAT
          let majorAmount;
          if (isFlw) {
            majorAmount = Number(payload.data?.charged_amount || payload.data?.amount || 10000);
          } else {
            const rawAmount = payload.data?.amount || 1000000;
            majorAmount = (typeof rawAmount === 'number' && rawAmount >= 100) ? (rawAmount / 100) : rawAmount;
          }
          const invId = `inv-${ref}`;
          const taxRate = 0.075;
          const subtotal = Math.round((majorAmount / (1 + taxRate)) * 100) / 100;
          const taxAmount = Math.round((majorAmount - subtotal) * 100) / 100;
          const billingInterval = payload.data?.meta?.billing_interval || payload.data?.metadata?.billing_interval || 'monthly';
          const planNameResolved = planId ? (planId.charAt(0).toUpperCase() + planId.slice(1).toLowerCase()) : 'Pro';

          await client.query(`
            INSERT INTO invoices (
              id, account_id, reference, amount, currency, status, paid_at, receipt_url,
              subtotal, tax_amount, tax_rate, plan_name, billing_interval, currency_symbol
            )
            VALUES ($1, $2, $3, $4, 'NGN', 'Paid', now(), $5, $6, $7, $8, $9, $10, '₦')
            ON CONFLICT (id) DO UPDATE SET
              status = 'Paid',
              paid_at = now(),
              subtotal = EXCLUDED.subtotal,
              tax_amount = EXCLUDED.tax_amount,
              tax_rate = EXCLUDED.tax_rate,
              plan_name = EXCLUDED.plan_name,
              billing_interval = EXCLUDED.billing_interval,
              currency_symbol = EXCLUDED.currency_symbol
          `, [invId, accountId, ref, majorAmount, payload.data?.receipt_url || null, subtotal, taxAmount, taxRate, planNameResolved, billingInterval]);
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
