// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';
import { FlutterwaveAdapter } from '../src/adapters/payment/flutterwave-adapter.mjs';
import { initializePaymentAdapter } from '../src/adapters/payment/adapter.mjs';
import { getProvider } from '../src/domain/payment/provider.mjs';
import { getPool, closePool } from '../src/persistence/connection.mjs';
import { claimNextEvent, processOutboxEvent, completeEvent } from '../src/outbox/worker.mjs';
import { httpServer } from '../src/server.mjs';

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}`;

before(async () => {
  if (!httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.listen(PORT, () => resolve(null));
    });
  }
});

after(async () => {
  if (httpServer.listening) {
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
});

test('Flutterwave v3 Payment Gateway Test Suite', async (t) => {
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_TEST_PAYMENT_STUB = 'true';

  const secretHash = 'flw_test_secret_hash_xyz_789';
  const secretKey = 'FLWSECK_TEST-mock-key-123';
  const flwAdapter = new FlutterwaveAdapter({
    secretKey,
    secretHash
  });

  // 1. Adapter Webhook Signature Verification
  await t.test('1. FlutterwaveAdapter: verif-hash verification with timing attack & length guard', () => {
    // Valid secret hash matches
    assert.strictEqual(flwAdapter.verifyWebhookSignature('', secretHash), true);

    // Invalid secret hash fails
    assert.strictEqual(flwAdapter.verifyWebhookSignature('', 'wrong_hash'), false);

    // Different length secret hash does NOT throw RangeError
    assert.doesNotThrow(() => {
      const res = flwAdapter.verifyWebhookSignature('', 'very_short');
      assert.strictEqual(res, false);
    });

    // Empty or missing signature fails
    assert.strictEqual(flwAdapter.verifyWebhookSignature('', ''), false);
    // @ts-ignore
    assert.strictEqual(flwAdapter.verifyWebhookSignature('', null), false);
  });

  // 2. Checkout Session Link Generation with Major Units & Guard Verification
  await t.test('2. FlutterwaveAdapter: createCheckoutSession produces valid URL in test stub mode and rejects mock keys when ALLOW_TEST_PAYMENT_STUB is disabled', async () => {
    const accountId = crypto.randomUUID();
    const planId = 'ENTERPRISE';
    const returnUrl = 'https://app.bettingautomation.io/billing/return';

    const checkoutUrl = await flwAdapter.createCheckoutSession(accountId, planId, returnUrl);
    assert.ok(checkoutUrl.startsWith('https://checkout.flutterwave.com/v3/hosted/pay/'));
    assert.ok(checkoutUrl.includes(`account=${accountId}`));
    assert.ok(checkoutUrl.includes(`plan=${planId}`));

    // Verify guard when ALLOW_TEST_PAYMENT_STUB is disabled
    try {
      process.env.ALLOW_TEST_PAYMENT_STUB = 'false';
      await assert.rejects(
        () => flwAdapter.createCheckoutSession(accountId, planId, returnUrl),
        /FlutterwaveAdapter mock checkout URL generation is forbidden/
      );
      assert.throws(
        () => initializePaymentAdapter('stub'),
        /Payment provider "stub" is forbidden/
      );
    } finally {
      process.env.ALLOW_TEST_PAYMENT_STUB = 'true';
    }
  });

  // 3. Multi-Provider Toggle Test
  await t.test('3. Multi-Provider Toggle: initializePaymentAdapter switches between providers', () => {
    // Switch to Flutterwave
    const flwProv = initializePaymentAdapter('flutterwave', {
      FLW_SECRET_KEY: secretKey,
      FLW_SECRET_HASH: secretHash
    });
    assert.ok(flwProv instanceof FlutterwaveAdapter);
    assert.strictEqual(getProvider(), flwProv);

    // Switch to Paystack
    const paystackProv = initializePaymentAdapter('paystack', {
      PAYSTACK_SECRET_KEY: 'sk_test_paystack_test_key_123'
    });
    assert.strictEqual(typeof paystackProv.createCheckoutSession, 'function');
    assert.strictEqual(getProvider(), paystackProv);

    // Switch to Stub (allowed when NODE_ENV=test && ALLOW_TEST_PAYMENT_STUB=true)
    const stubProv = initializePaymentAdapter('stub');
    assert.strictEqual(typeof stubProv.createCheckoutSession, 'function');
    assert.strictEqual(getProvider(), stubProv);

    // Re-initialize Flutterwave for subsequent HTTP tests
    initializePaymentAdapter('flutterwave', {
      FLW_SECRET_KEY: secretKey,
      FLW_SECRET_HASH: secretHash
    });
  });

  // 4. Webhook Route Authentication & Security Rejections
  await t.test('4. POST /api/v1/payments/webhook: verif-hash validation and rejection of invalid hashes', async () => {
    // 4a. Reject request without verif-hash
    const unauthRes = await fetch(`${BASE_URL}/api/v1/payments/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'charge.completed', data: { id: 12345 } })
    });
    assert.strictEqual(unauthRes.status, 400);
    const unauthData = await unauthRes.json();
    assert.strictEqual(unauthData.error, 'Invalid signature');

    // 4b. Reject request with invalid verif-hash
    const invalidRes = await fetch(`${BASE_URL}/api/v1/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'verif-hash': 'attacker_fake_hash'
      },
      body: JSON.stringify({ event: 'charge.completed', data: { id: 12345 } })
    });
    assert.strictEqual(invalidRes.status, 400);

    // 4c. Accept valid verif-hash with resolvable accountId
    const testAccId = crypto.randomUUID();
    const pool = getPool();
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status)
      VALUES ($1, $2, 'dummy_hash', 'ACTIVE')
    `, [testAccId, `webhook_acc_${Date.now()}@example.com`]);

    const validRes = await fetch(`${BASE_URL}/api/v1/payments/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'verif-hash': secretHash
      },
      body: JSON.stringify({
        event: 'charge.completed',
        data: {
          id: 998877,
          tx_ref: `flw_tx_webhook_${Date.now()}`,
          flw_ref: `FLW-MOCK-998877`,
          status: 'successful',
          amount: 25000,
          currency: 'NGN',
          meta: {
            account_id: testAccId,
            plan_id: 'PRO'
          }
        }
      })
    });
    assert.strictEqual(validRes.status, 200);
  });

  // 5. Outbox Worker: Successful Flutterwave Payment Activation
  await t.test('5. Outbox Worker: charge.completed (successful) activates subscription and creates major-unit invoice', async () => {
    const pool = getPool();
    const accountId = crypto.randomUUID();
    const email = `flw_user_${Date.now()}@example.com`;

    // Create account
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status)
      VALUES ($1, $2, 'dummy_hash', 'ACTIVE')
    `, [accountId, email]);

    // Clear stale pending/processing events
    await pool.query("UPDATE outbox_events SET status = 'DELIVERED' WHERE status IN ('PENDING', 'PROCESSING')");

    const txRef = `flw_tx_success_${Date.now()}`;
    const flwAmount = 25000; // ₦25,000 in major units
    const idempotencyKey = `evt-flw-succ-${Date.now()}`;

    const eventTxId = Date.now() + Math.floor(Math.random() * 1000);
    // Enqueue Flutterwave webhook outbox event
    await pool.query(`
      INSERT INTO outbox_events (event_type, payload, idempotency_key, status)
      VALUES ('charge.completed', $1, $2, 'PENDING')
    `, [JSON.stringify({
      event: 'charge.completed',
      data: {
        id: eventTxId,
        tx_ref: txRef,
        flw_ref: `FLW-${txRef}`,
        status: 'successful',
        amount: flwAmount,
        currency: 'NGN',
        meta: {
          account_id: accountId,
          plan_id: 'PRO'
        }
      }
    }), idempotencyKey]);

    // Claim and process
    const event = await claimNextEvent();
    assert.ok(event, 'Must claim pending outbox event');
    const processed = await processOutboxEvent(event);
    assert.strictEqual(processed, true, 'Processing must succeed');
    await completeEvent(event.event_id, true);

    // Verify subscription created and ACTIVE
    const subRes = await pool.query('SELECT * FROM subscriptions WHERE account_id = $1', [accountId]);
    assert.strictEqual(subRes.rows.length, 1);
    assert.strictEqual(subRes.rows[0].status, 'ACTIVE');
    assert.strictEqual(subRes.rows[0].plan_id, 'PRO');

    // Verify license created and VALID
    const licRes = await pool.query('SELECT * FROM licenses WHERE account_id = $1', [accountId]);
    assert.strictEqual(licRes.rows.length, 1);
    assert.strictEqual(licRes.rows[0].status, 'VALID');

    // Verify invoice created with exact major currency amount (₦25,000, NOT divided by 100!)
    const invRes = await pool.query('SELECT * FROM invoices WHERE reference = $1', [txRef]);
    assert.strictEqual(invRes.rows.length, 1);
    assert.strictEqual(Number(invRes.rows[0].amount), 25000, 'Invoice amount must equal 25000 NGN directly');
  });

  // 6. Outbox Worker: Failed Flutterwave Payment Handling (Card Decline)
  await t.test('6. Outbox Worker: charge.completed with status: failed marks subscription PAST_DUE and does not grant license', async () => {
    const pool = getPool();
    const accountId = crypto.randomUUID();
    const email = `flw_failed_${Date.now()}@example.com`;

    // Create account with initially active subscription
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status)
      VALUES ($1, $2, 'dummy_hash', 'ACTIVE')
    `, [accountId, email]);

    const priorSubId = `sub_prior_${Date.now()}`;
    await pool.query(`
      INSERT INTO subscriptions (account_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, 'PRO', 'ACTIVE', now(), now() + interval '30 days')
    `, [accountId, priorSubId]);

    // Clear stale pending/processing events
    await pool.query("UPDATE outbox_events SET status = 'DELIVERED' WHERE status IN ('PENDING', 'PROCESSING')");

    const txRef = `flw_tx_failed_${Date.now()}`;
    const idempotencyKey = `evt-flw-fail-${Date.now()}`;

    // Enqueue a failed Flutterwave charge.completed event
    await pool.query(`
      INSERT INTO outbox_events (event_type, payload, idempotency_key, status)
      VALUES ('charge.completed', $1, $2, 'PENDING')
    `, [JSON.stringify({
      event: 'charge.completed',
      data: {
        id: 771133,
        tx_ref: txRef,
        flw_ref: `FLW-${txRef}`,
        status: 'failed',
        processor_response: 'Insufficient Funds',
        amount: 25000,
        currency: 'NGN',
        meta: {
          account_id: accountId,
          plan_id: 'PRO'
        }
      }
    }), idempotencyKey]);

    // Claim and process
    const event = await claimNextEvent();
    assert.ok(event);
    const processed = await processOutboxEvent(event);
    assert.strictEqual(processed, true);
    await completeEvent(event.event_id, true);

    // Verify subscription status is marked PAST_DUE
    const subRes = await pool.query('SELECT status FROM subscriptions WHERE account_id = $1', [accountId]);
    assert.strictEqual(subRes.rows[0].status, 'PAST_DUE', 'Failed payment must mark subscription PAST_DUE');

    // Verify NO new license was issued
    const licRes = await pool.query('SELECT * FROM licenses WHERE account_id = $1', [accountId]);
    assert.strictEqual(licRes.rows.length, 0, 'No license must be granted for failed transaction');
  });

  // 7. Callback Route Test
  await t.test('7. GET /api/v1/payments/callback supports Flutterwave tx_ref and status query parameters', async () => {
    const res = await fetch(`${BASE_URL}/api/v1/payments/callback?tx_ref=flw_tx_12345&status=successful`);
    assert.strictEqual(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('Payment Processed!'));
    assert.ok(text.includes('flw_tx_12345'));
    assert.ok(text.includes('successful'));
  });
});
