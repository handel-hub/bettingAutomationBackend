// @ts-check
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { httpServer } from '../src/server.mjs';
import { getPool, closePool } from '../src/persistence/connection.mjs';
import { upsertSubscriptionPlan, deleteSubscriptionPlan } from '../src/domain/plans/service.mjs';

const PORT = process.env.PORT || 3001;
const BASE_URL = `http://localhost:${PORT}/api/v1`;

let testAccountId;
let testMachineId;
let testSessionId;
let testAdminSessionId;
let authHeaders = {};
let adminAuthHeaders = {};

before(async () => {
  if (!httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.listen(PORT, () => resolve(null));
    });
  }

  const pool = getPool();
  const accRes = await pool.query('SELECT account_id FROM accounts LIMIT 1');
  testAccountId = accRes.rows[0].account_id;
  const instId = `inst-contract-${Date.now()}`;
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

  const adminUserRes = await pool.query(`
    INSERT INTO admin_users (email, credentials_hash, role, mfa_secret, status)
    VALUES ($1, 'dummy_hash', 'SUPER_ADMIN', 'JBSWY3DPEHPK3PXP', 'ACTIVE')
    ON CONFLICT (email) DO UPDATE SET role = 'SUPER_ADMIN', status = 'ACTIVE'
    RETURNING admin_id
  `, [`contract_admin_${Date.now()}@bettingautomation.com`]);
  const adminSessRes = await pool.query(`
    INSERT INTO admin_sessions (admin_id, expires_at)
    VALUES ($1, now() + interval '8 hours')
    RETURNING session_id
  `, [adminUserRes.rows[0].admin_id]);
  testAdminSessionId = adminSessRes.rows[0].session_id;

  authHeaders = {
    'Authorization': `Bearer ${testSessionId}`,
    'Content-Type': 'application/json'
  };
  adminAuthHeaders = {
    'Authorization': `Bearer ${testAdminSessionId}`,
    'Content-Type': 'application/json'
  };
});

