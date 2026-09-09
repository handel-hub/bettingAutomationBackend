// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import { sign, verify } from '../src/crypto/ed25519.mjs';
import { sha256 } from '../src/crypto/hashing.mjs';
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

  // Scenario 5: File Transfer Service End-to-End Test
  await t.test('5. File Transfer Service: Initialize and Status Contract', async () => {
    const initRes = await fetch(`${BASE_URL}/transfers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${testSessionId}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fileId: 'engine_binary.zip',
        totalSize: 1048576,
        totalChunks: 2,
        chunkSize: 524288,
        contentHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      })
    });
    assert.strictEqual(initRes.status, 200, 'Transfer init must succeed');
    const initData = await initRes.json();
    assert.ok(initData.remoteSessionId, 'Must return remoteSessionId');
    assert.ok(initData.transferId, 'Must return transferId');

    // Check status
    const statusRes = await fetch(`${BASE_URL}/transfers/${initData.remoteSessionId}/status`, {
      headers: { 'Authorization': `Bearer ${testSessionId}` }
    });
    assert.strictEqual(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.status, 'INITIALIZING');
    assert.strictEqual(statusData.fileId, 'engine_binary.zip');
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
    // Record revocations up to threshold
    const client = await pool.connect();
    try {
      for (let i = 0; i < 12; i++) {
        await recordRevocation(client);
      }
    } finally {
      client.release();
    }

    // Check circuit breaker status
    const cbStatus = await isCircuitBreakerTripped(pool);
    assert.strictEqual(cbStatus.tripped, true, 'Circuit breaker must trip after exceeding threshold');
    assert.ok(cbStatus.count >= 10, 'Count must exceed threshold');
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
