// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import crypto from 'crypto';
import { httpServer } from '../src/server.mjs';
import { getPool, closePool } from '../src/persistence/connection.mjs';
import { emitServerEvent } from '../src/websocket/server.mjs';
import { errorHandler } from '../src/api/middleware/error-handler.mjs';
import { validateEnvelope } from '../src/protocol/envelope.mjs';
import { useNonce } from '../src/protocol/nonce.mjs';

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

let testAccountId;
let testMachineId;
let testSessionId;
let authHeaders = {};

before(async () => {
  if (!httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.listen(PORT, () => resolve(null));
    });
  }

  const pool = getPool();
  const accRes = await pool.query('SELECT account_id FROM accounts LIMIT 1');
  testAccountId = accRes.rows[0].account_id;

  const instId = `test-inst-boundary-${Date.now()}`;
  const pubHex = crypto.randomBytes(32).toString('hex');
  const ins = await pool.query(`
    INSERT INTO machines (account_id, installation_id, public_key_hex, descriptor, status)
    VALUES ($1, $2, $3, '{}', 'REGISTERED')
    RETURNING machine_id
  `, [testAccountId, instId, pubHex]);
  testMachineId = ins.rows[0].machine_id;

  const sessRes = await pool.query(`
    INSERT INTO sessions (account_id, machine_id, status, renew_after, expires_at)
    VALUES ($1, $2, 'AUTHENTICATED', now() + interval '30 minutes', now() + interval '1 day')
    RETURNING session_id
  `, [testAccountId, testMachineId]);
  testSessionId = sessRes.rows[0].session_id;

  authHeaders = {
    'Authorization': `Bearer ${testSessionId}`
  };
});