test('Target Architecture & Contract Specification Conformance Suite', async (t) => {

  // 1. Subscription Plans Catalog (CNT-BILL-PLANS-01)
  await t.test('1. GET /api/v1/billing/plans: Dynamic Server-Driven Plans Catalog', async () => {
    const res = await fetch(`${BASE_URL}/billing/plans`);
    assert.strictEqual(res.status, 200, 'Plans catalog must return 200 OK');
    const catalog = await res.json();

    assert.ok(Array.isArray(catalog.plans), 'Must return plans array');
    assert.ok(catalog.plans.length >= 3, 'Must contain at least starter, pro, elite plans');
    assert.ok(catalog.defaultPlanId, 'Must define a default plan ID');
    assert.strictEqual(catalog.currency, 'NGN');
    assert.strictEqual(catalog.currencySymbol, '₦');

    const proPlan = catalog.plans.find(p => p.id === 'pro');
    assert.ok(proPlan, 'Pro plan must exist');
    assert.strictEqual(typeof proPlan.monthlyPrice, 'number');
    assert.strictEqual(typeof proPlan.annualPrice, 'number');
    assert.ok(proPlan.name);
    assert.ok(proPlan.tagline);
    assert.ok(proPlan.description);
    assert.ok(Array.isArray(proPlan.features), 'Plan features must be array');
    assert.ok(Array.isArray(proPlan.availableBillingIntervals));
  });

  // 2. 12-Point Backend Flexibility Verification (§16.3 / TEST-RES-01, TEST-RES-02)
  await t.test('2. 12-Point Backend Flexibility: Modify plans without frontend code deployments', async () => {
    const testPlanId = `test_plan_${Date.now()}`;
    await upsertSubscriptionPlan({
      planId: testPlanId,
      name: 'Custom Whale Tier',
      tagline: 'Engineered for high-roller syndicates',
      description: 'Zero-latency dedicated cluster with unlimited bookmakers',
      monthlyPrice: 150000,
      annualPrice: 1500000,
      currency: 'NGN',
      currencySymbol: '₦',
      annualDiscountPercent: 16.67,
      isPopular: false,
      isActive: true,
      sortOrder: 99,
      features: ['Unlimited Machine Clusters', 'Dedicated Proxy Subnets', '24/7 Phone SLA'],
      entitlements: { maxMachines: 50, maxConcurrentBrowsers: 50, riskTier: 'CUSTOM' }
    });

    // Verify change immediately reflected via API
    const res = await fetch(`${BASE_URL}/billing/plans`);
    const catalog = await res.json();
    const createdPlan = catalog.plans.find(p => p.id === testPlanId);
    assert.ok(createdPlan, 'New plan must immediately manifest in API catalog');
    assert.strictEqual(createdPlan.name, 'Custom Whale Tier');
    assert.strictEqual(createdPlan.monthlyPrice, 150000);
    assert.strictEqual(createdPlan.features.length, 3);

    // Cleanup test plan
    await deleteSubscriptionPlan(testPlanId);
    const cleanupRes = await fetch(`${BASE_URL}/billing/plans`);
    const cleanupCatalog = await cleanupRes.json();
    assert.strictEqual(cleanupCatalog.plans.find(p => p.id === testPlanId), undefined, 'Plan successfully deactivated');
  });

  // 3. Dynamic Platform Registry & Unrestricted Bookmaker Validation (CNT-PLAT-REG-01, TEST-RES-04)
  await t.test('3. Platform Registry: Dynamic bookmaker addition without enum schema lock', async () => {
    // List platforms
    const listRes = await fetch(`${BASE_URL}/platforms`, { headers: authHeaders });
    assert.strictEqual(listRes.status, 200);
    const platformsData = await listRes.json();
    assert.ok(Array.isArray(platformsData.platforms), 'Must return platforms list');
    assert.ok(platformsData.totalCount >= 7, 'Must have at least initial seeded bookmakers');

    // Dynamically register a new platform (Admin only)
    const newPlatformKey = `newbookie_${Date.now()}`;
    const regRes = await fetch(`${BASE_URL}/platforms`, {
      method: 'POST',
      headers: adminAuthHeaders,
      body: JSON.stringify({
        platformKey: newPlatformKey,
        displayName: 'Betland International',
        category: 'EU_RECREATIONAL',
        supportedFeatures: ['LIVE_ODDS', 'AUTOMATED_BETTING', 'CASHOUT']
      })
    });
    assert.strictEqual(regRes.status, 201, 'Should register new platform');
    const registered = await regRes.json();
    assert.strictEqual(registered.displayName, 'Betland International');

    // Create a betting account using this newly registered bookmaker
    const accRes = await fetch(`${BASE_URL}/accounts`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        name: 'Betland Main Account',
        platformDisplayName: 'Betland International',
        accountUsername: `user_${Date.now()}`,
        accountPassword: 'Password123!',
        tags: ['arbitrage', 'dynamic']
      })
    });
    assert.strictEqual(accRes.status, 201, 'Should create account on new bookmaker without database constraint rejection');
    const acc = await accRes.json();
    assert.strictEqual(acc.platformDisplayName, 'Betland International');
  });

  // 4. Dynamic Customer Care Support Channels (TEST-RES-06)
  await t.test('4. Support Channels: Dynamic server-driven contact methods', async () => {
    const snapRes = await fetch(`${BASE_URL}/support/snapshot`, { headers: authHeaders });
    assert.strictEqual(snapRes.status, 200);
    const snapshot = await snapRes.json();
    assert.ok(Array.isArray(snapshot.contactMethods), 'Must have contactMethods array');
    assert.ok(snapshot.contactMethods.length >= 2);

    // Add a new dynamic support channel via admin/ops API
    const testChannelId = `chan_${Date.now()}`;
    const addRes = await fetch(`${BASE_URL}/support/channels`, {
      method: 'POST',
      headers: adminAuthHeaders,
      body: JSON.stringify({
        id: testChannelId,
        title: 'VIP Dedicated WhatsApp Line',
        description: 'Instant response escalation hotline for high-volume operators',
        actionType: 'EXTERNAL_LINK',
        actionTarget: 'https://wa.me/2348000000000',
        icon: 'phone',
        isAvailable: true,
        sortOrder: 4
      })
    });
    assert.strictEqual(addRes.status, 201);

    // Verify instant reflection in support snapshot
    const updatedSnapRes = await fetch(`${BASE_URL}/support/snapshot`, { headers: authHeaders });
    const updatedSnapshot = await updatedSnapRes.json();
    const foundChannel = updatedSnapshot.contactMethods.find(c => c.id === testChannelId);
    assert.ok(foundChannel, 'Newly added channel must immediately appear in getCustomerCareSnapshot');
    assert.strictEqual(foundChannel.title, 'VIP Dedicated WhatsApp Line');
    assert.strictEqual(foundChannel.icon, 'phone');
  });

  // 5. Statutory VAT Math & Fiscal Invoicing Contract
  await t.test('5. Billing & Invoices: Statutory 7.5% VAT math and currency breakdown', async () => {
    const billRes = await fetch(`${BASE_URL}/billing`, { headers: authHeaders });
    assert.strictEqual(billRes.status, 200);
    const billing = await billRes.json();

    assert.ok(billing.currentPlan);
    assert.strictEqual(billing.currency, 'NGN');
    assert.strictEqual(billing.currencySymbol, '₦');
    assert.ok(Array.isArray(billing.invoices));

    if (billing.invoices.length > 0) {
      const inv = billing.invoices[0];
      assert.strictEqual(typeof inv.amount, 'number');
      assert.strictEqual(typeof inv.subtotal, 'number');
      assert.strictEqual(typeof inv.taxAmount, 'number');
      assert.strictEqual(inv.taxRate, 0.075);
      assert.strictEqual(inv.currencySymbol, '₦');
      // Subtotal + Tax = Gross (within 1 kobo rounding)
      assert.ok(Math.abs((inv.subtotal + inv.taxAmount) - inv.amount) <= 0.05, 'Subtotal + tax must match gross total');
    }
  });

  // 6. Unified Checkout Contract (Section 8.1 #13 / INT-BILL-CHK-01)
  await t.test('6. POST /api/v1/billing/checkout: Structured contract response with dynamic pricing', async () => {
    // 6a. Rejects missing Idempotency-Key with 400 BE_VALIDATION_MISSING_IDEMPOTENCY_KEY
    const rejectRes = await fetch(`${BASE_URL}/billing/checkout`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        planId: 'starter',
        billingInterval: 'annual'
      })
    });
    assert.strictEqual(rejectRes.status, 400);
    const rejectData = await rejectRes.json();
    assert.strictEqual(rejectData.code, 'BE_VALIDATION_MISSING_IDEMPOTENCY_KEY');

    // 6b. Accepts valid Idempotency-Key and returns contract payload
    const chkRes = await fetch(`${BASE_URL}/billing/checkout`, {
      method: 'POST',
      headers: {
        ...authHeaders,
        'Idempotency-Key': `chk-conf-${Date.now()}`
      },
      body: JSON.stringify({
        planId: 'starter',
        billingInterval: 'annual'
      })
    });
    assert.strictEqual(chkRes.status, 200);
    const data = await chkRes.json();

    assert.ok(data.checkoutUrl, 'Must return checkoutUrl');
    assert.ok(data.reference, 'Must return transaction reference');
    assert.strictEqual(data.planName, 'Starter');
    assert.strictEqual(data.billingInterval, 'annual');
    assert.strictEqual(data.currency, 'NGN');
    assert.strictEqual(data.currencySymbol, '₦');
    assert.strictEqual(data.amount, 48000, 'Starter annual price must be ₦48,000');
  });

  // 7. Telemetry Ingestion (UP-ACP-AUDIT-LOG & UP-ACP-HEARTBEAT)
  await t.test('7. Telemetry Ingestion: UP-ACP-AUDIT-LOG and UP-ACP-HEARTBEAT', async () => {
    // Record Arbitrage Audit
    const auditRes = await fetch(`${BASE_URL}/telemetry/audit`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        machineId: testMachineId,
        eventType: 'ARB_OPPORTUNITY_DETECTED',
        severity: 'INFO',
        payload: {
          match: 'Arsenal vs Chelsea',
          sport: 'Football',
          profitMargin: 3.45,
          bookmakers: ['SportyBet', 'Bet9ja']
        }
      })
    });
    assert.strictEqual(auditRes.status, 201);
    const auditData = await auditRes.json();
    assert.ok(auditData.id);
    assert.strictEqual(auditData.eventType, 'ARB_OPPORTUNITY_DETECTED');

    // Query Audit Telemetry
    const queryRes = await fetch(`${BASE_URL}/telemetry/audit?eventType=ARB_OPPORTUNITY_DETECTED`, {
      headers: authHeaders
    });
    assert.strictEqual(queryRes.status, 200);
    const list = await queryRes.json();
    assert.ok(Array.isArray(list));
    assert.ok(list.some(a => a.id === auditData.id));

    // Record ACP Heartbeat
    const hbRes = await fetch(`${BASE_URL}/telemetry/heartbeat`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        machineId: testMachineId,
        telemetry: {
          cpuLoadPercent: 12.5,
          memoryMb: 1024,
          activeWorkers: 4,
          oddsPollerHealthy: true
        },
        recentLogs: ['[INFO] Odds poller connected', '[INFO] Zero drift detected']
      })
    });
    assert.strictEqual(hbRes.status, 200);
    const hbData = await hbRes.json();
    assert.strictEqual(hbData.status, 'RECORDED');
  });

  // 8. Prelude Composite Aggregator (CNT-PRELUDE-01)
  await t.test('8. GET /api/v1/prelude: Initial composite business state aggregation in single round-trip', async () => {
    const preRes = await fetch(`${BASE_URL}/prelude`, { headers: authHeaders });
    assert.strictEqual(preRes.status, 200);
    const prelude = await preRes.json();

    assert.ok(prelude.account, 'Must include account object');
    assert.strictEqual(prelude.account.id, testAccountId);
    assert.ok(prelude.billing, 'Must include billing snapshot');
    assert.ok(prelude.billing.currentPlan);
    assert.ok(prelude.platforms, 'Must include platform registry');
    assert.ok(Array.isArray(prelude.platforms.platforms));
    assert.ok(prelude.support, 'Must include customer care snapshot');
    assert.ok(Array.isArray(prelude.support.contactMethods));
    assert.ok(prelude.automation, 'Must include automation workspace snapshot');
    assert.ok(prelude.timestamp);
  });

  // 9. Rich Account Actions Contract (§7 & §8.1)
  await t.test('9. Betting Accounts: Server-driven rich action contracts', async () => {
    const listRes = await fetch(`${BASE_URL}/accounts?limit=1`, { headers: authHeaders });
    assert.strictEqual(listRes.status, 200);
    const listData = await listRes.json();
    assert.ok(Array.isArray(listData.viewportAccounts));

    if (listData.viewportAccounts.length > 0) {
      const acc = listData.viewportAccounts[0];
      assert.ok(Array.isArray(acc.availableActions), 'availableActions must be array');
      const firstAction = acc.availableActions[0];
      assert.ok(firstAction.id, 'Action must have id');
      assert.ok(firstAction.label, 'Action must have server-driven label');
      assert.ok(firstAction.icon, 'Action must have icon');
      assert.strictEqual(typeof firstAction.disabled, 'boolean');
      assert.ok(firstAction.variant, 'Action must have variant');
    }
  });

  // 10. CORS Policy Enforcement
  await t.test('10. CORS Policy: Permits allowed console origin and rejects unauthorized origins', async () => {
    // 10a. Allowed origin permits preflight and access
    const allowedRes = await fetch(`${BASE_URL}/platforms`, {
      headers: {
        ...authHeaders,
        'Origin': 'https://console.bettingautomation.io'
      }
    });
    assert.strictEqual(allowedRes.status, 200);
    assert.strictEqual(allowedRes.headers.get('access-control-allow-origin'), 'https://console.bettingautomation.io');

    // 10b. Unauthorized foreign origin rejected with 403 BE_AUTH_CORS_ORIGIN_DENIED
    const deniedRes = await fetch(`${BASE_URL}/platforms`, {
      headers: {
        ...authHeaders,
        'Origin': 'https://malicious-phishing-site.com'
      }
    });
    assert.strictEqual(deniedRes.status, 403);
    const deniedData = await deniedRes.json();
    assert.strictEqual(deniedData.error.code, 'BE_AUTH_CORS_ORIGIN_DENIED');
  });

  // 11. Security Hardening: Payment Amount Verification against Plan Pricing (Flaw 3)
  await t.test('11. Security Hardening: POST /api/v1/billing/checkout/verify rejects insufficient payment amount', async () => {
    const { getProvider, setProvider } = await import('../src/domain/payment/provider.mjs');
    const originalProvider = getProvider();

    // 11a. Reject insufficient amount (₦10,000 for ₦25,000 Elite plan)
    setProvider({
      ...originalProvider,
      async verifyTransaction(ref) {
        return {
          status: 'success',
          data: {
            id: ref,
            status: 'successful',
            amount: 10000,
            currency: 'NGN'
          }
        };
      }
    });

    try {
      const spoofRes = await fetch(`${BASE_URL}/billing/checkout/verify`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          reference: `test_ref_spoof_${Date.now()}`,
          planId: 'elite',
          billingInterval: 'monthly'
        })
      });
      assert.strictEqual(spoofRes.status, 400);
      const spoofData = await spoofRes.json();
      assert.strictEqual(spoofData.verified, false);
      assert.ok(spoofData.error.includes('insufficient for requested plan'));
    } finally {
      setProvider(originalProvider);
    }

    // 11b. Accept sufficient amount (₦25,000 for ₦25,000 Elite plan)
    setProvider({
      ...originalProvider,
      async verifyTransaction(ref) {
        return {
          status: 'success',
          data: {
            id: ref,
            status: 'successful',
            amount: 25000,
            currency: 'NGN'
          }
        };
      }
    });

    try {
      const validRes = await fetch(`${BASE_URL}/billing/checkout/verify`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          reference: `test_ref_valid_${Date.now()}`,
          planId: 'elite',
          billingInterval: 'monthly'
        })
      });
      assert.strictEqual(validRes.status, 200);
      const validData = await validRes.json();
      assert.strictEqual(validData.verified, true);
      assert.strictEqual(validData.status, 'Authorized');
    } finally {
      setProvider(originalProvider);
    }
  });

  // 12. Security Hardening: Cross-Tenant WebSocket Broadcast Isolation (Flaw 4)
  await t.test('12. Security Hardening: Broadcast with targetAccountId isolates events to intended tenant', async () => {
    const { broadcast } = await import('../src/websocket/server.mjs');
    const { WebSocket } = await import('ws');

    const ws = new WebSocket(`ws://localhost:${PORT}/ws/v1/events?session=${testSessionId}`);
    
    // Wait for the server to finish authenticating and sending initial app:state handshake
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket handshake timeout')), 3000);
      ws.on('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.eventType === 'app:state' || parsed.topic === 'app:state') {
            clearTimeout(timer);
            resolve(null);
          }
        } catch {}
      });
      ws.on('error', reject);
    });

    const receivedOtherTenant = [];
    const receivedMatchingTenant = [];

    ws.on('message', (data) => {
      try {
        const evt = JSON.parse(data.toString());
        if (evt.topic === 'test:foreign_tenant') {
          receivedOtherTenant.push(evt);
        }
        if (evt.topic === 'test:own_tenant') {
          receivedMatchingTenant.push(evt);
        }
      } catch {}
    });

    // Broadcast targeted to a different account ID
    broadcast('test:foreign_tenant', { secret: 'cross-tenant-leak' }, 'different-account-uuid');
    
    // Broadcast targeted to the connected testAccountId
    broadcast('test:own_tenant', { data: 'my-own-event' }, testAccountId);

    // Wait a brief tick for socket delivery
    await new Promise((r) => setTimeout(r, 200));

    ws.close();

    assert.strictEqual(receivedOtherTenant.length, 0, 'Must NOT receive events targeted to other accounts');
    assert.strictEqual(receivedMatchingTenant.length, 1, 'Must receive events targeted to own account');
  });

  // 13. Security Hardening: Cross-Site WebSocket Hijacking (CSWSH) Origin Validation (Flaw 5)
  await t.test('13. Security Hardening: WebSocket rejects unauthorized foreign Origin during handshake', async () => {
    const { WebSocket } = await import('ws');

    // Attempt connection from disallowed attacker origin
    const attackerWs = new WebSocket(`ws://localhost:${PORT}/ws/v1/events?session=${testSessionId}`, {
      headers: {
        'Origin': 'https://attacker-cswsh.com'
      }
    });

    const wasRejected = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try { attackerWs.terminate(); } catch {}
        resolve(false);
      }, 3000);

      attackerWs.on('error', () => {
        clearTimeout(timer);
        resolve(true);
      });
      attackerWs.on('unexpected-response', (req, res) => {
        clearTimeout(timer);
        resolve(res.statusCode === 403);
      });
    });

    assert.strictEqual(wasRejected, true, 'WebSocket connection from unauthorized origin must be rejected with 403');
  });
});

after(async () => {
  const pool = getPool();
  await pool.query("DELETE FROM betting_accounts WHERE platform_display_name = 'Betland International'");
  await pool.query("DELETE FROM platform_registry WHERE id LIKE 'newbookie_%'");
  await pool.query("DELETE FROM support_channels WHERE id LIKE 'chan_%'");
  await pool.query("DELETE FROM machines WHERE installation_id LIKE 'inst-contract%'");
  if (httpServer.listening) {
    if (typeof httpServer.closeAllConnections === 'function') {
      httpServer.closeAllConnections();
    }
    await new Promise((resolve) => httpServer.close(resolve));
  }
  await closePool();
});
