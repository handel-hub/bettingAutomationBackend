// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import { sign, verify } from '../src/crypto/ed25519.mjs';
import { sha256, hashPassword } from '../src/crypto/hashing.mjs';
import { serializeClientRequest, serializeBackendResponse } from '../src/protocol/canonical.mjs';
import { validateEnvelope, buildEnvelope } from '../src/protocol/envelope.mjs';
import { consumeNonce } from '../src/protocol/nonce.mjs';
import { createAdminUser, adminLogin, verifyAdminSession, generateTotp } from '../src/admin/service.mjs';
import { recordRevocation, checkCircuitBreaker, isCircuitBreakerTripped } from '../src/domain/revocation/circuit-breaker.mjs';
import { reconcile } from '../src/domain/reconciliation/service.mjs';
import { getSystemEpoch, setSystemEpoch, advanceSystemEpoch } from '../src/domain/system/epoch-store.mjs';
import { initializePaymentAdapter } from '../src/adapters/payment/adapter.mjs';
import { getProvider } from '../src/domain/payment/provider.mjs';
import { getPool, closePool } from '../src/persistence/connection.mjs';
import { scheduleSubscriptions } from '../src/jobs/subscription-scheduler.mjs';
import { handleWebhook } from '../src/domain/payment/webhook-handler.mjs';
import { httpServer } from '../src/server.mjs';

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

let pool;
let testAccountId;
let testSessionId;
let testMachineId;
let testClientKeyPair;
let testClientPubHex;

before(async () => {
  if (!httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.listen(PORT, () => resolve(null));
    });
  }

  pool = getPool();

  // Clean up any test artifacts
  await pool.query("DELETE FROM machines WHERE descriptor->>'hostname' = 'remediation-test'");

  // Ensure an active account exists
  const accRes = await pool.query('SELECT account_id FROM accounts LIMIT 1');
  testAccountId = accRes.rows[0].account_id;

  // Generate Ed25519 client keypair
  testClientKeyPair = crypto.generateKeyPairSync('ed25519');
  const spki = testClientKeyPair.publicKey.export({ type: 'spki', format: 'der' });
  testClientPubHex = spki.subarray(spki.length - 32).toString('hex');

  // Create machine
  const machRes = await pool.query(`
    INSERT INTO machines (account_id, installation_id, public_key_hex, descriptor, status)
    VALUES ($1, 'remediation-inst-1', $2, '{"hostname": "remediation-test"}', 'REGISTERED')
    RETURNING machine_id
  `, [testAccountId, testClientPubHex]);
  testMachineId = machRes.rows[0].machine_id;

  // Initialize machine_session_states
  await pool.query(`
    INSERT INTO machine_session_states (account_id, machine_id, session_generation, authorization_revision, machine_generation)
    VALUES ($1, $2, 1, 1, 1)
    ON CONFLICT (account_id, machine_id) DO NOTHING
  `, [testAccountId, testMachineId]);

  // Create active session
  const sessRes = await pool.query(`
    INSERT INTO sessions (account_id, machine_id, status, renew_after, expires_at)
    VALUES ($1, $2, 'AUTHENTICATED', now() + interval '30 minutes', now() + interval '1 day')
    RETURNING session_id
  `, [testAccountId, testMachineId]);
  testSessionId = sessRes.rows[0].session_id;
});

