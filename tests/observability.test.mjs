// @ts-check
import test from 'node:test';
import assert from 'node:assert/strict';
import { app } from '../src/server.mjs';
import { metrics } from '../src/utils/metrics.mjs';
import { getContext, runWithContext } from '../src/utils/context.mjs';

test('Observability Test Suite', async (t) => {
  let server;
  let baseUrl;

  t.before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve(null);
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('1. GET /health/live returns liveness and uptime', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.timestamp);
  });

  await t.test('2. GET /health/ready performs active database ping', async () => {
    const res = await fetch(`${baseUrl}/health/ready`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, 'ready');
    assert.equal(body.db.status, 'connected');
    assert.equal(typeof body.db.pingMs, 'number');
    assert.ok(body.db.totalConnections >= 0);
  });

  await t.test('3. Request Tracer assigns x-request-id header when none provided', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    const traceId = res.headers.get('x-request-id');
    assert.ok(traceId);
    assert.match(traceId, /^req-[0-9a-f-]+/);
  });

  await t.test('4. Request Tracer preserves caller x-request-id header', async () => {
    const customTraceId = 'custom-test-trace-999';
    const res = await fetch(`${baseUrl}/health/live`, {
      headers: {
        'x-request-id': customTraceId
      }
    });
    const traceId = res.headers.get('x-request-id');
    assert.equal(traceId, customTraceId);
  });

  await t.test('5. GET /metrics returns aggregated JSON snapshot', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.timestamp);
    assert.ok(body.httpRequests);
    assert.ok(typeof body.activeWsConnections, 'number');
  });

  await t.test('6. GET /metrics with text/plain accept header returns Prometheus format', async () => {
    const res = await fetch(`${baseUrl}/metrics`, {
      headers: {
        'Accept': 'text/plain'
      }
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(text.includes('# HELP http_requests_total'));
    assert.ok(text.includes('active_websocket_connections'));
  });

  await t.test('7. Error responses include requestId correlated to traceId', async () => {
    const customId = 'err-trace-corr-777';
    const res = await fetch(`${baseUrl}/api/v1/accounts`, {
      headers: {
        'x-request-id': customId
      }
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('x-request-id'), customId);
  });

  await t.test('8. AsyncLocalStorage context stores and updates correctly', async () => {
    const ctx = {
      traceId: 'unit-trace-1',
      startTime: 100,
      queryCount: 0,
      queryDurationMs: 0
    };

    runWithContext(ctx, () => {
      const active = getContext();
      assert.equal(active?.traceId, 'unit-trace-1');
    });

    assert.equal(getContext(), undefined);
  });
});
