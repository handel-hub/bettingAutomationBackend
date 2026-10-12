// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import { getPool, closePool } from '../src/persistence/connection.mjs';
import { httpServer } from '../src/server.mjs';
import { sign } from '../src/crypto/ed25519.mjs';
import { canonicalStringify } from '../src/protocol/canonical.mjs';
import { authenticate } from '../src/app/authenticate.mjs';
import { register } from '../src/domain/machine/service.mjs';
import { renew, logout } from '../src/domain/session/service.mjs';
import { resolve as resolveAuthorization } from '../src/domain/authorization/service.mjs';
import { getAutomationSnapshot, updateGlobalConfig, updateAccountAutomationConfig } from '../src/domain/automation/service.mjs';
import { applyPaymentSuccess } from '../src/domain/billing/service.mjs';
import { revoke as executeRevocation } from '../src/domain/revocation/service.mjs';
import { createBettingAccount } from '../src/domain/betting-accounts/service.mjs';
import { broadcast } from '../src/websocket/server.mjs';
import { createUpload } from '../src/adapters/storage/adapter.mjs';
import { scheduleSubscriptions } from '../src/jobs/subscription-scheduler.mjs';
import { initializePaymentAdapter } from '../src/adapters/payment/adapter.mjs';

const PORT = 3099;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const TESTER_ACCOUNT_ID = '9d627694-537d-4221-bafa-cf1f163c6bdc';

// Ensure KMS_LOCAL_SECRET is set for vault encryption tests
if (!process.env.KMS_LOCAL_SECRET || process.env.KMS_LOCAL_SECRET.length < 16) {
  process.env.KMS_LOCAL_SECRET = 'test-kms-local-secret-minimum-16-chars';
}

let sharedClientKeyPair;
let sharedPubHex;
let sharedMachineId;
let sharedSessionId;
let sharedSessionGen;
let adminToken;

before(async () => {
  if (!httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.listen(PORT, () => resolve(null));
    });
  } else {
    const addr = httpServer.address();
    if (addr && typeof addr === 'object' && addr.port !== PORT) {
      // Use existing port if already bound
    }
  }

  const pool = getPool();
  // Reset circuit breaker so tests that run revocation are not blocked
  await pool.query('DELETE FROM revocation_circuit_breaker');
  // Ensure tester account is ACTIVE and has generous machine limit for test setup
  await pool.query("UPDATE accounts SET status = 'ACTIVE' WHERE account_id = $1", [TESTER_ACCOUNT_ID]);
  await pool.query(
    `UPDATE licenses
     SET status = 'VALID',
         expires_at = now() + interval '30 days',
         limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{max_machines}', '50')
     WHERE license_id = (
       SELECT license_id FROM licenses WHERE account_id = $1 ORDER BY (status = 'VALID') DESC, issued_at DESC LIMIT 1
     )`,
    [TESTER_ACCOUNT_ID]
  );

  // Register a clean machine and full session for tester
  sharedClientKeyPair = crypto.generateKeyPairSync('ed25519');
  const spki = sharedClientKeyPair.publicKey.export({ type: 'spki', format: 'der' });
  sharedPubHex = spki.subarray(spki.length - 32).toString('hex');
  const installationId = crypto.randomUUID();
  const selfSig = sign(sharedClientKeyPair.privateKey, Buffer.from(installationId, 'utf8'));

  const partialAuth = await authenticate('tester@bettingautomation.com', 'Password123!', null, 2, `nonce-${crypto.randomUUID()}`);
  const machine = await register(installationId, sharedPubHex, { os: 'win32', hostname: 'sec-inv-test' }, selfSig, partialAuth.sessionId);
  sharedMachineId = machine.machine_id;

  const fullAuth = await authenticate('tester@bettingautomation.com', 'Password123!', sharedMachineId, 2, `nonce-${crypto.randomUUID()}`);
  sharedSessionId = fullAuth.sessionId;
  sharedSessionGen = fullAuth.sessionGeneration;

  // Provision a temporary SUPER_ADMIN session for admin endpoint verification
  const adminRes = await pool.query(
    `INSERT INTO admin_users (email, credentials_hash, role, mfa_secret, status)
     VALUES ('sec-inv-admin@bettingautomation.com', 'unused', 'SUPER_ADMIN', 'JBSWY3DPEHPK3PXP', 'ACTIVE')
     ON CONFLICT (email) DO UPDATE SET role = 'SUPER_ADMIN', status = 'ACTIVE'
     RETURNING admin_id`
  );
  const adminId = adminRes.rows[0].admin_id;
  const adminSessRes = await pool.query(
    `INSERT INTO admin_sessions (admin_id, expires_at)
     VALUES ($1, now() + interval '1 hour')
     RETURNING session_id`,
    [adminId]
  );
  adminToken = adminSessRes.rows[0].session_id;
});