test('Audit Remediation Verification Suite (12 Core Scenarios)', async (t) => {

  // Scenario 1: CP Protocol Wire Interop Test
  await t.test('1. Wire Interop: RFC 8785 Canonical Serializer and CONTROL_PLANE_V1 Domain Separation', async () => {
    const nonce = `nonce-wire-${Date.now()}`;
    const timestamp = new Date().toISOString();
    const reqEnvelope = {
      version: 2,
      sessionId: testSessionId,
      machineId: testMachineId,
      nonce,
      timestamp,
      clientGeneration: 1,
      clientServerEpoch: 1,
      payload: { action: 'PING', data: { test: true } }
    };

    // Serialize matching CP CanonicalSerializer (RFC 8785)
    const serialized = serializeClientRequest(reqEnvelope);
    const domainPrefix = Buffer.from('CONTROL_PLANE_V1', 'utf8');
    const toSign = Buffer.concat([domainPrefix, serialized]);
    const sig = sign(testClientKeyPair.privateKey, toSign);
    reqEnvelope.signature = sig;

    // Validate using Backend's validateEnvelope
    const validated = await validateEnvelope(reqEnvelope);
    assert.strictEqual(validated.isValid, true, 'Envelope must validate successfully');
    assert.strictEqual(validated.machine.machine_id, testMachineId);

    // Validate Backend Response formatting
    const respEnvelope = await buildEnvelope({ pong: true }, 1);
    assert.ok(respEnvelope.signatures['1'], 'Response must have signature for key 1');
    assert.strictEqual(respEnvelope.server_epoch, 1);
  });

  // Scenario 2: Cold-Boot Machine Registration & Login Test
  await t.test('2. Cold-Boot Machine Registration without Session & Operator Binding', async () => {
    const coldKeyPair = crypto.generateKeyPairSync('ed25519');
    const spki = coldKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const coldPubHex = spki.subarray(spki.length - 32).toString('hex');
    const installationId = `inst_hw_${Date.now()}`;
    const hardwareId = `hw_${Date.now()}`;

    // Control Plane cold-boot self-signature format: Buffer.from(`REGISTRATION:${hardwareId}`)
    const regMsg = Buffer.from(`REGISTRATION:${hardwareId}`, 'utf8');
    const selfSig = sign(coldKeyPair.privateKey, regMsg);

    // Call /api/v1/machines/register without session
    const regRes = await fetch(`${BASE_URL}/machines/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        installationId,
        publicKeyHex: coldPubHex,
        descriptor: { hardwareId, os: 'win32', hostname: 'remediation-test' },
        selfSignature: selfSig
      })
    });
    assert.strictEqual(regRes.status, 200, 'Cold-boot registration must succeed');
    const regData = await regRes.json();
    assert.ok(regData.machineId, 'Must return machineId');
    const coldMachineId = regData.machineId;

    // Verify machine is initially unassigned (account_id is null)
    const machCheck = await pool.query('SELECT account_id, status FROM machines WHERE machine_id = $1', [coldMachineId]);
    assert.strictEqual(machCheck.rows[0].account_id, null, 'Machine account_id must be null on cold-boot registration');

    // Operator login binds this machine
    const loginRes = await fetch(`${BASE_URL}/auth/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'tester@bettingautomation.com',
        password: 'Password123!',
        machineId: coldMachineId
      })
    });
    assert.strictEqual(loginRes.status, 200, 'Login with registered machine must succeed');
    const loginData = await loginRes.json();
    assert.strictEqual(loginData.payload.status, 'AUTHENTICATED');
    assert.ok(loginData.payload.sessionId);
    assert.ok(loginData.payload.license);
    assert.ok(loginData.payload.capabilities);

    // Verify machine is now bound to operator account
    const boundCheck = await pool.query('SELECT account_id FROM machines WHERE machine_id = $1', [coldMachineId]);
    assert.ok(boundCheck.rows[0].account_id, 'Machine must now be bound to operator account');
  });

  // Scenario 3: Operator Auth Isolation Test
  await t.test('3. Operator Auth Isolation: Rejection of Spoofed Headers and Unauthenticated Fallbacks', async () => {
    // Attempt spoofing via x-account-id
    const spoofRes = await fetch(`${BASE_URL}/accounts`, {
      method: 'GET',
      headers: {
        'x-account-id': testAccountId,
        'Content-Type': 'application/json'
      }
    });
    assert.strictEqual(spoofRes.status, 401, 'Spoofed x-account-id must return 401');

    // Attempt unauthenticated request
    const unauthRes = await fetch(`${BASE_URL}/accounts`, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' }
    });
    assert.strictEqual(unauthRes.status, 401, 'Unauthenticated request must return 401');

    // Valid bearer session must succeed
    const authRes = await fetch(`${BASE_URL}/accounts?limit=5`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${testSessionId}`,
        'Content-Type': 'application/json'
      }
    });
    assert.strictEqual(authRes.status, 200, 'Authenticated request with valid session token must succeed');
  });

  // Scenario 4: Admin RBAC & MFA Test
  await t.test('4. Admin RBAC & MFA Authentication', async () => {
    // Backdoor token must be rejected
    const backdoorRes = await fetch(`${BASE_URL}/admin/overview`, {
      headers: { 'Authorization': 'Bearer supersecret_admin' }
    });
    assert.strictEqual(backdoorRes.status, 401, 'Hardcoded backdoor admin token must be rejected');

    // Create real admin user
    const adminEmail = `admin_${Date.now()}@bettingautomation.com`;
    const mfaSecret = 'JBSWY3DPEHPK3PXP'; // Base32 test secret
    await createAdminUser(adminEmail, 'SecureAdminPass123!', 'SUPER_ADMIN', mfaSecret);

    // Compute TOTP
    const totpToken = generateTotp(mfaSecret);

    // Admin login
    const loginResult = await adminLogin(adminEmail, 'SecureAdminPass123!', totpToken);
    assert.ok(loginResult.sessionId, 'Must return admin session ID');
    assert.strictEqual(loginResult.admin.role, 'SUPER_ADMIN');

    // Verify session
    const verifiedAdmin = await verifyAdminSession(loginResult.sessionId);
    assert.strictEqual(verifiedAdmin.email, adminEmail);
    assert.strictEqual(verifiedAdmin.role, 'SUPER_ADMIN');
  });

  // Scenario 5: File Transfer Service Quarantine Test
  await t.test('5. File Transfer Service: Quarantine & 404 Endpoint Verification', async () => {
    const initRes = await fetch(`${BASE_URL}/transfers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testSessionId}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileId: 'engine_binary.zip',
        totalSize: 1048576
      })
    });
    assert.strictEqual(initRes.status, 404, 'Quarantined /transfers endpoint must return 404');

    const statusRes = await fetch(`${BASE_URL}/transfers/non-existent-session/status`, {
      headers: { 'Authorization': `Bearer ${testSessionId}` }
    });
    assert.strictEqual(statusRes.status, 404, 'Quarantined status endpoint must return 404');
  });

  // Scenario 6: Automation Config PUT Endpoint Test
  await t.test('6. Automation Config PUT Endpoint Support', async () => {
    const putRes = await fetch(`${BASE_URL}/automation/config/risk`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${testSessionId}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: {
          maxStake: 50000,
          dailyStopLoss: 100000
        }
      })
    });
    assert.strictEqual(putRes.status, 200, 'PUT /automation/config/:category must succeed');
    const putData = await putRes.json();
    assert.strictEqual(putData.globalConfig.risk.maxStake, 50000);
  });

  // Scenario 7: External Server Epoch & Restore Test
  await t.test('7. External Monotonic Server Epoch Store & DB Restore vs Forgery', async () => {
    // Advance external server epoch to 10
    setSystemEpoch(10);
    assert.strictEqual(getSystemEpoch(), 10);

    // Case 1: Client presents older epoch (8) with higher generation -> Legitimate DB restore
    const restoreResult = await reconcile(testMachineId, 999, 8);
    assert.strictEqual(restoreResult.resolution, 'DB_RESTORED');
    assert.strictEqual(restoreResult.action, 'FORCE_SYNC');

    // Verify machine is NOT revoked
    const machCheck = await pool.query('SELECT status FROM machines WHERE machine_id = $1', [testMachineId]);
    assert.strictEqual(machCheck.rows[0].status, 'REGISTERED', 'Machine must NOT be revoked on DB restore');

    // Case 2: Client presents current epoch (10) with higher generation -> Genuine Forgery
    const forgeryResult = await reconcile(testMachineId, 999, 10);
    assert.strictEqual(forgeryResult.resolution, 'FORGERY_SUSPECTED');
    assert.strictEqual(forgeryResult.action, 'REVOKE_MACHINE');

    // Reset machine status and epoch for remaining tests
    await pool.query("UPDATE machines SET status = 'REGISTERED' WHERE machine_id = $1", [testMachineId]);
    setSystemEpoch(1);
  });

  // Scenario 8: WebSocket Tenancy Test
  await t.test('8. WebSocket Tenancy & Unauthorized Handshake Rejection', async () => {
    // Unauthenticated connection should be closed immediately with 1008
    const unauthWs = new WebSocket(`ws://localhost:${PORT}/ws/v1/events`);
    const rejected = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { unauthWs.terminate(); } catch {}
        resolve(false);
      }, 3000);
      unauthWs.on('error', () => {
        clearTimeout(timer);
        resolve(true);
      });
      unauthWs.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 1008 || code === 4001 || code === 1006 || code === 1000);
      });
    });
    assert.strictEqual(rejected, true, 'Unauthenticated WebSocket connection must be rejected');

    // Authenticated connection
    const authWs = new WebSocket(`ws://localhost:${PORT}/ws/v1/events?session=${testSessionId}`);
    const connected = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { authWs.terminate(); reject(new Error('WS timeout')); }, 3000);
      authWs.on('open', () => {
        clearTimeout(timer);
        authWs.close();
        resolve(true);
      });
      authWs.on('error', reject);
    });
    assert.strictEqual(connected, true, 'Authenticated WebSocket connection must succeed');
  });

  // Scenario 9: Revocation & Authorization Race Test
  await t.test('9. Revocation and Authorization Concurrency / Race Safety', async () => {
    const { resolve } = await import('../src/domain/authorization/service.mjs');
    const { revoke } = await import('../src/domain/revocation/service.mjs');

    // Concurrently resolve authorization and revoke session
    const [authRes, revRes] = await Promise.allSettled([
      resolve(testSessionId, { ['bet:place']: true }),
      revoke('SESSION', testSessionId, 'Race test revocation')
    ]);

    // Query active authorizations for this session
    const activeAuth = await pool.query(
      "SELECT status FROM authorizations WHERE session_id = $1 AND status = 'VALID'",
      [testSessionId]
    );

    // If session was revoked, there must be NO valid authorizations
    const sessStatus = await pool.query('SELECT status FROM sessions WHERE session_id = $1', [testSessionId]);
    if (sessStatus.rows[0].status === 'REVOKED') {
      assert.strictEqual(activeAuth.rows.length, 0, 'No VALID authorization may remain on revoked session');
    }

    // Restore session to AUTHENTICATED for subsequent tests
    await pool.query("UPDATE sessions SET status = 'AUTHENTICATED' WHERE session_id = $1", [testSessionId]);
  });

  // Scenario 10: Circuit Breaker Durability Test
  await t.test('10. Circuit Breaker Durability Across Aborted Transactions', async () => {
    // Reset circuit breaker state for clean test
    await pool.query('DELETE FROM revocation_circuit_breaker');

    // Execute within an explicit transaction that gets ROLLED BACK
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < 12; i++) {
        await recordRevocation(client);
      }
      // Explicitly ROLL BACK the caller transaction
      await client.query('ROLLBACK');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    // Check circuit breaker status: autonomous connection must have committed its increments
    const cbStatus = await isCircuitBreakerTripped(pool);
    assert.strictEqual(cbStatus.tripped, true, 'Circuit breaker must trip and persist even when caller transaction ROLLS BACK');
    assert.ok(cbStatus.count >= 10, 'Revocation count must be preserved across caller rollback');
  });

  // Scenario 11: Raw Body Webhook HMAC Verification
  await t.test('11. Raw Body Webhook HMAC Verification', async () => {
    const secretKey = 'sk_test_remediation_webhook_secret_key';
    initializePaymentAdapter(secretKey);
    const provider = getProvider();

    // Raw payload with formatting/newlines
    const rawPayload = Buffer.from('{\n  "event": "charge.success",\n  "data": {\n    "id": 9999\n  }\n}', 'utf8');
    const validHmac = crypto.createHmac('sha512', secretKey).update(rawPayload).digest('hex');

    // Verify valid HMAC
    assert.strictEqual(provider.verifyWebhookSignature(rawPayload, validHmac), true);

    // Verify invalid HMAC fails
    const invalidHmac = crypto.createHmac('sha512', 'wrong_secret').update(rawPayload).digest('hex');
    assert.strictEqual(provider.verifyWebhookSignature(rawPayload, invalidHmac), false);
  });

  // Scenario 12: Fatal Protocol Error Codes Test
  await t.test('12. Fatal Protocol Error Codes and Envelopes', async () => {
    const testNonce = `fatal-nonce-${Date.now()}`;
    const epoch = 1;

    // First consumption succeeds
    await consumeNonce(testNonce, epoch);

    // Replay throws explicit NONCE_REPLAYED with code and status
    try {
      await consumeNonce(testNonce, epoch);
      assert.fail('Expected NONCE_REPLAYED error');
    } catch (err) {
      assert.strictEqual(err.code, 'NONCE_REPLAYED');
      assert.strictEqual(err.status, 403);
    }
  });

  // Scenario 13: Subscription Expiry Scheduler Sweeps CANCELLED and PAST_DUE (CAN-11 / DEF-11)
  await t.test('13. Subscription Expiry Scheduler: Sweeps CANCELLED and PAST_DUE with Expiration & Outbox Cascades', async () => {
    // Create dedicated account for scheduler test
    const accResult = await pool.query(`
      INSERT INTO accounts (email, credentials_hash, status, lockout_count, last_event_hash)
      VALUES ($1, 'dummy_hash', 'ACTIVE', 0, 'dummy_hash')
      RETURNING account_id
    `, [`sched-test-${Date.now()}@example.com`]);
    const accId = accResult.rows[0].account_id;

    // Create subscriptions in CANCELLED and PAST_DUE with past current_period_end
    const subPastDate = new Date(Date.now() - 3600000); // 1 hour ago
    const subStartDate = new Date(Date.now() - 86400000 * 30); // 30 days ago
    const provCan = `sub_can_${Date.now()}`;
    const provPast = `sub_past_${Date.now()}`;
    await pool.query(`
      INSERT INTO subscriptions (account_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end)
      VALUES 
        ($1, $4, 'pro', 'CANCELLED', $2, $3),
        ($1, $5, 'pro', 'PAST_DUE', $2, $3)
    `, [accId, subStartDate, subPastDate, provCan, provPast]);

    // Create a license and authorization that should be cascaded
    const licRes = await pool.query(`
      INSERT INTO licenses (account_id, status, plan_id, capabilities, limits, license_revision, expires_at)
      VALUES ($1, 'VALID', 'pro', '["CAP_AUTOMATION_START"]'::jsonb, '{}'::jsonb, 1, now() + interval '1 day')
      RETURNING license_id
    `, [accId]);
    const licId = licRes.rows[0].license_id;

    const machKeyHex = crypto.randomBytes(32).toString('hex');
    const machRes = await pool.query(`
      INSERT INTO machines (account_id, installation_id, public_key_hex, descriptor, status)
      VALUES ($1, $2, $3, '{"hostname": "sched-test"}', 'REGISTERED')
      RETURNING machine_id
    `, [accId, `sched-inst-${Date.now()}`, machKeyHex]);
    const machId = machRes.rows[0].machine_id;

    const sessRes = await pool.query(`
      INSERT INTO sessions (account_id, machine_id, status, renew_after, expires_at)
      VALUES ($1, $2, 'AUTHENTICATED', now() + interval '30 minutes', now() + interval '1 day')
      RETURNING session_id
    `, [accId, machId]);
    const sessId = sessRes.rows[0].session_id;

    await pool.query(`
      INSERT INTO authorizations (account_id, session_id, license_id, status, capability_set, observed_license_revision, expires_at)
      VALUES ($1, $2, $3, 'VALID', '["AUTOMATION_START"]'::jsonb, 1, now() + interval '1 day')
    `, [accId, sessId, licId]);

    // Run scheduler
    await scheduleSubscriptions(pool);

    // Verify both subscriptions are now EXPIRED
    const subsRes = await pool.query('SELECT status FROM subscriptions WHERE account_id = $1', [accId]);
    assert.strictEqual(subsRes.rows.length, 2);
    for (const row of subsRes.rows) {
      assert.strictEqual(row.status, 'EXPIRED');
    }

    // Verify license cascaded to EXPIRED
    const licCheck = await pool.query('SELECT status FROM licenses WHERE license_id = $1', [licId]);
    assert.strictEqual(licCheck.rows[0].status, 'EXPIRED');

    // Verify authorization cascaded to REVOKED
    const authCheck = await pool.query('SELECT status FROM authorizations WHERE license_id = $1', [licId]);
    assert.strictEqual(authCheck.rows[0].status, 'REVOKED');

    // Verify outbox events contain SUBSCRIPTION_EXPIRED and LICENSE_REVOKED
    const outboxCheck = await pool.query(`
      SELECT event_type FROM outbox_events 
      WHERE payload->>'accountId' = $1
    `, [accId]);
    const eventTypes = outboxCheck.rows.map(r => r.event_type);
    assert.ok(eventTypes.includes('SUBSCRIPTION_EXPIRED'));
    assert.ok(eventTypes.includes('LICENSE_REVOKED'));
  });

  await t.test('14. CAN-21: Partial Unique Constraints enforce single active subscription and valid license', async () => {
    const accId = crypto.randomUUID();
    const genHash = sha256(`acc-can21-${Date.now()}`);
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status, lockout_count, last_event_hash)
      VALUES ($1, $2, 'hash', 'ACTIVE', 0, $3)
    `, [accId, `can21_${Date.now()}@test.io`, genHash]);

    // 1. Insert first active subscription -> SUCCESS
    const sub1 = `sub_active_1_${Date.now()}`;
    await pool.query(`
      INSERT INTO subscriptions (account_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end)
      VALUES ($1, $2, 'pro', 'ACTIVE', now(), now() + interval '30 days')
    `, [accId, sub1]);

    // 2. Attempt to insert second active subscription -> MUST FAIL with unique constraint violation 23505
    const sub2 = `sub_active_2_${Date.now()}`;
    await assert.rejects(async () => {
      await pool.query(`
        INSERT INTO subscriptions (account_id, provider_subscription_id, plan_id, status, current_period_start, current_period_end)
        VALUES ($1, $2, 'pro', 'ACTIVE', now(), now() + interval '30 days')
      `, [accId, sub2]);
    }, (err) => {
      assert.strictEqual(err.code, '23505');
      return true;
    });

    // 3. Insert first valid license -> SUCCESS
    const lic1 = crypto.randomUUID();
    await pool.query(`
      INSERT INTO licenses (license_id, account_id, plan_id, status, capabilities, limits)
      VALUES ($1, $2, 'pro', 'VALID', '[]'::jsonb, '{}'::jsonb)
    `, [lic1, accId]);

    // 4. Attempt to insert second valid license -> MUST FAIL with unique constraint violation 23505
    const lic2 = crypto.randomUUID();
    await assert.rejects(async () => {
      await pool.query(`
        INSERT INTO licenses (license_id, account_id, plan_id, status, capabilities, limits)
        VALUES ($1, $2, 'pro', 'VALID', '[]'::jsonb, '{}'::jsonb)
      `, [lic2, accId]);
    }, (err) => {
      assert.strictEqual(err.code, '23505');
      return true;
    });
  });

  await t.test('15. CAN-22: Webhook Idempotency & Concurrent Replay Protection', async () => {
    const accId = crypto.randomUUID();
    const genHash = sha256(`acc-can22-${Date.now()}`);
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status, lockout_count, last_event_hash)
      VALUES ($1, $2, 'hash', 'ACTIVE', 0, $3)
    `, [accId, `can22_${Date.now()}@test.io`, genHash]);

    const providerEventId = `evt_paystack_${Date.now()}`;
    const idempotencyKey = `idem_${Date.now()}`;
    const webhookPayload = { event: 'charge.success', data: { reference: `ref_${Date.now()}` } };

    // First delivery -> enqueues successfully
    const firstRes = await handleWebhook('paystack', providerEventId, 'charge.success', accId, idempotencyKey, webhookPayload);
    assert.strictEqual(firstRes.success, true);

    // Verify exactly one payment_event and outbox_event created
    const payRes1 = await pool.query('SELECT event_id FROM payment_events WHERE provider_event_id = $1', [providerEventId]);
    assert.strictEqual(payRes1.rows.length, 1);

    const outboxRes1 = await pool.query('SELECT event_id FROM outbox_events WHERE idempotency_key = $1', [idempotencyKey]);
    assert.strictEqual(outboxRes1.rows.length, 1);

    // Duplicate replay delivery with same providerEventId -> returns { skipped: true, duplicate: true }
    const dupRes1 = await handleWebhook('paystack', providerEventId, 'charge.success', accId, `new_key_${Date.now()}`, webhookPayload);
    assert.strictEqual(dupRes1.skipped, true);
    assert.strictEqual(dupRes1.duplicate, true);

    // Duplicate replay delivery with same idempotencyKey -> returns { skipped: true, duplicate: true }
    const dupRes2 = await handleWebhook('paystack', `new_evt_${Date.now()}`, 'charge.success', accId, idempotencyKey, webhookPayload);
    assert.strictEqual(dupRes2.skipped, true);
    assert.strictEqual(dupRes2.duplicate, true);

    // Verify still exactly one payment_event and outbox_event
    const payRes2 = await pool.query('SELECT event_id FROM payment_events WHERE provider_event_id = $1', [providerEventId]);
    assert.strictEqual(payRes2.rows.length, 1);

    const outboxRes2 = await pool.query('SELECT event_id FROM outbox_events WHERE idempotency_key = $1', [idempotencyKey]);
    assert.strictEqual(outboxRes2.rows.length, 1);
  });

  await t.test('16. CAN-10: Anonymous machine binding enforces license seat limits upon login', async () => {
    const accId = crypto.randomUUID();
    const email = `can10_${Date.now()}@test.io`;
    const password = 'Password123!';
    const passwordHash = await hashPassword(password);
    const genHash = sha256(`acc-can10-${Date.now()}`);
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status, lockout_count, last_event_hash)
      VALUES ($1, $2, $3, 'ACTIVE', 0, $4)
    `, [accId, email, passwordHash, genHash]);

    // Issue a license with max_machines = 1
    const licenseId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO licenses (license_id, account_id, plan_id, status, capabilities, limits)
      VALUES ($1, $2, 'starter', 'VALID', '[]'::jsonb, '{"max_machines": 1}'::jsonb)
    `, [licenseId, accId]);

    // Already bind one machine to this account
    const boundMachineId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO machines (machine_id, installation_id, account_id, public_key_hex, status, descriptor)
      VALUES ($1, $2, $3, 'pub1', 'REGISTERED', '{"hostname":"remediation-test"}'::jsonb)
    `, [boundMachineId, `inst_bound_${Date.now()}`, accId]);

    // Register an anonymous machine without account_id
    const anonMachineId = crypto.randomUUID();
    await pool.query(`
      INSERT INTO machines (machine_id, installation_id, account_id, public_key_hex, status, descriptor)
      VALUES ($1, $2, NULL, 'pub_anon', 'REGISTERED', '{"hostname":"remediation-test"}'::jsonb)
    `, [anonMachineId, `inst_anon_${Date.now()}`]);

    // Attempt to authenticate / bind the anonymous machine -> Must fail with SEAT_LIMIT_EXCEEDED
    const { authenticate } = await import('../src/app/authenticate.mjs');
    await assert.rejects(async () => {
      await authenticate(email, password, anonMachineId, 2, 'nonce-can10');
    }, (err) => {
      assert.ok(err.message.includes('SEAT_LIMIT_EXCEEDED') || err.code === 'SEAT_LIMIT_EXCEEDED');
      return true;
    });

    // Verify the machine is still NOT bound
    const checkRes = await pool.query('SELECT account_id FROM machines WHERE machine_id = $1', [anonMachineId]);
    assert.strictEqual(checkRes.rows[0].account_id, null);
  });
});

after(async () => {
  setSystemEpoch(1);
  if (pool) {
    await pool.query("DELETE FROM machines WHERE descriptor->>'hostname' = 'remediation-test'");
  }
  if (httpServer.listening) {
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
});
