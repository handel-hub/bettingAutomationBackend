// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { canonicalStringify, canonicalize } from '../src/protocol/canonical.mjs';
import { validateEnvelope, buildEnvelope } from '../src/protocol/envelope.mjs';
import { getActiveKey, signWithActiveKey } from '../src/crypto/keys.mjs';
import { verify, sign } from '../src/crypto/ed25519.mjs';
import { authenticate } from '../src/app/authenticate.mjs';
import { renew } from '../src/domain/session/service.mjs';
import { reconcile } from '../src/domain/reconciliation/service.mjs';
import { register } from '../src/domain/machine/service.mjs';
import { claimNextEvent, completeEvent, processOutboxEvent } from '../src/outbox/worker.mjs';
import { setSystemEpoch } from '../src/domain/system/epoch-store.mjs';
import { getPool, closePool } from '../src/persistence/connection.mjs';
import { httpServer } from '../src/server.mjs';

const PORT = process.env.PORT || 3001;

before(async () => {
  if (!httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.listen(PORT, () => resolve(null));
    });
  }
  const pool = getPool();
  await pool.query("DELETE FROM machines WHERE descriptor->>'hostname' = 'test-node-automated' OR descriptor->>'os' = 'win32'");
});

test('Adversarial & Edge-Case Security Test Suite', async (t) => {
  // 1. Scenario A: Nested Payload Preservation in Canonical Serialization
  await t.test('Scenario A: Canonical JSON preserves deep nested payload without property loss', () => {
    const complexEnvelope = {
      version: 2,
      sessionId: 'sess-123',
      machineId: 'mach-456',
      nonce: 'nonce-789',
      timestamp: '2026-09-08T12:00:00.000Z',
      clientGeneration: 5,
      clientServerEpoch: 1,
      payload: {
        action: 'UPDATE_PRICING',
        nestedParams: {
          platform: 'SportyBet',
          thresholds: {
            minOdds: 1.5,
            maxStake: 25000,
            allowRebet: true
          }
        },
        tags: ['strategy', 'high-risk']
      }
    };

    const serialized = canonicalStringify(complexEnvelope);
    const parsed = JSON.parse(serialized);

    assert.strictEqual(parsed.payload.nestedParams.thresholds.minOdds, 1.5);
    assert.strictEqual(parsed.payload.nestedParams.thresholds.maxStake, 25000);
    assert.strictEqual(parsed.payload.nestedParams.thresholds.allowRebet, true);
    assert.deepStrictEqual(parsed.payload.tags, ['strategy', 'high-risk']);

    // Ensure keys in serialized string are sorted at all depths
    const expectedRegex = /"action".*"nestedParams".*"tags"/;
    assert.match(serialized, expectedRegex);
  });

  // 2. Scenario B: Deterministic KMS Key derivation matches DB pinned public key
  await t.test('Scenario B: KMS adapter derives authentic private key matching DB active key', async () => {
    const activeKey = await getActiveKey();
    assert.ok(activeKey.public_key_hex, 'Must have active public key in DB');

    const testMessage = Buffer.from('test-cryptographic-handshake-integrity', 'utf8');
    const { signatureHex, keyVersion } = await signWithActiveKey(testMessage);

    assert.strictEqual(keyVersion, activeKey.key_version);

    const pubKeyBuf = Buffer.from(activeKey.public_key_hex, 'hex');
    const isValid = verify(pubKeyBuf, testMessage, signatureHex);
    assert.strictEqual(isValid, true, 'Signature produced by KMS must verify against public key in DB');
  });

  // 3. Scenario C: Unregistered Machine Onboarding (No FK Violation)
  await t.test('Scenario C: Unregistered machine receives PARTIAL token without FK crash', async () => {
    const newMachineId = crypto.randomUUID();
    const result = await authenticate('tester@bettingautomation.com', 'Password123!', newMachineId, 2, 'nonce-test');

    assert.strictEqual(result.status, 'PARTIAL');
    assert.ok(result.sessionId, 'Must issue a valid partial sessionId');
  });

  // 4. Scenario D: Session Renewal with numeric clientGeneration
  await t.test('Scenario D: Session renewal accepts numeric clientGeneration counter', async () => {
    const pool = getPool();
    // Allow up to 20 machines for tester account during test
    await pool.query("UPDATE licenses SET plan_id = 'PRO', limits = jsonb_set(limits, '{max_machines}', '20') WHERE account_id = '9d627694-537d-4221-bafa-cf1f163c6bdc'");

    const clientKeyPair = crypto.generateKeyPairSync('ed25519');
    const spki = clientKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const pubHex = spki.subarray(spki.length - 32).toString('hex');
    const installationId = crypto.randomUUID();
    const selfSig = sign(clientKeyPair.privateKey, Buffer.from(installationId, 'utf8'));

    // Get partial token
    const partialAuth = await authenticate('tester@bettingautomation.com', 'Password123!', null, 2, 'nonce-init');
    const machine = await register(installationId, pubHex, { os: 'win32' }, selfSig, partialAuth.sessionId);

    // Full login
    const authResult = await authenticate('tester@bettingautomation.com', 'Password123!', machine.machine_id, 2, 'nonce-login');
    assert.strictEqual(authResult.status, 'AUTHENTICATED');

    // Renew with numeric generation counter
    const renewalResult = await renew(authResult.sessionId, machine.machine_id, authResult.sessionGeneration, 'nonce-renew-1');
    assert.strictEqual(renewalResult.status, 'AUTHENTICATED');
    assert.ok(renewalResult.graceToken, 'Renewal must include signed GraceToken');
    assert.ok(renewalResult.graceToken.signature, 'GraceToken must have Ed25519 signature');
  });

  // 5. Scenario E: DB Restore vs Forgery detection (CRIT-05)
  await t.test('Scenario E: Server Epoch distinguishes legitimate DB restore from forgery', async () => {
    const pool = getPool();
    const clientKeyPair = crypto.generateKeyPairSync('ed25519');
    const spki = clientKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const pubHex = spki.subarray(spki.length - 32).toString('hex');
    const installationId = crypto.randomUUID();
    const selfSig = sign(clientKeyPair.privateKey, Buffer.from(installationId, 'utf8'));

    const partialAuth = await authenticate('tester@bettingautomation.com', 'Password123!', null, 2, 'nonce-init');
    const machine = await register(installationId, pubHex, { os: 'win32' }, selfSig, partialAuth.sessionId);

    // Set server_trust_version and external system epoch to 5 (simulating server epoch after restore)
    setSystemEpoch(5);
    await pool.query('UPDATE backend_trust_state SET server_trust_version = 5');

    // Case 1: Client presents older epoch (e.g. 4) with client generation > server generation
    const restoreCheck = await reconcile(machine.machine_id, 999, 4);
    assert.strictEqual(restoreCheck.resolution, 'DB_RESTORED');
    assert.strictEqual(restoreCheck.action, 'FORCE_SYNC');

    // Verify machine was NOT revoked
    const machRes = await pool.query('SELECT status FROM machines WHERE machine_id = $1', [machine.machine_id]);
    assert.notStrictEqual(machRes.rows[0].status, 'REVOKED', 'DB restore must NOT revoke machine');

    // Case 2: Client presents current epoch (5) with client generation > server generation -> Genuine Forgery
    const forgeryCheck = await reconcile(machine.machine_id, 999, 5);
    assert.strictEqual(forgeryCheck.resolution, 'FORGERY_SUSPECTED');
    assert.strictEqual(forgeryCheck.action, 'REVOKE_MACHINE');

    const machRevokedRes = await pool.query('SELECT status FROM machines WHERE machine_id = $1', [machine.machine_id]);
    assert.strictEqual(machRevokedRes.rows[0].status, 'REVOKED', 'Genuine forgery must revoke machine');
  });

  // 6. Scenario F: First-time subscriber payment activation in Outbox Worker
  await t.test('Scenario F: First-time subscriber gets active subscription and license via Outbox Worker', async () => {
    const pool = getPool();
    const newAccId = crypto.randomUUID();
    const email = `first_timer_${Date.now()}@bettingautomation.com`;

    // Insert brand new account
    await pool.query(`
      INSERT INTO accounts (account_id, email, credentials_hash, status)
      VALUES ($1, $2, 'dummy_hash', 'ACTIVE')
    `, [newAccId, email]);

    // Clear any stale pending/processing events from earlier tests
    await pool.query("UPDATE outbox_events SET status = 'DELIVERED' WHERE status IN ('PENDING', 'PROCESSING')");

    // Enqueue a charge.success outbox event for this new account
    const idempotencyKey = `evt-pay-${Date.now()}`;
    await pool.query(`
      INSERT INTO outbox_events (event_type, payload, idempotency_key, status)
      VALUES ('charge.success', $1, $2, 'PENDING')
    `, [JSON.stringify({
      data: {
        reference: `ref-first-time-${Date.now()}`,
        amount: 1000000,
        metadata: {
          account_id: newAccId,
          plan_id: 'PRO'
        }
      }
    }), idempotencyKey]);

    // Claim and process via Outbox Worker
    const event = await claimNextEvent();
    assert.ok(event, 'Must claim the pending outbox event');
    assert.strictEqual(event.idempotency_key, idempotencyKey);

    const success = await processOutboxEvent(event);
    assert.strictEqual(success, true, 'Outbox processing must succeed');

    // Complete the event
    await completeEvent(event.event_id, true);

    // Verify subscription was created and is ACTIVE
    const subRes = await pool.query('SELECT * FROM subscriptions WHERE account_id = $1', [newAccId]);
    assert.strictEqual(subRes.rows.length, 1, 'Must create subscription for new user');
    assert.strictEqual(subRes.rows[0].status, 'ACTIVE');

    // Verify license was created and is VALID
    const licRes = await pool.query('SELECT * FROM licenses WHERE account_id = $1', [newAccId]);
    assert.strictEqual(licRes.rows.length, 1, 'Must create license for new user');
    assert.strictEqual(licRes.rows[0].status, 'VALID');
  });
});

after(async () => {
  setSystemEpoch(1);
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
});
