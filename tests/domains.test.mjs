// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import crypto from 'crypto';
import { httpServer } from '../src/server.mjs';
import { getPool, closePool } from '../src/persistence/connection.mjs';

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

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
  const accountId = accRes.rows[0].account_id;
  const instId = `test-inst-domains-${Date.now()}`;
  const pubHex = crypto.randomBytes(32).toString('hex');
  const ins = await pool.query(`
    INSERT INTO machines (account_id, installation_id, public_key_hex, descriptor, status)
    VALUES ($1, $2, $3, '{}', 'REGISTERED')
    RETURNING machine_id
  `, [accountId, instId, pubHex]);
  const machineId = ins.rows[0].machine_id;
  const sessRes = await pool.query(`
    INSERT INTO sessions (account_id, machine_id, status, renew_after, expires_at)
    VALUES ($1, $2, 'AUTHENTICATED', now() + interval '30 minutes', now() + interval '1 day')
    RETURNING session_id
  `, [accountId, machineId]);
  testSessionId = sessRes.rows[0].session_id;
  authHeaders = {
    'Authorization': `Bearer ${testSessionId}`
  };
});

test('Domains 1-7 API and WebSocket Integration Test Suite', async (t) => {
  // 1. Domain 2: Betting Accounts (Create, Read, List, Action)
  await t.test('Domain 2: Betting Accounts Management & AEAD encryption', async () => {
    const testUsername = `user_${Date.now()}`;
    const createRes = await fetch(`${BASE_URL}/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        name: 'SportyBet High Stakes',
        platformDisplayName: 'SportyBet',
        accountUsername: testUsername,
        accountPassword: 'MySecretPassword123!',
        tags: ['vip', 'football']
      })
    });

    assert.strictEqual(createRes.status, 201, 'Should create betting account');
    const created = await createRes.json();
    assert.ok(created.id, 'Must return account ID');
    assert.strictEqual(created.accountUsername, testUsername);
    assert.strictEqual(created.accountPassword, '********', 'Password must be masked');

    // List accounts
    const listRes = await fetch(`${BASE_URL}/accounts?limit=10`, { headers: authHeaders });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData.viewportAccounts));
    assert.ok(listData.bulkCapabilities);
    assert.ok(listData.searchMetadata);

    // Single action: DEACTIVATE_ACCOUNT
    const actionRes = await fetch(`${BASE_URL}/accounts/${created.id}/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ type: 'DEACTIVATE_ACCOUNT' })
    });
    assert.strictEqual(actionRes.status, 200);
    const actionData = await actionRes.json();
    assert.strictEqual(actionData.success, true);
    assert.strictEqual(actionData.backendState, 'SUSPENDED');
  });

  // 2. Domain 1: Automation Engine & Tactical Operations
  await t.test('Domain 1: Automation Workspace Snapshot & Config', async () => {
    const snapRes = await fetch(`${BASE_URL}/automation/snapshot`, { headers: authHeaders });
    assert.strictEqual(snapRes.status, 200);
    const snapshot = await snapRes.json();
    assert.ok(snapshot.lifecycle);
    assert.ok(snapshot.capabilities);
    assert.ok(snapshot.globalConfig);
    assert.ok(snapshot.systemStatus);

    // Update global config
    const confRes = await fetch(`${BASE_URL}/automation/config/global/risk`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ maxStake: 15000 })
    });
    assert.strictEqual(confRes.status, 200);
    const confData = await confRes.json();
    assert.strictEqual(confData.globalConfig.risk.maxStake, 15000);

    // Start lifecycle
    const startRes = await fetch(`${BASE_URL}/automation/lifecycle/start`, {
      method: 'POST',
      headers: authHeaders
    });
    assert.strictEqual(startRes.status, 200);
    const startData = await startRes.json();
    assert.strictEqual(startData.lifecycle, 'RUNNING');

    // Stop lifecycle
    const stopRes = await fetch(`${BASE_URL}/automation/lifecycle/stop`, {
      method: 'POST',
      headers: authHeaders
    });
    assert.strictEqual(stopRes.status, 200);
    const stopData = await stopRes.json();
    assert.strictEqual(stopData.lifecycle, 'STOPPED');
  });

  // 3. Domain 3: Billing & Invoices
  await t.test('Domain 3: Billing Snapshot & Invoices', async () => {
    const billRes = await fetch(`${BASE_URL}/billing`, { headers: authHeaders });
    assert.strictEqual(billRes.status, 200);
    const billing = await billRes.json();
    assert.ok(billing.currentPlan);
    assert.ok(Array.isArray(billing.availableActions));
    assert.ok(Array.isArray(billing.invoices));
  });

  // 4. Domain 4: Operator Settings & Intent Pattern
  await t.test('Domain 4: Settings Snapshot & Intent processing', async () => {
    const setRes = await fetch(`${BASE_URL}/settings`, { headers: authHeaders });
    assert.strictEqual(setRes.status, 200);
    const settings = await setRes.json();
    assert.ok(settings.profile);
    assert.ok(settings.security);
    assert.ok(settings.automationPreferences);

    // Intent: UPDATE_PROFILE
    const intentRes = await fetch(`${BASE_URL}/settings/intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        type: 'UPDATE_PROFILE',
        payload: { name: 'Master Operator Alpha' }
      })
    });
    assert.strictEqual(intentRes.status, 200);
    const ack = await intentRes.json();
    assert.strictEqual(ack.status, 'ACCEPTED');
  });

  // 5. Domain 5: Notifications Hub
  await t.test('Domain 5: Notifications Ingestion, Reading, and Deletion', async () => {
    // Create notification
    const createRes = await fetch(`${BASE_URL}/notifications`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        severity: 'WARNING',
        category: 'AUTOMATION',
        title: 'Odds Divergence Alert',
        message: 'SportyBet odds shifted from 2.10 to 1.85',
        metadata: { matchId: '10924' }
      })
    });
    assert.strictEqual(createRes.status, 201);
    const notif = await createRes.json();
    assert.ok(notif.id);
    assert.strictEqual(notif.read, false);

    // Mark as read
    const readRes = await fetch(`${BASE_URL}/notifications/${notif.id}/read`, {
      method: 'PATCH',
      headers: authHeaders
    });
    assert.strictEqual(readRes.status, 200);

    // List notifications
    const listRes = await fetch(`${BASE_URL}/notifications`, { headers: authHeaders });
    assert.strictEqual(listRes.status, 200);
    const feed = await listRes.json();
    assert.ok(Array.isArray(feed.notifications));
  });

  // 6. Domain 6: System Updates
  await t.test('Domain 6: Version queries and Restart Intent', async () => {
    const verRes = await fetch(`${BASE_URL}/system/version`, { headers: authHeaders });
    assert.strictEqual(verRes.status, 200);
    const ver = await verRes.json();
    assert.strictEqual(ver.currentVersion, 'v0.1.0-alpha');
    assert.strictEqual(ver.availableVersion, 'v0.2.0');

    const restartRes = await fetch(`${BASE_URL}/system/restart-and-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        type: 'SYSTEM_RESTART_AND_UPDATE',
        targetVersion: 'v0.2.0',
        requestedAt: new Date().toISOString()
      })
    });
    assert.strictEqual(restartRes.status, 200);
    const restartData = await restartRes.json();
    assert.strictEqual(restartData.status, 'ACCEPTED');
  });

  // 7. Domain 7: Customer Care & Diagnostics
  await t.test('Domain 7: Support tickets & diagnostic reports', async () => {
    const snapRes = await fetch(`${BASE_URL}/support/snapshot`, { headers: authHeaders });
    assert.strictEqual(snapRes.status, 200);
    const snap = await snapRes.json();
    assert.ok(Array.isArray(snap.contactMethods));

    // Submit ticket
    const ticketRes = await fetch(`${BASE_URL}/support/tickets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        subject: 'Bookmaker login timeout',
        category: 'ACCOUNTS',
        message: 'SportyBet took > 15 seconds to solve captcha'
      })
    });
    assert.strictEqual(ticketRes.status, 201);
    const ticket = await ticketRes.json();
    assert.ok(ticket.ticketId);

    // Submit diagnostics
    const diagRes = await fetch(`${BASE_URL}/support/diagnostics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        telemetry: { memoryUsageMb: 240, cpuPercent: 12 },
        recentLogs: ['[Playwright] Launching browser instance 1', '[Engine] Navigating to login page']
      })
    });
    assert.strictEqual(diagRes.status, 200);
    const diag = await diagRes.json();
    assert.strictEqual(diag.status, 'RECEIVED');
  });

  // 8. WebSocket Stream Handshake on /ws/v1/events
  await t.test('WebSocket Real-Time Stream on /ws/v1/events', async () => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/v1/events?session=${testSessionId}`);

    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('WebSocket connection timed out'));
      }, 5000);

      ws.on('open', () => {
        // Send ping
        ws.send(JSON.stringify({ type: 'PING' }));
      });

      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString());
        if (msg.topic === 'app:state' && msg.payload?.state === 'Authorized') {
          clearTimeout(timeout);
          ws.close();
          resolve(true);
        }
      });

      ws.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  });
});

after(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM machines WHERE installation_id LIKE 'test-inst-domains%'");
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
});