function getServerBaseUrl() {
  const addr = httpServer.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : PORT;
  return `http://127.0.0.1:${actualPort}`;
}

test('System-Wide Security Redesign Invariant Suite (SEC-INV-01 through SEC-INV-07)', async (t) => {
  await t.test('SEC-INV-01 (RC-01): Sessionless signed envelope rejected on operatorAuth & admin routes require RBAC', async () => {
    const baseUrl = getServerBaseUrl();

    // 1. Construct a valid Ed25519-signed envelope with sessionId: null
    const envelope = {
      version: 2,
      sessionId: null,
      machineId: sharedMachineId,
      nonce: `nonce-sessionless-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      clientGeneration: 1,
      clientServerEpoch: 1,
      payload: { platform: 'SportyBet', username: 'attacker_user', password: 'pw' }
    };
    const canonicalBytes = Buffer.from('CONTROL_PLANE_V1' + canonicalStringify(envelope), 'utf8');
    const signature = sign(sharedClientKeyPair.privateKey, canonicalBytes);

    const res = await fetch(`${baseUrl}/api/v1/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...envelope, signature })
    });
    assert.strictEqual(res.status, 401, 'Sessionless signed envelope must be rejected with 401');
    const body = await res.json();
    assert.ok(body.error, 'Error message must be present on 401');

    // 2. Unauthenticated or operator-authenticated access to admin mutation routes must fail
    const pRes = await fetch(`${baseUrl}/api/v1/platforms`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({ name: 'RogueBookie' })
    });
    assert.strictEqual(pRes.status, 401, 'Operator session token must not be accepted as admin token on POST /api/v1/platforms');

    const mRes = await fetch(`${baseUrl}/metrics`);
    assert.strictEqual(mRes.status, 401, 'Unauthenticated GET /metrics must be rejected with 401');

    const mAdminRes = await fetch(`${baseUrl}/metrics`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.strictEqual(mAdminRes.status, 200, 'Admin-authenticated GET /metrics must succeed');
  });

  await t.test('SEC-INV-02 (RC-02): Billing plan validation, cross-endpoint replay lock, expired subscription resume gate, and XSS escaping', async () => {
    const baseUrl = getServerBaseUrl();
    const pool = getPool();

    // 1. Invalid planId rejected with 400 INVALID_PLAN in applyPaymentSuccess
    await assert.rejects(
      async () => {
        await applyPaymentSuccess(undefined, {
          accountId: TESTER_ACCOUNT_ID,
          planId: 'NON_EXISTENT_TIER_999',
          reference: `ref-invalid-${crypto.randomUUID()}`
        });
      },
      (err) => err.code === 'INVALID_PLAN' && err.status === 400
    );

    // 2. Cross-endpoint payment replay (webhook providerTxId + /payments/verify reference) blocked with 409 PAYMENT_ALREADY_REDEEMED
    const uniqueRef = `ref-sec-inv-${crypto.randomUUID()}`;
    const uniqueProviderTx = `tx-sec-inv-${crypto.randomUUID()}`;

    const firstRedeem = await applyPaymentSuccess(undefined, {
      accountId: TESTER_ACCOUNT_ID,
      planId: 'pro',
      amount: 49000,
      reference: uniqueRef,
      providerTxId: uniqueProviderTx
    });
    assert.ok(firstRedeem.licenseId, 'First payment application must issue/update license');

    // Second redemption using only the Paystack reference (simulating /payments/verify after webhook)
    await assert.rejects(
      async () => {
        await applyPaymentSuccess(undefined, {
          accountId: TESTER_ACCOUNT_ID,
          planId: 'pro',
          amount: 49000,
          reference: uniqueRef,
          providerTxId: uniqueRef
        });
      },
      (err) => err.code === 'PAYMENT_ALREADY_REDEEMED' && err.status === 409
    );

    // 3. Expired subscription cannot be resumed without payment
    await pool.query(
      `UPDATE subscriptions SET status = 'CANCELLED', current_period_end = now() - interval '2 days' WHERE account_id = $1`,
      [TESTER_ACCOUNT_ID]
    );
    const resumeRes = await fetch(`${baseUrl}/api/v1/billing/subscription/resume`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sharedSessionId}` }
    });
    assert.strictEqual(resumeRes.status, 402, 'Expired subscription resume must fail with 402');

    // Restore active subscription period and generous max_machines for subsequent tests
    await pool.query(
      `UPDATE subscriptions
       SET status = 'ACTIVE', current_period_end = now() + interval '30 days'
       WHERE subscription_id = (
         SELECT subscription_id FROM subscriptions WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 1
       )`,
      [TESTER_ACCOUNT_ID]
    );
    await pool.query(
      "UPDATE licenses SET limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{max_machines}', '50') WHERE account_id = $1 AND status = 'VALID'",
      [TESTER_ACCOUNT_ID]
    );

    // 4. GET /payments/callback HTML-escapes the reference query param
    const xssRes = await fetch(`${baseUrl}/payments/callback?reference=${encodeURIComponent('<script>alert(1)</script>')}`);
    assert.strictEqual(xssRes.status, 200);
    const html = await xssRes.text();
    assert.ok(!html.includes('<script>alert(1)</script>'), 'Raw <script> tag must not be reflected');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'Escaped entity must be present');
  });

  await t.test('SEC-INV-03 (RC-03): Multi-tenant global_automation_configs isolation & WebSocket broadcast fail-closed', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();

    await updateGlobalConfig(tenantA, 'pricing', { minOdds: 9.99, maxStake: 777 });

    const afterTenantA = await getAutomationSnapshot(tenantA);
    const afterTenantB = await getAutomationSnapshot(tenantB);

    assert.strictEqual(Number(afterTenantA.globalConfig.pricing.minOdds), 9.99, 'Tenant A config must reflect update');
    assert.notStrictEqual(Number(afterTenantB.globalConfig.pricing.minOdds), 9.99, 'Tenant B config must be isolated from Tenant A');

    // WebSocket broadcast without targetAccountId must fail closed (0 recipients / undefined)
    const sentCount = broadcast('SENSITIVE_EVENT', { secret: 'should-not-leak' }, null);
    assert.ok(!sentCount, 'Broadcast without targetAccountId must fail closed');
  });

  await t.test('SEC-INV-04 (RC-01/RC-04): Revocation cascade on logout, suspended account enforcement, mandatory generation, and max_accounts cap', async () => {
    const pool = getPool();

    // 1. Mandatory presentedGenerationState in resolveAuthorization()
    await assert.rejects(
      async () => {
        await resolveAuthorization(sharedSessionId, sharedMachineId, null);
      },
      (err) => err.code === 'GENERATION_MISMATCH' && err.status === 403
    );

    // 2. Enforce max_accounts limit from license in createBettingAccount
    await pool.query(
      "UPDATE licenses SET limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{max_accounts}', '1') WHERE account_id = $1 AND status = 'VALID'",
      [TESTER_ACCOUNT_ID]
    );
    // Ensure at least 1 betting account exists
    try {
      await createBettingAccount(TESTER_ACCOUNT_ID, {
        name: 'Cap Test 1',
        platformDisplayName: 'SportyBet',
        accountUsername: `cap_user_${crypto.randomUUID().slice(0, 8)}`,
        accountPassword: 'pw1'
      });
    } catch {
      // Already at limit
    }
    await assert.rejects(
      async () => {
        await createBettingAccount(TESTER_ACCOUNT_ID, {
          name: 'Cap Overflow',
          platformDisplayName: 'SportyBet',
          accountUsername: `cap_overflow_${crypto.randomUUID().slice(0, 8)}`,
          accountPassword: 'pw2'
        });
      },
      (err) => err.message.includes('Plan limit reached') && err.status === 403
    );

    // Restore max_accounts limit
    await pool.query(
      "UPDATE licenses SET limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{max_accounts}', '50') WHERE account_id = $1 AND status = 'VALID'",
      [TESTER_ACCOUNT_ID]
    );

    // 3. Account suspension immediately blocks renew() and resolveAuthorization()
    await pool.query("UPDATE accounts SET status = 'SUSPENDED' WHERE account_id = $1", [TESTER_ACCOUNT_ID]);
    try {
      await assert.rejects(
        async () => {
          await renew(sharedSessionId, sharedMachineId, sharedSessionGen, `nonce-${crypto.randomUUID()}`);
        },
        (err) => (err.message.includes('Account is inactive') || err.code === 'ACCOUNT_SUSPENDED' || err.code === 'ACCOUNT_LOCKED') && err.status === 403
      );

      await assert.rejects(
        async () => {
          await resolveAuthorization(sharedSessionId, sharedMachineId, sharedSessionGen);
        },
        (err) => (err.code === 'ACCOUNT_LOCKED' || err.code === 'ACCOUNT_SUSPENDED') && err.status === 403
      );
    } finally {
      await pool.query("UPDATE accounts SET status = 'ACTIVE' WHERE account_id = $1", [TESTER_ACCOUNT_ID]);
    }

    // 4. Logout cascades to session status, authorizations, and session_generation
    const tempAuth = await authenticate('tester@bettingautomation.com', 'Password123!', sharedMachineId, 2, `nonce-${crypto.randomUUID()}`);
    await logout(tempAuth.sessionId, sharedMachineId);

    await assert.rejects(
      async () => {
        await renew(tempAuth.sessionId, sharedMachineId, tempAuth.sessionGeneration, `nonce-${crypto.randomUUID()}`);
      },
      (err) => (err.code === 'SESSION_REVOKED' || err.status === 403 || err.status === 401)
    );

    // Re-authenticate sharedSessionId for subsequent tests
    const reAuth = await authenticate('tester@bettingautomation.com', 'Password123!', sharedMachineId, 2, `nonce-${crypto.randomUUID()}`);
    sharedSessionId = reAuth.sessionId;
    sharedSessionGen = reAuth.sessionGeneration;
  });

  await t.test('SEC-INV-05 (RC-04): Machine registration selfSignature PoP, LICENSE revocation cascade, and StorageAdapter path sanitization', async () => {
    const pool = getPool();

    // 1. Re-registering an existing installationId with a forged signature must fail with Invalid self-signature
    const victimKeyPair = crypto.generateKeyPairSync('ed25519');
    const victimSpki = victimKeyPair.publicKey.export({ type: 'spki', format: 'der' });
    const victimPubHex = victimSpki.subarray(victimSpki.length - 32).toString('hex');
    const victimInstallId = crypto.randomUUID();
    const validSig = sign(victimKeyPair.privateKey, Buffer.from(victimInstallId, 'utf8'));

    const partial = await authenticate('tester@bettingautomation.com', 'Password123!', null, 2, `nonce-${crypto.randomUUID()}`);
    await register(victimInstallId, victimPubHex, { os: 'win32' }, validSig, partial.sessionId);

    const attackerKeyPair = crypto.generateKeyPairSync('ed25519');
    const forgedSig = sign(attackerKeyPair.privateKey, Buffer.from(victimInstallId, 'utf8'));

    await assert.rejects(
      async () => {
        await register(victimInstallId, victimPubHex, { os: 'win32' }, forgedSig, partial.sessionId);
      },
      (err) => err.message === 'Invalid self-signature' && (err.status === 403 || err.statusCode === 403 || err.status === 400 || err.status === 401)
    );

    // 2. LICENSE revocation cascades to active sessions and records non-null account_id in revocation_events
    const licRow = await pool.query("SELECT license_id FROM licenses WHERE account_id = $1 AND status = 'VALID' LIMIT 1", [TESTER_ACCOUNT_ID]);
    const licenseId = licRow.rows[0].license_id;

    const sessionBeforeRevoke = await authenticate('tester@bettingautomation.com', 'Password123!', sharedMachineId, 2, `nonce-${crypto.randomUUID()}`);
    await pool.query('DELETE FROM revocation_circuit_breaker');
    await executeRevocation('LICENSE', licenseId, 'Security Invariant Test Revocation', { type: 'ADMIN', id: 'sec-inv-admin' });
    const revRow = await pool.query(
      "SELECT payload FROM outbox_events WHERE event_type = 'REVOCATION_NOTICE' ORDER BY created_at DESC LIMIT 1"
    );
    const revPayload = typeof revRow.rows[0]?.payload === 'string' ? JSON.parse(revRow.rows[0].payload) : revRow.rows[0]?.payload;
    assert.strictEqual(revPayload?.accountId, TESTER_ACCOUNT_ID, 'REVOCATION_NOTICE outbox event must record resolved accountId for LICENSE scope');

    const sessCheck = await pool.query('SELECT status FROM sessions WHERE session_id = $1', [sessionBeforeRevoke.sessionId]);
    assert.strictEqual(sessCheck.rows[0].status, 'REVOKED', 'LICENSE revocation must cascade to active sessions');

    // Restore license and re-authenticate shared session for remaining tests
    await pool.query("UPDATE licenses SET status = 'VALID' WHERE license_id = $1", [licenseId]);
    const restoredAuth = await authenticate('tester@bettingautomation.com', 'Password123!', sharedMachineId, 2, `nonce-${crypto.randomUUID()}`);
    sharedSessionId = restoredAuth.sessionId;
    sharedSessionGen = restoredAuth.sessionGeneration;

    // 3. StorageAdapter sanitizes path traversal uploadId
    const safeId = await createUpload('../../etc/passwd');
    assert.strictEqual(safeId, 'passwd', 'Upload ID must be sanitized to basename without traversal segments');
  });

  await t.test('SEC-INV-06 (RC-05): MFA disable requires step-up secret & UPDATE_PASSWORD updates credentials_hash cleanly', async () => {
    const baseUrl = getServerBaseUrl();

    // First enable MFA so we can test disabling it
    await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({
        type: 'CONFIGURE_MFA',
        payload: { enabled: true }
      })
    });

    // 1. Disabling MFA without stepUpSecret must return status REQUIRES_STEP_UP
    const mfaRes = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({
        type: 'CONFIGURE_MFA',
        payload: { enabled: false }
      })
    });
    assert.strictEqual(mfaRes.status, 200);
    const mfaBody = await mfaRes.json();
    assert.strictEqual(mfaBody.status, 'REQUIRES_STEP_UP');

    // Disabling MFA with valid stepUpSecret succeeds
    const mfaDisableOk = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({
        type: 'CONFIGURE_MFA',
        stepUpSecret: 'Password123!',
        payload: { enabled: false }
      })
    });
    const mfaDisableBody = await mfaDisableOk.json();
    assert.strictEqual(mfaDisableBody.status, 'ACCEPTED');

    // 2. UPDATE_PASSWORD intent verifies credentials_hash and updates cleanly, then restores password
    const changeRes = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({
        type: 'UPDATE_PASSWORD',
        stepUpSecret: 'Password123!',
        payload: { newPassword: 'TempPassword456!' }
      })
    });
    assert.strictEqual(changeRes.status, 200, 'UPDATE_PASSWORD with valid stepUpSecret must succeed');
    const changeBody = await changeRes.json();
    assert.strictEqual(changeBody.status, 'ACCEPTED');

    // Restore original password
    const restoreRes = await fetch(`${baseUrl}/api/v1/settings/intent`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({
        type: 'UPDATE_PASSWORD',
        stepUpSecret: 'TempPassword456!',
        payload: { newPassword: 'Password123!' }
      })
    });
    assert.strictEqual(restoreRes.status, 200, 'Restoring original password must succeed');
    const restoreBody = await restoreRes.json();
    assert.strictEqual(restoreBody.status, 'ACCEPTED');
  });

  await t.test('SEC-INV-07 (REM-01 through REM-05): HardwareId collision defense, reconciliation session gate, auth rate limiter, platform limits, revoked license payment guard, and system update RBAC', async () => {
    const baseUrl = getServerBaseUrl();
    const pool = getPool();

    // 1. REM-01: Machine registration rejects mismatched descriptor.hardwareId (prevents hardwareId collision poisoning)
    const rogueKp = crypto.generateKeyPairSync('ed25519');
    const rogueSpki = rogueKp.publicKey.export({ type: 'spki', format: 'der' });
    const roguePubHex = rogueSpki.subarray(rogueSpki.length - 32).toString('hex');
    const rogueInstallId = `inst_${crypto.randomUUID()}`;
    const rogueSig = sign(rogueKp.privateKey, Buffer.from(rogueInstallId, 'utf8'));
    await assert.rejects(
      async () => {
        await register(rogueInstallId, roguePubHex, { os: 'win32', hardwareId: sharedMachineId }, rogueSig, null);
      },
      (err) => err.code === 'INVALID_FORMAT' && err.status === 400
    );

    // 2. REM-01: Sessionless /api/v1/reconciliation/sync envelope is rejected with 401
    const recEnvelope = {
      version: 2,
      sessionId: null,
      machineId: sharedMachineId,
      nonce: `nonce-rec-${crypto.randomUUID()}`,
      timestamp: new Date().toISOString(),
      clientGeneration: 999999,
      clientServerEpoch: 1,
      payload: { localStateHash: 'abc' }
    };
    const recSig = sign(
      sharedClientKeyPair.privateKey,
      Buffer.from('CONTROL_PLANE_V1' + canonicalStringify(recEnvelope), 'utf8')
    );
    const recRes = await fetch(`${baseUrl}/api/v1/reconciliation/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...recEnvelope, signature: recSig })
    });
    assert.strictEqual(recRes.status, 401, 'Sessionless reconciliation sync must be rejected with 401');

    // 3. REM-02: Auth rate limiter enforces per-email limit on payload.email
    const targetBruteEmail = `ratelimit-${crypto.randomUUID()}@example.com`;
    let lastStatus = 0;
    for (let i = 0; i < 6; i++) {
      const rlRes = await fetch(`${baseUrl}/api/v1/auth/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payload: {
            email: targetBruteEmail,
            password: 'WrongPassword123!'
          }
        })
      });
      lastStatus = rlRes.status;
    }
    assert.strictEqual(lastStatus, 429, '6th failed login attempt for the same payload.email must return 429');

    // 4. REM-03: Enforces allowedPlatformIds and source whitelist
    await pool.query(
      `UPDATE licenses
       SET limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{allowedPlatformIds}', '["SportyBet"]'::jsonb)
       WHERE account_id = $1 AND status = 'VALID'`,
      [TESTER_ACCOUNT_ID]
    );
    try {
      await assert.rejects(
        async () => {
          await createBettingAccount(TESTER_ACCOUNT_ID, {
            name: 'Disallowed Platform Account',
            platformDisplayName: 'Pinnacle',
            accountUsername: `pin_${crypto.randomUUID().slice(0, 8)}`,
            accountPassword: 'pw'
          });
        },
        (err) => err.code === 'BE_PERM_ENTITLEMENT_EXCEEDED' && err.status === 403
      );
    } finally {
      await pool.query(
        `UPDATE licenses
         SET limits = limits - 'allowedPlatformIds'
         WHERE account_id = $1 AND status = 'VALID'`,
        [TESTER_ACCOUNT_ID]
      );
    }

    await assert.rejects(
      async () => {
        // @ts-ignore
        await updateAccountAutomationConfig(TESTER_ACCOUNT_ID, crypto.randomUUID(), 'pricing', 'INVALID_SOURCE', {});
      },
      (err) => err.code === 'BE_VAL_SCHEMA_VIOLATION' && err.status === 400
    );

    // 5. REM-04: Administratively REVOKED license cannot be self-reactivated via applyPaymentSuccess, and javascript: returnUrl is rejected
    await pool.query("UPDATE licenses SET status = 'REVOKED' WHERE account_id = $1", [TESTER_ACCOUNT_ID]);
    try {
      await assert.rejects(
        async () => {
          await applyPaymentSuccess(undefined, {
            accountId: TESTER_ACCOUNT_ID,
            planId: 'pro',
            amount: 49000,
            reference: `ref-revoked-${crypto.randomUUID()}`
          });
        },
        (err) => err.code === 'LICENSE_REVOKED' && err.status === 403
      );
    } finally {
      await pool.query(
        `UPDATE licenses SET status = 'VALID' WHERE license_id = (
           SELECT license_id FROM licenses WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1
         )`,
        [TESTER_ACCOUNT_ID]
      );
    }

    const badReturnUrlRes = await fetch(`${baseUrl}/api/v1/billing/checkout`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`,
        'Idempotency-Key': `chk-xss-${crypto.randomUUID()}`
      },
      body: JSON.stringify({
        planId: 'pro',
        returnUrl: 'javascript:alert(1)'
      })
    });
    assert.strictEqual(badReturnUrlRes.status, 400, 'javascript: returnUrl must be rejected with 400');

    // 6. REM-05: POST /api/v1/system/restart-and-update requires SUPER_ADMIN or CAP_UPDATE_INSTALL
    const opUpdateRes = await fetch(`${baseUrl}/api/v1/system/restart-and-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sharedSessionId}`
      },
      body: JSON.stringify({ targetVersion: 'v0.2.0' })
    });
    assert.strictEqual(opUpdateRes.status, 403, 'Operator without CAP_UPDATE_INSTALL must be rejected with 403');

    const adminUpdateRes = await fetch(`${baseUrl}/api/v1/system/restart-and-update`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`
      },
      body: JSON.stringify({ targetVersion: 'v0.2.0' })
    });
    assert.strictEqual(adminUpdateRes.status, 200, 'SUPER_ADMIN must be permitted to trigger restart-and-update');
  });

  await t.test('SEC-INV-07 (White-Box Hardening): Cryptographically signed license payloads, Envelope V2 billing verify, active license gating on mutations, and settings session revocation cascade', async () => {
    const baseUrl = getServerBaseUrl();
    const pool = getPool();

    // 1. authenticate() returns a cryptographically signed license payload
    const authRes = await authenticate('tester@bettingautomation.com', 'Password123!', sharedMachineId, 2, `nonce-wb-${crypto.randomUUID()}`);
    assert.ok(authRes.license, 'authenticate() must return license object');
    assert.strictEqual(typeof authRes.license.signature, 'string', 'license.signature must be a hex string');
    assert.strictEqual(authRes.license.signature.length, 128, 'Ed25519 signature must be 128 hex chars');
    assert.strictEqual(typeof authRes.license.key_version, 'number', 'license.key_version must be present');

    // 2. POST /api/v1/billing/checkout/verify returns signed Envelope V2 with signed license
    const verifyRef = `ref-wb-verify-${crypto.randomUUID()}`;
    initializePaymentAdapter('stub', { NODE_ENV: 'test', ALLOW_TEST_PAYMENT_STUB: 'true' });
    const verifyRes = await fetch(`${baseUrl}/api/v1/billing/checkout/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authRes.sessionId}`
      },
      body: JSON.stringify({ reference: verifyRef, planId: 'pro' })
    });
    assert.strictEqual(verifyRes.status, 200, 'Billing checkout verify must succeed');
    const verifyEnv = await verifyRes.json();
    assert.strictEqual(verifyEnv.version, 2, 'Billing checkout verify response must be wrapped in Envelope V2');
    assert.ok(verifyEnv.signatures && typeof verifyEnv.signatures === 'object', 'Billing checkout verify envelope must carry Ed25519 signatures');
    assert.strictEqual(verifyEnv.payload?.verified, true, 'Envelope payload must confirm verification');
    assert.strictEqual(typeof verifyEnv.payload?.license?.signature, 'string', 'Provisioned license inside billing verify must be signed');

    // 3. Domain mutation (updateGlobalConfig) rejects with 403 BE_PERM_LICENSE_EXPIRED when license is expired
    await pool.query("UPDATE licenses SET status = 'EXPIRED' WHERE account_id = $1", [TESTER_ACCOUNT_ID]);
    try {
      await assert.rejects(
        async () => {
          await updateGlobalConfig(TESTER_ACCOUNT_ID, 'pricing', { minOdds: 2.0 });
        },
        (err) => err.code === 'BE_PERM_LICENSE_EXPIRED' && err.status === 403
      );
    } finally {
      await pool.query(
        `UPDATE licenses SET status = 'VALID', expires_at = now() + interval '30 days'
         WHERE license_id = (SELECT license_id FROM licenses WHERE account_id = $1 ORDER BY issued_at DESC LIMIT 1)`,
        [TESTER_ACCOUNT_ID]
      );
    }
  });
});

after(async () => {
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(() => resolve(null)));
  }
  await closePool();
});