test('ACP ↔ Backend Boundary Conformance Test Suite', async (t) => {
  // Area 1: Tactical Automation Endpoint Purge
  await t.test('1. Tactical Automation endpoints are completely removed (404)', async () => {
    const endpoints = [
      { method: 'POST', path: '/automation/tactical/bet' },
      { method: 'POST', path: '/automation/tactical/cashout' },
      { method: 'POST', path: '/automation/validate' },
      { method: 'POST', path: '/automation/lifecycle/start' },
      { method: 'POST', path: '/automation/lifecycle/stop' }
    ];

    for (const ep of endpoints) {
      const res = await fetch(`${BASE_URL}${ep.path}`, {
        method: ep.method,
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ stake: 100 })
      });
      assert.strictEqual(
        res.status,
        404,
        `Endpoint ${ep.method} ${ep.path} must return 404 (purged from Backend)`
      );
    }
  });

  // Area 2: Operational Capabilities Purge from Snapshot
  await t.test('2. Automation Workspace Snapshot contains pure config without runtime capabilities', async () => {
    const res = await fetch(`${BASE_URL}/automation/snapshot`, {
      headers: authHeaders
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();

    // Must have configuration
    assert.ok(data.globalConfig, 'Snapshot must contain globalConfig');
    assert.ok(data.globalConfig.pricing, 'Must contain pricing config');
    assert.ok(data.globalConfig.risk, 'Must contain risk config');
    assert.ok(data.globalConfig.rebet, 'Must contain rebet config');
    assert.ok(data.globalConfig.proxy, 'Must contain proxy config');
    assert.ok(data.globalConfig.execution, 'Must contain execution config');
    assert.ok(data.globalConfig.browserSpawning, 'Must contain browserSpawning config');
    assert.ok(data.globalConfig.advancedRuntime, 'Must contain advancedRuntime config');

    // Must have account config inventory
    assert.ok(Array.isArray(data.accounts), 'Snapshot must contain accounts array');
    assert.ok(data.serverLimits, 'Snapshot must contain serverLimits');
    assert.strictEqual(typeof data.serverLimits.maxConcurrentBrowsers, 'number');

    // MUST NOT have operational execution capabilities
    assert.strictEqual(data.lifecycle, undefined, 'Snapshot must not contain lifecycle');
    assert.strictEqual(data.lifecycleMessage, undefined, 'Snapshot must not contain lifecycleMessage');
    assert.strictEqual(data.capabilities, undefined, 'Snapshot must not contain capabilities object');
    assert.strictEqual(data.systemStatus, undefined, 'Snapshot must not contain operational systemStatus');

    for (const acc of data.accounts) {
      assert.strictEqual(acc.accountStatus, undefined, 'Account must not expose operational accountStatus');
      assert.strictEqual(acc.browserStatus, undefined, 'Account must not expose operational browserStatus');
      assert.strictEqual(acc.canActivate, undefined, 'Account must not expose runtime canActivate');
      assert.strictEqual(acc.canDeactivate, undefined, 'Account must not expose runtime canDeactivate');
    }
  });

  // Area 3: Server-to-ACP Event Stream via WebSocket
  await t.test('3. Server-to-ACP Event Stream emits monotonic per-account sequence numbers', async () => {
    const wsUrl = `ws://localhost:${PORT}/ws/v1/events?session=${testSessionId}`;
    const ws = new WebSocket(wsUrl);

    const receivedEvents = [];
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    ws.on('message', (data) => {
      try {
        const parsed = JSON.parse(data.toString('utf8'));
        receivedEvents.push(parsed);
      } catch (err) {
        // ignore
      }
    });

    // Allow connection handshake
    await new Promise(r => setTimeout(r, 100));

    // Emit two server events
    const eventPayload1 = { licenseId: 'lic-1', status: 'UPDATED' };
    const eventPayload2 = { notificationId: 'notif-2', title: 'Risk Alert' };

    emitServerEvent(testAccountId, 'LICENSE_CHANGED', eventPayload1);
    emitServerEvent(testAccountId, 'ALERT_TRIGGERED', eventPayload2);

    // Wait for WS delivery
    await new Promise(r => setTimeout(r, 300));
    ws.close();

    const ev1 = receivedEvents.find(e => e.eventType === 'LICENSE_CHANGED');
    assert.ok(ev1, 'Must receive LICENSE_CHANGED event');
    assert.ok(ev1.eventId, 'Must have eventId');
    assert.strictEqual(typeof ev1.sequenceNumber, 'number');
    assert.deepStrictEqual(ev1.payload, eventPayload1);

    const ev2 = receivedEvents.find(e => e.eventType === 'ALERT_TRIGGERED');
    assert.ok(ev2, 'Must receive ALERT_TRIGGERED event');
    assert.ok(ev2.eventId, 'Must have eventId');
    assert.strictEqual(typeof ev2.sequenceNumber, 'number');
    assert.strictEqual(ev2.sequenceNumber, ev1.sequenceNumber + 1, 'Sequence numbers must increment monotonically');
  });

  // Area 4: Standardized BE_* Error Taxonomy & Format
  await t.test('4. Error handler emits standardized BE_* taxonomy with categories and retryability', async () => {
    const testCases = [
      {
        err: Object.assign(new Error('Signature failure'), { code: 'INVALID_SIGNATURE' }),
        expectedCode: 'BE_AUTH_INVALID_SIGNATURE',
        expectedCategory: 'AUTHENTICATION',
        expectedRetryable: false,
        expectedStatus: 401
      },
      {
        err: Object.assign(new Error('Timestamp expired'), { code: 'NONCE_EXPIRED' }),
        expectedCode: 'BE_AUTH_NONCE_EXPIRED',
        expectedCategory: 'AUTHENTICATION',
        expectedRetryable: false,
        expectedStatus: 400
      },
      {
        err: Object.assign(new Error('Machine revoked'), { code: 'MACHINE_REVOKED' }),
        expectedCode: 'BE_AUTH_MACHINE_REVOKED',
        expectedCategory: 'AUTHENTICATION',
        expectedRetryable: false,
        expectedStatus: 403
      },
      {
        err: Object.assign(new Error('Generation mismatch'), { code: 'GENERATION_MISMATCH' }),
        expectedCode: 'BE_REV_GENERATION_MISMATCH',
        expectedCategory: 'CONCURRENCY',
        expectedRetryable: false,
        expectedStatus: 409
      },
      {
        err: Object.assign(new Error('Resource locked'), { code: 'RESOURCE_LOCKED' }),
        expectedCode: 'BE_STATE_RESOURCE_LOCKED',
        expectedCategory: 'CONCURRENCY',
        expectedRetryable: true,
        expectedStatus: 423
      }
    ];

    for (const tc of testCases) {
      let capturedStatus = null;
      let capturedJson = null;

      const mockReq = { headers: { 'x-request-id': 'req-test-123' }, body: {} };
      const mockRes = {
        status: (s) => { capturedStatus = s; return mockRes; },
        json: (j) => { capturedJson = j; return mockRes; }
      };

      await errorHandler(tc.err, mockReq, mockRes, () => {});

      assert.strictEqual(capturedStatus, tc.expectedStatus);
      assert.ok(capturedJson && capturedJson.error);
      assert.strictEqual(capturedJson.error.code, tc.expectedCode);
      assert.strictEqual(capturedJson.error.category, tc.expectedCategory);
      assert.strictEqual(capturedJson.error.retryable, tc.expectedRetryable);
      assert.strictEqual(capturedJson.error.requestId, 'req-test-123');
      assert.ok(capturedJson.error.timestamp);
    }
  });

  // Area 5: Protocol Authentication, Strict Timestamp Drift, and Nonce Replay
  await t.test('5. Protocol authentication rejects expired timestamps (>30s) and replayed nonces', async () => {
    // 5.1 Expired Timestamp (>30s drift)
    const expiredEnvelope = {
      version: 2,
      machineId: testMachineId,
      nonce: `exp-nonce-${Date.now()}`,
      timestamp: new Date(Date.now() - 45000).toISOString(), // 45s ago (exceeds 30s)
      payload: { action: 'PING' },
      signature: 'dummy-sig'
    };

    const valResult = await validateEnvelope(expiredEnvelope, '00'.repeat(32));
    assert.strictEqual(valResult.valid, false);
    assert.strictEqual(valResult.error, 'NONCE_EXPIRED');

    // 5.2 Single-use Nonce Replay
    const uniqueNonce = `boundary-nonce-${crypto.randomUUID()}`;
    await useNonce(uniqueNonce, 1);

    await assert.rejects(
      async () => {
        await useNonce(uniqueNonce, 1);
      },
      (err) => {
        return err.code === 'NONCE_REPLAYED' || err.code === 'BE_AUTH_NONCE_REPLAYED';
      },
      'Duplicate nonce must be rejected'
    );
  });
});

after(async () => {
  const pool = getPool();
  await pool.query('DELETE FROM machines WHERE machine_id = $1', [testMachineId]);
  await pool.query('DELETE FROM sessions WHERE session_id = $1', [testSessionId]);
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
});
