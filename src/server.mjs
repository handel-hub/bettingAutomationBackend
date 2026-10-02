// @ts-check
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import http from 'http';
import { performance } from 'node:perf_hooks';
import { loadConfig } from './config/index.mjs';
import { errorHandler } from './api/middleware/error-handler.mjs';
import { requestTracer } from './api/middleware/request-tracer.mjs';
import { rootLogger } from './utils/Logger.mjs';
import { metrics } from './utils/metrics.mjs';

import paymentRouter from './api/routes/payments.mjs';
import authRouter from './api/routes/auth.mjs';
import machineRouter from './api/routes/machines.mjs';
import sessionRouter from './api/routes/sessions.mjs';
import authorizationRouter from './api/routes/authorization.mjs';
import reconciliationRouter from './api/routes/reconciliation.mjs';
// FTS Quarantined: import transferRouter from './api/routes/transfers.mjs';
import adminRouter from './admin/routes.mjs';
import { initializePaymentAdapter } from './adapters/payment/adapter.mjs';

// Domain V1 Routers for Betting Automation Control Plane & Cloud
import accountsRouter from './api/routes/accounts.mjs';
import automationRouter from './api/routes/automation.mjs';
import billingRouter from './api/routes/billing.mjs';
import settingsRouter from './api/routes/settings.mjs';
import notificationsRouter from './api/routes/notifications.mjs';
import systemRouter from './api/routes/system.mjs';
import supportRouter from './api/routes/support.mjs';
import platformsRouter from './api/routes/platforms.mjs';
import telemetryRouter from './api/routes/telemetry.mjs';
import preludeRouter from './api/routes/prelude.mjs';
import { initWebSocketServer, closeWebSocketServer } from './websocket/server.mjs';
import { startWorker, stopWorker } from './outbox/worker.mjs';
import { initializeJobs } from './jobs/index.mjs';
import { stopScheduler } from './jobs/scheduler.mjs';
import { bootstrapDevAccounts } from './persistence/bootstrap.mjs';
import { closePool } from './persistence/connection.mjs';
import { isOriginAllowed } from './utils/cors.mjs';

const app = express();
const sysLogger = rootLogger.child({ component: 'Server' });

app.use(requestTracer);
app.use(helmet());

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      return callback(null, true);
    }
    const err = new Error('CORS_ORIGIN_DENIED');
    // @ts-ignore
    err.status = 403;
    return callback(err);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'Idempotency-Key',
    'x-session-id',
    'x-machine-id',
    'If-None-Match',
    'x-idempotency-key'
  ]
}));

app.use(express.json({
  verify: (req, res, buf) => {
    // @ts-ignore
    req.rawBody = buf;
  }
}));

// Protocol & Authority Mounts (supporting both /api/v1/... and /...)
app.use('/auth', authRouter);
app.use('/api/v1/auth', authRouter);
app.use('/machines', machineRouter);
app.use('/api/v1/machines', machineRouter);
app.use('/sessions', sessionRouter);
app.use('/api/v1/sessions', sessionRouter);
app.use('/authorization', authorizationRouter);
app.use('/api/v1/authorization', authorizationRouter);
app.use('/reconciliation', reconciliationRouter);
app.use('/api/v1/reconciliation', reconciliationRouter);
// FTS Quarantined: app.use('/transfers', transferRouter);
// FTS Quarantined: app.use('/api/v1/transfers', transferRouter);
app.use('/payments', paymentRouter);
app.use('/api/v1/payments', paymentRouter);
app.use('/api/payments', paymentRouter);
app.use('/admin', adminRouter);
app.use('/api/v1/admin', adminRouter);

// Domain 1-7 & Target Unified /api/v1 and root Mounts
app.use('/api/v1/accounts', accountsRouter);
app.use('/accounts', accountsRouter);
app.use('/api/v1/automation', automationRouter);
app.use('/automation', automationRouter);
app.use('/api/v1/billing', billingRouter);
app.use('/billing', billingRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/settings', settingsRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/notifications', notificationsRouter);
app.use('/api/v1/system', systemRouter);
app.use('/system', systemRouter);
app.use('/api/v1/support', supportRouter);
app.use('/support', supportRouter);
app.use('/api/v1/platforms', platformsRouter);
app.use('/platforms', platformsRouter);
app.use('/api/v1/telemetry', telemetryRouter);
app.use('/telemetry', telemetryRouter);
app.use('/api/v1/prelude', preludeRouter);
app.use('/prelude', preludeRouter);

// Deep Health & Metrics Endpoints
app.get('/health/live', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime())
  });
});

app.get('/health/ready', async (req, res) => {
  try {
    const { getPool } = await import('./persistence/connection.mjs');
    const pool = getPool();
    const start = performance.now();
    await pool.query('SELECT 1');
    const dbPingMs = performance.now() - start;

    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      db: {
        status: 'connected',
        pingMs: Math.round(dbPingMs * 100) / 100,
        totalConnections: pool.totalCount,
        idleConnections: pool.idleCount,
        waitingClients: pool.waitingCount
      }
    });
  } catch (err) {
    sysLogger.error({ event: 'readiness_check_failed', err }, 'Readiness check failed');
    res.status(503).json({
      status: 'unhealthy',
      error: 'Database connection failed',
      timestamp: new Date().toISOString()
    });
  }
});

app.get('/metrics', (req, res) => {
  if (req.headers['accept']?.includes('text/plain')) {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4');
    return res.send(metrics.getPrometheusFormat());
  }
  res.json(metrics.getSnapshot());
});

app.use(errorHandler);

const config = loadConfig();
const port = config.PORT || 3001;

initializePaymentAdapter(config.PAYMENT_PROVIDER, config);

// Create HTTP server to attach both Express and WebSocket
export const httpServer = http.createServer(app);
initWebSocketServer(httpServer);

// Graceful shutdown logic
let isShuttingDown = false;
export async function gracefulShutdown(signal = 'SIGTERM') {
  if (isShuttingDown) return;
  isShuttingDown = true;
  sysLogger.info({ event: 'shutdown_initiated', signal }, `Received ${signal}, initiating graceful shutdown`);

  // 1. Stop background workers
  try {
    stopWorker();
    stopScheduler();
  } catch (err) {
    sysLogger.error({ event: 'shutdown_worker_error', err }, 'Error stopping workers during shutdown');
  }

  // 2. Close WebSockets
  try {
    closeWebSocketServer();
  } catch (err) {
    sysLogger.error({ event: 'shutdown_ws_error', err }, 'Error closing WebSocket server');
  }

  // 3. Close HTTP server
  if (httpServer.listening) {
    await new Promise((resolve) => httpServer.close(resolve));
    sysLogger.info({ event: 'http_server_closed' }, 'HTTP server stopped accepting connections');
  }

  // 4. Close database pool
  try {
    await closePool();
    sysLogger.info({ event: 'db_pool_closed' }, 'PostgreSQL connection pool closed');
  } catch (err) {
    sysLogger.error({ event: 'shutdown_db_error', err }, 'Error closing database pool');
  }

  sysLogger.info({ event: 'shutdown_completed' }, 'Graceful shutdown completed successfully');
}

// Only register signal handlers if running directly in node process
if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  httpServer.listen(port, async () => {
    sysLogger.info({ event: 'server_started', port, env: config.NODE_ENV }, `Backend server listening on port ${port}`);
    
    // Auto-bootstrap default developer accounts idempotently if running in development mode
    if (config.NODE_ENV === 'development') {
      await bootstrapDevAccounts();
    }

    // Start background processes
    startWorker();
    initializeJobs();
  });
}

export { app };
